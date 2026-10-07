// Run: node --test modules/tests/pick-route.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPickRoute, describeMove } from '../pick-route.js';

const stop = (id, zone, depth, level, bin, row = 1) => ({ id, zone, depth, level, bin, row });
const ids = (route) => route.map((s) => s.id);

test('an empty or missing list gives an empty route', () => {
  assert.deepEqual(planPickRoute([]), []);
  assert.deepEqual(planPickRoute(undefined), []);
});

test('zones are visited one after another, alphabetically when there is no floor layout', () => {
  const route = planPickRoute([stop('b1', 'B', 1, 1, 1), stop('a1', 'A', 1, 1, 1), stop('c1', 'C', 1, 1, 1)]);
  assert.deepEqual(ids(route), ['a1', 'b1', 'c1']);
});

test('with a floor layout the next zone is the nearest one, not the next letter', () => {
  const zoneGrid = { A: { col: 0, row: 0 }, B: { col: 9, row: 9 }, C: { col: 1, row: 0 } };
  const route = planPickRoute([stop('b', 'B', 1, 1, 1), stop('a', 'A', 1, 1, 1), stop('c', 'C', 1, 1, 1)], { zoneGrid });
  assert.deepEqual(ids(route), ['a', 'c', 'b']);
});

test('a zone without a floor position still gets visited, after the placed ones', () => {
  const zoneGrid = { B: { col: 0, row: 0 } };
  const route = planPickRoute([stop('a', 'A', 1, 1, 1), stop('b', 'B', 1, 1, 1)], { zoneGrid });
  assert.deepEqual(ids(route), ['b', 'a']);
});

test('the start point decides which placed zone comes first', () => {
  const zoneGrid = { A: { col: 0, row: 0 }, B: { col: 8, row: 0 } };
  const route = planPickRoute([stop('a', 'A', 1, 1, 1), stop('b', 'B', 1, 1, 1)], { zoneGrid, start: { col: 9, row: 0 } });
  assert.deepEqual(ids(route), ['b', 'a']);
});

test('inside a zone the racks snake: forward on the first, back on the second, forward on the third', () => {
  const route = planPickRoute([
    stop('r1b3', 'A', 1, 1, 3), stop('r1b1', 'A', 1, 1, 1),
    stop('r2b1', 'A', 2, 1, 1), stop('r2b4', 'A', 2, 1, 4),
    stop('r3b2', 'A', 3, 1, 2), stop('r3b5', 'A', 3, 1, 5),
  ]);
  assert.deepEqual(ids(route), ['r1b1', 'r1b3', 'r2b4', 'r2b1', 'r3b2', 'r3b5']);
});

test('the snake follows the racks that are actually used, not their raw numbers', () => {
  // racks 2 and 5 are the 1st and 2nd racks of this order -> forward, then back
  const route = planPickRoute([stop('x', 'A', 5, 1, 1), stop('y', 'A', 5, 1, 9), stop('p', 'A', 2, 1, 4), stop('q', 'A', 2, 1, 1)]);
  assert.deepEqual(ids(route), ['q', 'p', 'y', 'x']);
});

test('in one bin the bottom shelf comes first, then the row from the front', () => {
  const route = planPickRoute([stop('top', 'A', 1, 3, 2), stop('back', 'A', 1, 1, 2, 2), stop('front', 'A', 1, 1, 2, 1)]);
  assert.deepEqual(ids(route), ['front', 'back', 'top']);
});

test('stops with no usable bin go last, in the order they were given', () => {
  const route = planPickRoute([{ id: 'n1' }, stop('a', 'A', 1, 1, 1), { id: 'n2', zone: 'A' }, stop('b', 'A', 1, 1, 2)]);
  assert.deepEqual(ids(route), ['a', 'b', 'n1', 'n2']);
});

test('steps are numbered from 1 and the input is not mutated', () => {
  const input = [stop('b', 'A', 1, 1, 2), stop('a', 'A', 1, 1, 1)];
  const route = planPickRoute(input);
  assert.deepEqual(route.map((s) => s.step), [1, 2]);
  assert.equal(input[0].step, undefined);
  assert.deepEqual(ids(input), ['b', 'a']);
});

test('zone letters compare case-insensitively', () => {
  const route = planPickRoute([stop('x', 'a', 1, 1, 2), stop('y', 'A', 1, 1, 1)]);
  assert.deepEqual(ids(route), ['y', 'x']);
});

test('junk numbers count as unlocated rather than crashing the route', () => {
  const route = planPickRoute([stop('ok', 'A', 1, 1, 1), { id: 'junk', zone: 'A', depth: 'x', level: NaN, bin: 'y' }]);
  assert.deepEqual(ids(route), ['ok', 'junk']);
});

test('describeMove: the first stop, a new zone, a new rack', () => {
  assert.equal(describeMove(null, stop('a', 'A', 2, 1, 1)), 'Go to zone A, rack 2.');
  assert.equal(describeMove(stop('a', 'A', 1, 1, 1), stop('b', 'B', 1, 1, 1)), 'Walk over to zone B.');
  assert.equal(describeMove(stop('a', 'A', 1, 1, 1), stop('b', 'A', 2, 1, 1)), 'Move on to rack 2.');
});

test('describeMove uses the caller\'s own word for a rack/section', () => {
  const depthLabel = (z, d) => `Section ${d}`;
  assert.equal(describeMove(null, stop('a', 'A', 3, 1, 1), { depthLabel }), 'Go to zone A, Section 3.');
});

test('describeMove: along the rack, and within one bin', () => {
  const at = stop('a', 'A', 1, 2, 3);
  assert.equal(describeMove(at, stop('b', 'A', 1, 1, 5)), 'Same rack, 2 bins further along.');
  assert.equal(describeMove(at, stop('b', 'A', 1, 1, 2)), 'Same rack, 1 bin back.');
  assert.equal(describeMove(at, stop('b', 'A', 1, 4, 3)), 'Same bin, 2 shelves up.');
  assert.equal(describeMove(at, stop('b', 'A', 1, 1, 3)), 'Same bin, 1 shelf down.');
  assert.equal(describeMove(at, stop('b', 'A', 1, 2, 3, 2)), 'Same bin, a little further back.');
  assert.equal(describeMove(at, stop('b', 'A', 1, 2, 3, 1)), 'Same spot — right next to the last one.');
});

test('describeMove: a stop without a location says so; nothing to move to says nothing', () => {
  assert.match(describeMove(stop('a', 'A', 1, 1, 1), { id: 'n' }), /No bin location/);
  assert.equal(describeMove(stop('a', 'A', 1, 1, 1), null), '');
});
