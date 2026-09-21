// Run: node --test modules/tests/kit-relink.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relinkKitLines, isRealItemNumber } from '../kit-relink.js';

const item = (btk, n1, n2, n3, manufacturer = 'HÄNY') => ({ btk, itemnumber: n1, itemnumber2: n2, itemnumber3: n3, manufacturer });
const line = (kit_id, quantity, n1, n2, n3, manufacturer = 'HÄNY') => ({ kit_id, quantity, itemnumber: n1, itemnumber2: n2, itemnumber3: n3, manufacturer });

test('isRealItemNumber rejects blanks, "None", and the synthetic 444-prefixed fillers', () => {
  for (const v of [null, undefined, '', '  ', 'None', 'none', '44400003', '444']) assert.equal(isRealItemNumber(v), false, JSON.stringify(v));
  for (const v of ['613.033', 'H-5074', '1103236MB', '1444']) assert.equal(isRealItemNumber(v), true, JSON.stringify(v));
});

test('a line finds the re-created item by Item #3 (the Visma article number)', () => {
  const { links, unmatched } = relinkKitLines(
    [line(7, 2, '613.033', null, '1103013MB')],
    [item('BTK000001W01', '613.033', '', '1103013MB'), item('BTK000002W01', '999.999', '', '1103014MB')],
  );
  assert.deepEqual(links, [{ kit_id: 7, btk: 'BTK000001W01', quantity: 2 }]);
  assert.deepEqual(unmatched, []);
});

test('a number matches in any slot, case-insensitively', () => {
  const { links } = relinkKitLines(
    [line(1, 1, '540.014', '2511-fk-11', null)],
    [item('NEW1', '784.008A', '2511-FK-11', '1103000MB')],
  );
  assert.deepEqual(links, [{ kit_id: 1, btk: 'NEW1', quantity: 1 }]);
});

test('synthetic 444-prefixed numbers are never used to identify an item', () => {
  const { links, unmatched } = relinkKitLines(
    [line(1, 1, '44400003', null, null)],
    [item('NEW1', '44400003', '', '')], // same filler on an unrelated item
  );
  assert.deepEqual(links, []);
  assert.equal(unmatched[0].reason, 'none');
});

test('several items share the number: the manufacturer settles it, otherwise it is ambiguous, never guessed', () => {
  const items = [item('A', 'H-5074', '', '', 'HÄNY'), item('B', 'H-5074', '', '', 'WEBER')];
  assert.deepEqual(relinkKitLines([line(1, 1, 'H-5074', '', '', 'WEBER')], items).links, [{ kit_id: 1, btk: 'B', quantity: 1 }]);
  const both = relinkKitLines([line(1, 1, 'H-5074', '', '', 'HÄNY'), line(2, 1, 'H-5074', '', '', 'None')], [item('A', 'H-5074', '', '', 'HÄNY'), item('B', 'H-5074', '', '', 'HÄNY')]);
  assert.deepEqual(both.links, []);
  assert.deepEqual(both.unmatched.map((u) => u.reason), ['ambiguous', 'ambiguous']);
});

test('an ambiguous first number does not stop a later number of the same line from deciding', () => {
  const items = [item('A', 'X-1', '', '', 'HÄNY'), item('B', 'X-1', '', '', 'HÄNY'), item('C', 'Z-9', '', '', 'HÄNY')];
  const { links } = relinkKitLines([line(1, 3, 'X-1', 'Z-9', null)], items);
  assert.deepEqual(links, [{ kit_id: 1, btk: 'C', quantity: 3 }]);
});

test('lines that reach the same item in the same kit are added up; different kits stay separate', () => {
  const { links } = relinkKitLines(
    [line(1, 1, '613.049', 'H-5189', null), line(1, 2, '614.053', 'H-5189', null), line(2, 1, '614.053', 'H-5189', null)],
    [item('G', '614.053', 'H-5189', '')],
  );
  assert.deepEqual(links, [{ kit_id: 1, btk: 'G', quantity: 3 }, { kit_id: 2, btk: 'G', quantity: 1 }]);
});

test('a line with nothing left to go on is reported, with its reason', () => {
  const { links, unmatched } = relinkKitLines([line(1, 1, 'GONE-1', '', ''), line(1, 1, null, null, null)], [item('A', 'OTHER', '', '')]);
  assert.deepEqual(links, []);
  assert.deepEqual(unmatched.map((u) => u.reason), ['none', 'none']);
});

test('empty inputs are fine', () => {
  assert.deepEqual(relinkKitLines([], []), { links: [], unmatched: [] });
  assert.deepEqual(relinkKitLines(undefined, undefined), { links: [], unmatched: [] });
});
