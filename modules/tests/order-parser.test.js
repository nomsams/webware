// Run: node --test modules/tests/order-parser.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrderRequest, parseJsonReply, looksLikeBtk, matchKnownItem, bestCandidateMatch, guessAddressLine,
} from '../order-parser.js';

const KNOWN_ITEMS = [
  { btk: 'BTK000001', name: 'Widget A' },
  { btk: 'BTK000002', name: 'Widget B' },
];

test('looksLikeBtk matches the BTK shape only', () => {
  assert.equal(looksLikeBtk('BTK000012'), true);
  assert.equal(looksLikeBtk('btk000012'), true);
  assert.equal(looksLikeBtk('BTK12'), false);
  assert.equal(looksLikeBtk('Widget A'), false);
});

test('matchKnownItem resolves ordinals, BTKs, and names case-insensitively', () => {
  assert.equal(matchKnownItem('item 2', KNOWN_ITEMS).btk, 'BTK000002');
  assert.equal(matchKnownItem('1', KNOWN_ITEMS).btk, 'BTK000001');
  assert.equal(matchKnownItem('btk000002', KNOWN_ITEMS).btk, 'BTK000002');
  assert.equal(matchKnownItem('widget a', KNOWN_ITEMS).btk, 'BTK000001');
  assert.equal(matchKnownItem('nonexistent', KNOWN_ITEMS), null);
  assert.equal(matchKnownItem('item 99', KNOWN_ITEMS), null);
});

test('bestCandidateMatch short-circuits on an exact BTK match', () => {
  const candidates = [{ btk: 'BTK000005', name: 'Something else' }, { btk: 'BTK000009', name: 'Blue Widget' }];
  assert.equal(bestCandidateMatch('BTK000009', candidates).name, 'Blue Widget');
});

test('bestCandidateMatch picks the closer name by word overlap, and ignores weak matches', () => {
  const candidates = [{ btk: 'BTK000010', name: 'Red Bolt 10mm' }, { btk: 'BTK000011', name: 'Blue Widget Large' }];
  assert.equal(bestCandidateMatch('blue widget', candidates).btk, 'BTK000011');
  assert.equal(bestCandidateMatch('completely unrelated text', candidates), null);
});

test('bestCandidateMatch returns null with no candidates', () => {
  assert.equal(bestCandidateMatch('anything', []), null);
  assert.equal(bestCandidateMatch('anything', null), null);
});

test('parseJsonReply extracts JSON even when wrapped in prose or code fences', () => {
  const wrapped = 'Sure, here you go:\n```json\n{"items":[{"reference":"1","quantity":2}]}\n```';
  assert.deepEqual(parseJsonReply(wrapped), { items: [{ reference: '1', quantity: 2 }] });
});

test('parseJsonReply throws when there is no JSON at all', () => {
  assert.throws(() => parseJsonReply('sorry, I cannot help with that'), /did not contain JSON/);
});

test('parseJsonReply throws when items is missing', () => {
  assert.throws(() => parseJsonReply('{"recipientName":"Acme"}'), /missing items array/);
});

test('guessAddressLine finds a postal-code-shaped line, ignoring long paragraphs', () => {
  const text = 'Welcome to Acme AB\nWe make widgets since 1990.\n123 45 Stockholm\nContact us anytime.';
  assert.equal(guessAddressLine(text), '123 45 Stockholm');
});

test('guessAddressLine returns null when nothing matches', () => {
  assert.equal(guessAddressLine('no postal codes here at all'), null);
});

test('parseOrderRequest resolves item ordinals, defaults quantity to 1, and skips lookup when no address tools are given', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'item 1' }, { reference: 'item 2', quantity: 3 }],
      recipientName: 'Acme AB',
      recipientAddressHint: null,
      needsAddressLookup: true,
    }),
  };

  const draft = await parseOrderRequest(fakeGroq, 'plocka item 1 och item 2 x3 till Acme AB', { knownItems: KNOWN_ITEMS });

  assert.deepEqual(draft.items, [
    { reference: 'item 1', quantity: 1, btk: 'BTK000001', matchedName: 'Widget A' },
    { reference: 'item 2', quantity: 3, btk: 'BTK000002', matchedName: 'Widget B' },
  ]);
  assert.equal(draft.recipient.name, 'Acme AB');
  assert.equal(draft.recipient.address, null);
  assert.equal(draft.recipient.confidence, 'unknown');
  assert.equal(draft.from, null);
});

