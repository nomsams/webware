// Run: node --test modules/tests/delivery-note-parser.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliveryNoteReply, resolveDeliveryNoteItems, parseDeliveryNoteImage } from '../delivery-note-parser.js';

test('parseDeliveryNoteReply extracts JSON even when wrapped in prose or code fences', () => {
  const wrapped = 'Here you go:\n```json\n{"manufacturer":"Acme AB","warehouseAddress":"123 45 Stockholm","items":[{"name":"Bolt","itemNumber":"AB-1","quantity":10}]}\n```';
  assert.deepEqual(parseDeliveryNoteReply(wrapped), {
    manufacturer: 'Acme AB',
    warehouseAddress: '123 45 Stockholm',
    items: [{ name: 'Bolt', itemNumber: 'AB-1', quantity: 10 }],
  });
});

test('parseDeliveryNoteReply still parses when the reply has a brace AFTER the JSON (the old greedy regex rejected it)', () => {
  const reply = '{"manufacturer":"Acme AB","warehouseAddress":null,"items":[{"name":"Bolt","itemNumber":"B1","quantity":3}]}\n(quantities as printed {see note})';
  assert.deepEqual(parseDeliveryNoteReply(reply), {
    manufacturer: 'Acme AB', warehouseAddress: null, items: [{ name: 'Bolt', itemNumber: 'B1', quantity: 3 }],
  });
});

test('parseDeliveryNoteReply throws when there is no JSON at all', () => {
  assert.throws(() => parseDeliveryNoteReply('sorry, I cannot read that image'), /did not contain JSON/);
});

test('parseDeliveryNoteReply throws when items is missing', () => {
  assert.throws(() => parseDeliveryNoteReply('{"manufacturer":"Acme AB"}'), /missing items array/);
});

test('parseDeliveryNoteReply defaults missing fields to null/1 and drops nameless lines', () => {
  const reply = JSON.stringify({
    manufacturer: null,
    warehouseAddress: null,
    items: [{ name: 'Gasket' }, { name: '', itemNumber: 'X1', quantity: 5 }, { name: 'Bolt', itemNumber: null }],
  });
  const parsed = parseDeliveryNoteReply(reply);
  assert.equal(parsed.manufacturer, null);
  assert.deepEqual(parsed.items, [
    { name: 'Gasket', itemNumber: null, quantity: 1 },
    { name: 'Bolt', itemNumber: null, quantity: 1 },
  ]);
});

test('parseDeliveryNoteReply rounds a fractional quantity', () => {
  const parsed = parseDeliveryNoteReply(JSON.stringify({ items: [{ name: 'Bolt', quantity: 3.7 }] }));
  assert.equal(parsed.items[0].quantity, 4);
});

test('parseDeliveryNoteReply preserves a genuine 0 quantity rather than treating it as missing', () => {
  const parsed = parseDeliveryNoteReply(JSON.stringify({ items: [{ name: 'Backordered Bolt', quantity: 0 }] }));
  assert.equal(parsed.items[0].quantity, 0);
});

test('parseDeliveryNoteReply falls back to 1 for a null or negative quantity, not 0', () => {
  const parsed = parseDeliveryNoteReply(JSON.stringify({ items: [{ name: 'Bolt', quantity: null }, { name: 'Nut', quantity: -3 }] }));
  assert.equal(parsed.items[0].quantity, 1);
  assert.equal(parsed.items[1].quantity, 1);
});

test('parseDeliveryNoteImage sends the image as an image_url content part alongside the extraction prompt', async () => {
  let captured;
  const fakeGroq = { chat: async (opts) => { captured = opts; return JSON.stringify({ items: [] }); } };

  await parseDeliveryNoteImage(fakeGroq, 'data:image/jpeg;base64,AAAA');

  assert.equal(captured.messages[0].role, 'system');
  const userContent = captured.messages[1].content;
  assert.equal(userContent[0].type, 'text');
  assert.deepEqual(userContent[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
});

test('parseDeliveryNoteImage requires an image', async () => {
  await assert.rejects(parseDeliveryNoteImage({ chat: async () => '{}' }, ''), /imageDataUrl is required/);
});

test('resolveDeliveryNoteItems matches by part number first, computing newQty from the live current stock', () => {
  const items = [{ name: 'Bolt', itemNumber: 'AB-1', quantity: 10 }];
  const findByPartNumber = (num) => (num === 'AB-1' ? { btk: 'BTK000001', name: 'Bolt', currentQty: 5 } : null);
  const findByName = () => { throw new Error('should not be called when part number matches'); };

  const { matched, unmatched } = resolveDeliveryNoteItems(items, { findByPartNumber, findByName });

  assert.equal(unmatched.length, 0);
  assert.deepEqual(matched, [{
    btk: 'BTK000001', name: 'Bolt', currentQty: 5, deliveredQty: 10, newQty: 15,
    source: 'part_number', reference: 'Bolt', referenceItemNumber: 'AB-1',
  }]);
});

test('resolveDeliveryNoteItems falls back to name matching when no item number is given or it does not match', () => {
  const items = [{ name: 'Grease Stick', itemNumber: null, quantity: 3 }];
  const findByPartNumber = () => null;
  const findByName = (name) => (name === 'Grease Stick' ? { btk: 'BTK000002', name: 'Grease Stick', currentQty: 0 } : null);

  const { matched } = resolveDeliveryNoteItems(items, { findByPartNumber, findByName });

  assert.equal(matched[0].source, 'name');
  assert.equal(matched[0].newQty, 3);
});

test('resolveDeliveryNoteItems leaves a line unmatched when neither finder hits', () => {
  const items = [{ name: 'Mystery Part', itemNumber: 'ZZZ', quantity: 2 }];
  const { matched, unmatched } = resolveDeliveryNoteItems(items, { findByPartNumber: () => null, findByName: () => null });

  assert.equal(matched.length, 0);
  assert.deepEqual(unmatched, [{ name: 'Mystery Part', itemNumber: 'ZZZ', quantity: 2 }]);
});

test('resolveDeliveryNoteItems works with no finders supplied at all (everything unmatched)', () => {
  const items = [{ name: 'Bolt', itemNumber: 'AB-1', quantity: 1 }];
  const { matched, unmatched } = resolveDeliveryNoteItems(items, {});
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
});

test('resolveDeliveryNoteItems treats a missing currentQty as zero rather than NaN', () => {
  const items = [{ name: 'Bolt', itemNumber: 'AB-1', quantity: 4 }];
  const findByPartNumber = () => ({ btk: 'BTK000001', name: 'Bolt' }); // no currentQty field at all
  const { matched } = resolveDeliveryNoteItems(items, { findByPartNumber });
  assert.equal(matched[0].currentQty, 0);
  assert.equal(matched[0].newQty, 4);
});
