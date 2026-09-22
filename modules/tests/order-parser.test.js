// Run: node --test modules/tests/order-parser.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOrderRequest, parseJsonReply, looksLikeBtk, matchKnownItem, bestCandidateMatch, guessAddressLine, guessOrgNumber,
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

test('matchKnownItem does not throw on a non-string reference (the model can emit a bare JSON number)', () => {
  // Regression: a numeric-looking item number like "784.019" is just as likely to come back from the
  // model as the JSON number 784.019 as the string "784.019" - this used to throw
  // "reference.trim is not a function" before reference.trim() could ever run.
  assert.doesNotThrow(() => matchKnownItem(784.019, KNOWN_ITEMS));
  assert.equal(matchKnownItem(1, KNOWN_ITEMS).btk, 'BTK000001'); // the ordinal path still works numerically
  assert.equal(matchKnownItem(null, KNOWN_ITEMS), null);
  assert.equal(matchKnownItem(undefined, KNOWN_ITEMS), null);
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

test('bestCandidateMatch does not throw on a non-string reference', () => {
  const candidates = [{ btk: 'BTK000729W01', name: '784.019 VALVE SEAT' }];
  assert.doesNotThrow(() => bestCandidateMatch(784.019, candidates));
});

test('parseJsonReply extracts JSON even when wrapped in prose or code fences', () => {
  const wrapped = 'Sure, here you go:\n```json\n{"items":[{"reference":"1","quantity":2}]}\n```';
  assert.deepEqual(parseJsonReply(wrapped), { items: [{ reference: '1', quantity: 2 }] });
});

test('parseJsonReply still parses when the reply has a brace AFTER the JSON (the old greedy regex rejected it)', () => {
  const reply = '{"items":[{"reference":"1","quantity":2}],"recipientName":"Acme"}\n\nLet me know if you want {changes}.';
  assert.deepEqual(parseJsonReply(reply), { items: [{ reference: '1', quantity: 2 }], recipientName: 'Acme' });
});

test('parseJsonReply takes the final answer when a draft object comes first', () => {
  const reply = 'Draft: {"items":[{"reference":"old","quantity":1}]}\nFinal: {"items":[{"reference":"new","quantity":4}]}';
  assert.deepEqual(parseJsonReply(reply), { items: [{ reference: 'new', quantity: 4 }] });
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

test('guessOrgNumber prefers a labeled line over a bare match elsewhere', () => {
  const text = 'Invoice ref: 111111-1111\nAcme AB\nOrg.nr: 556677-8899\n123 45 Stockholm';
  assert.equal(guessOrgNumber(text), '556677-8899');
});

test('guessOrgNumber does not treat the bare word "org" (with no nr/number/no suffix) as a genuine label', () => {
  const text = 'Ref 111111-1111, see our org page for details.\nContact: Acme AB\nOrg.nr: 556677-8899';
  assert.equal(guessOrgNumber(text), '556677-8899');
});

test('guessOrgNumber falls back to a bare match when no label is present', () => {
  assert.equal(guessOrgNumber('Acme AB\n556677-8899\n123 45 Stockholm'), '556677-8899');
});

test('guessOrgNumber returns null when nothing matches', () => {
  assert.equal(guessOrgNumber('no numbers shaped like that here'), null);
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
    { reference: 'item 1', quantity: 1, btk: 'BTK000001', matchedName: 'Widget A', elsewhere: null },
    { reference: 'item 2', quantity: 3, btk: 'BTK000002', matchedName: 'Widget B', elsewhere: null },
  ]);
  assert.equal(draft.recipient.name, 'Acme AB');
  assert.equal(draft.recipient.address, null);
  assert.equal(draft.recipient.confidence, 'unknown');
  assert.equal(draft.from, null);
});

test('parseOrderRequest does not throw when the model returns numeric-looking references as bare JSON numbers, and resolves them by item number', async () => {
  // Regression, reproducing a real report: "pack an order to besab maskin of 2x 784.019 and 2x of
  // 784.020" failed to build the order, because:
  //   1. The model returned {"reference": 784.019} (a valid JSON number - exactly what an item
  //      number shaped like a decimal invites) instead of {"reference": "784.019"}, which crashed
  //      matchKnownItem()/bestCandidateMatch() ("reference.trim is not a function") the moment
  //      either tried to call .trim() on it, surfacing as a generic "Something went wrong" toast.
  //   2. Even with that fixed, an item referenced by NUMBER (not name) has no word in common with
  //      its own display name ("Valve Seat"), so bestCandidateMatch()'s plain word-overlap score
  //      against the reference text "784.019" would be 0 and wrongly reject the correct item -
  //      which is exactly why a caller's already-confident candidate (see index.html's
  //      searchItemCandidates, mirrored below) can mark itself `confident: true` to skip that
  //      generic re-check.
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 784.019, quantity: 2 }, { reference: 784.02, quantity: 2 }],
      recipientName: 'Besab Maskin',
      recipientAddressHint: null,
      needsAddressLookup: false,
    }),
  };
  // Realistic shape: item numbers and display names share no words, exactly like the real catalog
  // (e.g. itemnumber "784.019" / itemname_en "Valve Seat") - knownItems only carries {btk, name} (see
  // aiHandlePackOrderRequest in index.html), so resolution has to go through searchItemCandidates.
  const byItemnumber = { '784.019': { btk: 'BTK000729W01', name: 'Valve Seat' }, '784.02': { btk: 'BTK001047W01', name: 'Guide Ring' } };
  const searchItemCandidates = async (reference) => {
    const hit = byItemnumber[String(reference)];
    return hit ? [{ ...hit, confident: true }] : []; // mirrors aiFuzzyFindItem's exact-itemnumber match
  };

  const draft = await parseOrderRequest(
    fakeGroq,
    'pack an order to besab maskin of 2x 784.019 and 2x of 784.020',
    { knownItems: [], searchItemCandidates },
  );

  assert.equal(draft.items.length, 2);
  assert.equal(draft.items[0].reference, '784.019'); // coerced to a real string, not left as a number
  assert.equal(draft.items[0].btk, 'BTK000729W01');
  assert.equal(draft.items[0].matchedName, 'Valve Seat'); // shown to the user as-is, never the bare reference
  assert.equal(draft.items[0].quantity, 2);
  assert.equal(draft.items[1].reference, '784.02'); // JSON numbers don't preserve a trailing zero
  assert.equal(draft.items[1].btk, 'BTK001047W01');
  assert.equal(draft.recipient.name, 'Besab Maskin');
});