test('parseOrderRequest falls back to searchItemCandidates when a reference is not in knownItems', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'blue widget', quantity: 2 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  let searchedWith = null;
  const searchItemCandidates = async (text) => {
    searchedWith = text;
    return [{ btk: 'BTK000099', name: 'Blue Widget Large' }, { btk: 'BTK000100', name: 'Red Bolt' }];
  };

  const draft = await parseOrderRequest(fakeGroq, 'plocka en blue widget', { knownItems: [], searchItemCandidates });

  assert.equal(searchedWith, 'blue widget');
  assert.deepEqual(draft.items, [{ reference: 'blue widget', quantity: 2, btk: 'BTK000099', matchedName: 'Blue Widget Large' }]);
});

test('parseOrderRequest leaves an item unresolved when search finds nothing close enough', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'some obscure thing', quantity: 1 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  const searchItemCandidates = async () => [{ btk: 'BTK000001', name: 'Widget A' }];

  const draft = await parseOrderRequest(fakeGroq, 'plocka some obscure thing', { searchItemCandidates });

  assert.equal(draft.items[0].btk, null);
  assert.equal(draft.items[0].matchedName, null);
});

test('parseOrderRequest does not call searchItemCandidates when a reference already matched knownItems or looks like a BTK', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'item 1', quantity: 1 }, { reference: 'BTK000042', quantity: 1 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  let searchCalled = false;
  const searchItemCandidates = async () => { searchCalled = true; return []; };

  const draft = await parseOrderRequest(fakeGroq, 'plocka item 1 och BTK000042', { knownItems: KNOWN_ITEMS, searchItemCandidates });

  assert.equal(searchCalled, false);
  assert.equal(draft.items[0].btk, 'BTK000001');
  assert.equal(draft.items[1].btk, 'BTK000042');
});

test('parseOrderRequest passes fromAddress straight through without touching it', async () => {
  const fakeGroq = { chat: async () => JSON.stringify({ items: [], recipientName: null, recipientAddressHint: null, needsAddressLookup: false }) };
  const fromAddress = { name: 'Warehouse 1', address: 'Lagervägen 1, 123 45 Stockholm' };

  const draft = await parseOrderRequest(fakeGroq, 'plocka ingenting', { fromAddress });

  assert.deepEqual(draft.from, fromAddress);
});

test('parseOrderRequest uses the given address hint without triggering a search', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'BTK000002', quantity: 1 }],
      recipientName: 'Jane Doe',
      recipientAddressHint: '123 45 Stockholm',
      needsAddressLookup: false,
    }),
  };
  let searchCalled = false;
  const webSearch = async () => { searchCalled = true; return []; };

  const draft = await parseOrderRequest(fakeGroq, 'pack BTK000002 for Jane Doe at 123 45 Stockholm', {
    knownItems: KNOWN_ITEMS, webSearch, fetchPageText: async () => '',
  });

  assert.equal(draft.recipient.address, '123 45 Stockholm');
  assert.equal(draft.recipient.confidence, 'given');
  assert.equal(searchCalled, false);
});

test('parseOrderRequest searches for an address when the model asks for one and tools are provided', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'BTK000001', quantity: 1 }],
      recipientName: 'Acme AB',
      recipientAddressHint: null,
      needsAddressLookup: true,
    }),
  };
  const webSearch = async (query) => {
    assert.match(query, /Acme AB/);
    return [{ title: 'Acme AB', url: 'https://acme.example/contact', snippet: '' }];
  };
  const fetchPageText = async (url) => {
    assert.equal(url, 'https://acme.example/contact');
    return 'Acme AB head office\n123 45 Stockholm\nPhone: 08-1234567';
  };

  const draft = await parseOrderRequest(fakeGroq, 'plocka BTK000001 till Acme AB, sök upp adressen', {
    knownItems: KNOWN_ITEMS, webSearch, fetchPageText,
  });

  assert.equal(draft.recipient.address, '123 45 Stockholm');
  assert.equal(draft.recipient.confidence, 'searched');
});

test('parseOrderRequest marks not_found when the search never turns up an address', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [],
      recipientName: 'Ghost Corp',
      recipientAddressHint: null,
      needsAddressLookup: true,
    }),
  };
  const webSearch = async () => [{ title: 'Ghost Corp', url: 'https://ghost.example', snippet: '' }];
  const fetchPageText = async () => 'nothing address-shaped in here';

  const draft = await parseOrderRequest(fakeGroq, 'find Ghost Corp address', {
    webSearch, fetchPageText,
  });

  assert.equal(draft.recipient.address, null);
  assert.equal(draft.recipient.confidence, 'not_found');
});

test('parseOrderRequest requires non-empty text', async () => {
  await assert.rejects(parseOrderRequest({ chat: async () => '{}' }, '   '), /text is required/);
});
