// Run: node --test modules/tests/json-extract.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObjects, lastJsonObject } from '../json-extract.js';

test('a bare JSON object is returned as-is', () => {
  assert.deepEqual(extractJsonObjects('{"items":[{"a":1}]}'), [{ items: [{ a: 1 }] }]);
});

test('prose and a code fence around the JSON are ignored', () => {
  const reply = 'Sure, here you go:\n```json\n{"items":[{"reference":"1","quantity":2}]}\n```\nAnything else?';
  assert.deepEqual(extractJsonObjects(reply), [{ items: [{ reference: '1', quantity: 2 }] }]);
});

test('REGRESSION: a brace after the JSON no longer breaks the parse (the greedy first-{-to-last-} span did)', () => {
  const reply = '{"items":[{"name":"Bolt","quantity":3}]}\n\nNote: quantities are as printed {see the delivery note}.';
  assert.deepEqual(extractJsonObjects(reply), [{ items: [{ name: 'Bolt', quantity: 3 }] }]);
  // and the old approach really did fail on it:
  assert.throws(() => JSON.parse(reply.match(/\{[\s\S]*\}/)[0]));
});

test('a stray brace in the prose before the JSON is skipped', () => {
  const reply = 'I will answer in {JSON} form: {"items":[]}';
  assert.deepEqual(extractJsonObjects(reply), [{ items: [] }]);
});

test('an opening brace that never closes does not hide the real object after it', () => {
  assert.deepEqual(extractJsonObjects('Sure {here: {"items": [1]}'), [{ items: [1] }]);
});

test('braces and escaped quotes inside strings do not confuse the matching', () => {
  const obj = { name: 'a } b { c', note: 'say "hi" \\ there', items: [] };
  assert.deepEqual(extractJsonObjects(`Result: ${JSON.stringify(obj)} done`), [obj]);
});

test('nested objects belong to their parent — only top-level objects come back, in order', () => {
  const reply = 'first {"a":{"b":{"c":1}}} then {"d":2}';
  assert.deepEqual(extractJsonObjects(reply), [{ a: { b: { c: 1 } } }, { d: 2 }]);
});

test('lastJsonObject prefers the final answer over an earlier draft or a quoted snippet', () => {
  const reply = '<think>maybe {"items":[]}</think>\nFinal: {"items":[{"name":"Nut","quantity":2}]}';
  assert.deepEqual(lastJsonObject(reply, (o) => Array.isArray(o.items)), { items: [{ name: 'Nut', quantity: 2 }] });
});

test('lastJsonObject skips objects that fail the predicate', () => {
  const reply = '{"items":[1]} and then {"unrelated":true}';
  assert.deepEqual(lastJsonObject(reply, (o) => Array.isArray(o.items)), { items: [1] });
  assert.equal(lastJsonObject(reply, (o) => o.nothing), null);
});

test('nothing parseable gives an empty list, never a throw', () => {
  assert.deepEqual(extractJsonObjects('sorry, I cannot help with that'), []);
  assert.deepEqual(extractJsonObjects('{not json}'), []);
  assert.deepEqual(extractJsonObjects(''), []);
  assert.deepEqual(extractJsonObjects(null), []);
  assert.deepEqual(extractJsonObjects(undefined), []);
  assert.deepEqual(extractJsonObjects(42), []);
  assert.equal(lastJsonObject('no json here'), null);
});

test('a top-level array is not an object reply and is not returned', () => {
  assert.deepEqual(extractJsonObjects('[1,2,3]'), []);
  assert.deepEqual(extractJsonObjects('list: [{"a":1}]'), [{ a: 1 }]); // an object inside prose-wrapped array is still found
});

test('an unterminated string does not loop forever or throw', () => {
  assert.deepEqual(extractJsonObjects('{"a": "never ends'), []);
});