test('a confident candidate skips the name-similarity re-check; an unmarked one still needs to pass it', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: '784.019', quantity: 1 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  // Same candidate, only the `confident` flag differs - isolates exactly what that flag controls.
  const candidate = { btk: 'BTK000729W01', name: 'Valve Seat' };
  const confident = await parseOrderRequest(fakeGroq, 'x', { searchItemCandidates: async () => [{ ...candidate, confident: true }] });
  assert.equal(confident.items[0].btk, 'BTK000729W01');
  const unmarked = await parseOrderRequest(fakeGroq, 'x', { searchItemCandidates: async () => [{ ...candidate }] });
  assert.equal(unmarked.items[0].btk, null); // "784.019" vs "Valve Seat" scores 0 on plain word overlap
});

test('parseOrderRequest coerces a quantity the model sent as a string', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'item 1', quantity: '3' }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  const draft = await parseOrderRequest(fakeGroq, 'plocka item 1 x3', { knownItems: KNOWN_ITEMS });
  assert.equal(draft.items[0].quantity, 3);
  assert.equal(typeof draft.items[0].quantity, 'number');
});

test('parseOrderRequest asks for a generous completion-token budget by default, and lets a caller override it', async () => {
  // Regression, reproducing a real report: every single pack-order request failed with a generic
  // error, including the simplest possible one ("pack 2 of 784.019", no recipient, one item). The
  // model (TEXT) is a reasoning model whose own internal reasoning tokens count against the same
  // max_completion_tokens budget as its visible reply — at groq-client's own 2048-token default,
  // reasoning alone can consume the whole budget before any JSON ever comes out, so
  // parseJsonReply() throws "did not contain JSON" for what looks like every request failing
  // identically regardless of wording.
  let captured;
  const fakeGroq = {
    chat: async (opts) => {
      captured = opts;
      return JSON.stringify({ items: [{ reference: 'item 1', quantity: 1 }], recipientName: null, recipientAddressHint: null, needsAddressLookup: false });
    },
  };
  await parseOrderRequest(fakeGroq, 'pack 1 of item 1', { knownItems: KNOWN_ITEMS });
  assert.equal(captured.maxTokens, 4096);

  await parseOrderRequest(fakeGroq, 'pack 1 of item 1', { knownItems: KNOWN_ITEMS, maxTokens: 8000 });
  assert.equal(captured.maxTokens, 8000);
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
  assert.deepEqual(draft.items, [{ reference: 'blue widget', quantity: 2, btk: 'BTK000099', matchedName: 'Blue Widget Large', elsewhere: null }]);
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
  assert.equal(draft.items[0].elsewhere, null);
});

test('parseOrderRequest flags an item found in another warehouse as `elsewhere`, without resolving it as this order\'s btk', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'blue widget', quantity: 1 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  const searchItemCandidates = async () => []; // nothing in the current warehouse
  let searchedOtherWith = null;
  const searchOtherWarehouses = async (text) => {
    searchedOtherWith = text;
    return [{ btk: 'BTK000200', name: 'Blue Widget', warehouseId: '2', quantity: 12 }];
  };

  const draft = await parseOrderRequest(fakeGroq, 'plocka en blue widget', { searchItemCandidates, searchOtherWarehouses });

  assert.equal(searchedOtherWith, 'blue widget');
  assert.equal(draft.items[0].btk, null); // never resolved cross-warehouse
  assert.deepEqual(draft.items[0].elsewhere, { btk: 'BTK000200', name: 'Blue Widget', warehouseId: '2', quantity: 12 });
});

test('parseOrderRequest does not call searchOtherWarehouses once the item is already resolved', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [{ reference: 'item 1', quantity: 1 }],
      recipientName: null, recipientAddressHint: null, needsAddressLookup: false,
    }),
  };
  let otherCalled = false;
  const searchOtherWarehouses = async () => { otherCalled = true; return []; };

  const draft = await parseOrderRequest(fakeGroq, 'plocka item 1', { knownItems: KNOWN_ITEMS, searchOtherWarehouses });

  assert.equal(otherCalled, false);
  assert.equal(draft.items[0].elsewhere, null);
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
    return 'Acme AB head office\n123 45 Stockholm\nOrg.nr: 556677-8899\nPhone: 08-1234567';
  };

  const draft = await parseOrderRequest(fakeGroq, 'plocka BTK000001 till Acme AB, sök upp adressen', {
    knownItems: KNOWN_ITEMS, webSearch, fetchPageText,
  });

  assert.equal(draft.recipient.address, '123 45 Stockholm');
  assert.equal(draft.recipient.orgNumber, '556677-8899');
  assert.equal(draft.recipient.confidence, 'searched');
});

test('parseOrderRequest picks up an address and an org number from different result pages', async () => {
  const fakeGroq = {
    chat: async () => JSON.stringify({
      items: [], recipientName: 'Acme AB', recipientAddressHint: null, needsAddressLookup: true,
    }),
  };
  const webSearch = async () => [
    { title: 'Acme AB — Contact', url: 'https://acme.example/contact', snippet: '' },
    { title: 'Acme AB — About', url: 'https://acme.example/about', snippet: '' },
  ];
  const fetchPageText = async (url) => (url.endsWith('/contact')
    ? 'Acme AB\n123 45 Stockholm\nPhone: 08-1234567'
    : 'Acme AB was founded in 1990.\nOrg.nr: 556677-8899');

  const draft = await parseOrderRequest(fakeGroq, 'find Acme AB', { webSearch, fetchPageText });

  assert.equal(draft.recipient.address, '123 45 Stockholm');
  assert.equal(draft.recipient.orgNumber, '556677-8899');
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
  assert.equal(draft.recipient.orgNumber, null);
  assert.equal(draft.recipient.confidence, 'not_found');
});

test('parseOrderRequest requires non-empty text', async () => {
  await assert.rejects(parseOrderRequest({ chat: async () => '{}' }, '   '), /text is required/);
});
