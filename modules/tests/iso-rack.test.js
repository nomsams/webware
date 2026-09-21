// Run: node --test modules/tests/iso-rack.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRackGeometry, buildIsoRackSVG, buildIsoFloorSVG, formatLocationCode, ISO_BLUE } from '../iso-rack.js';

const count = (s, re) => (s.match(re) || []).length;

test('formatLocationCode matches the app\'s own bin codes: "Zone Depth-Level Bin-Row", Row always written', () => {
  assert.equal(formatLocationCode('A', 3, 2, 2, 1), 'A 3-2 2-1');
  assert.equal(formatLocationCode('A', 3, 2, 2, 2), 'A 3-2 2-2');
  assert.equal(formatLocationCode('B', 1, 12, 14), 'B 1-12 14-1'); // Row defaults to 1
});

test('resolveRackGeometry falls back to schematic defaults when nothing is recorded, and says so', () => {
  const g = resolveRackGeometry(null, { maxDepth: 2, maxLevel: 3, maxBin: 10 });
  assert.equal(g.binsPerLevel, 10);
  assert.equal(g.runLength, 400); // 10 bins x the 40 cm default
  assert.equal(g.cellW, 40);
  assert.equal(g.rackD, 60);
  assert.equal(g.totalDepth, 2 * 60 + 8); // two racks plus the small gap between them
  assert.equal(g.pitch, 45);
  assert.equal(g.height, 3 * 45 + 3);
  assert.equal(g.recorded.rackW, null);
  assert.equal(g.recorded.shelfH, null);
});

test('resolveRackGeometry uses recorded rack/shelf/bin dimensions', () => {
  const g = resolveRackGeometry(
    { zone: 'A', max_aisle: 4, rack_width_cm: 120, rack_depth_cm: 80, shelf_height_cm: 50 },
    { maxDepth: 2, maxLevel: 5, maxBin: 20 },
  );
  assert.equal(g.runLength, 480); // 4 bays x 120
  assert.equal(g.bayW, 120);
  assert.equal(g.cellW, 24); // 20 bins across 480 cm
  assert.equal(g.rackD, 80);
  assert.equal(g.clear, 50);
  assert.equal(g.pitch, 53);
  assert.equal(g.height, 5 * 53 + 3);
  assert.equal(g.recorded.rackW, 120);
});

test('resolveRackGeometry derives the level height from a recorded rack height when the shelf height is missing', () => {
  const g = resolveRackGeometry({ zone: 'A', rack_height_cm: 250 }, { maxDepth: 1, maxLevel: 5, maxBin: 4 });
  assert.ok(Math.abs(g.height - 250) < 0.01, `height ${g.height}`);
});

test('resolveRackGeometry treats the older shelf width as the bay width, and splits a deep shelf into bin rows', () => {
  const g = resolveRackGeometry({ zone: 'A', max_aisle: 2, shelf_width_cm: 100, rack_depth_cm: 90, bin_depth_cm: 30 }, { maxDepth: 1, maxLevel: 2, maxBin: 4 });
  assert.equal(g.runLength, 200);
  assert.equal(g.rows, 3);
  assert.equal(g.binD, 30);
});

test('resolveRackGeometry widens to fit a bin or Row beyond the configured size, and ignores junk dimensions', () => {
  const wide = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 1, maxBin: 4 }, { minBin: 9, minRows: 3 });
  assert.equal(wide.binsPerLevel, 9);
  assert.equal(wide.rows, 3);
  const junk = resolveRackGeometry({ zone: 'A', rack_width_cm: 'abc', rack_depth_cm: -5, shelf_height_cm: NaN, bin_width_cm: 0 }, { maxDepth: 1, maxLevel: 1, maxBin: 2 });
  assert.equal(junk.recorded.rackW, null);
  assert.equal(junk.recorded.rackD, null);
  assert.equal(junk.recorded.shelfH, null);
  assert.equal(junk.recorded.binW, null);
  assert.ok(Number.isFinite(junk.height) && junk.height > 0);
});

test('buildIsoRackSVG draws the located bin as one solid blue box with its coordinates, and nothing else solid blue', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 2, maxLevel: 3, maxBin: 10 });
  const svg = buildIsoRackSVG(g, { highlight: { depth: 1, level: 2, bin: 7 } });
  assert.match(svg, /^<svg /);
  assert.equal(count(svg, /class="iso-hl-front"/g), 1);
  assert.equal(count(svg, /class="iso-hl-side"/g), 1);
  assert.equal(count(svg, /class="iso-hl-top"/g), 1);
  assert.ok(svg.includes('>A 1-2 7-1<'), 'coordinates label');
  assert.ok(svg.includes(ISO_BLUE.front));
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test('buildIsoRackSVG: the rack structure is see-through (fill-opacity below 1), only the located bin is opaque', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 2, maxBin: 4 });
  const svg = buildIsoRackSVG(g, { highlight: { depth: 1, level: 1, bin: 1 } });
  for (const cls of ['iso-board-top', 'iso-board-front', 'iso-board-side', 'iso-bin']) {
    const rule = svg.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`));
    assert.ok(rule, `${cls} has a rule`);
    const m = rule[1].match(/fill-opacity:([0-9.]+)/);
    assert.ok(m && parseFloat(m[1]) < 0.6, `${cls} is semi-transparent`);
  }
  for (const cls of ['iso-hl-front', 'iso-hl-side', 'iso-hl-top']) {
    const rule = svg.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))[1];
    assert.doesNotMatch(rule, /fill-opacity/, `${cls} is fully opaque`);
  }
});

test('buildIsoRackSVG escapes a label instead of injecting markup', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 1, maxBin: 2 });
  const svg = buildIsoRackSVG(g, { highlight: { depth: 1, level: 1, bin: 1, label: '<img src=x onerror=alert(1)>' }, ariaLabel: '"><script>' });
  assert.doesNotMatch(svg, /<img/);
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;img/);
});

test('buildIsoRackSVG tints occupied bins, outlines a selected shelf, and marks everything clickable when interactive', () => {
  const g = resolveRackGeometry({ zone: 'B' }, { maxDepth: 2, maxLevel: 3, maxBin: 5 });
  const svg = buildIsoRackSVG(g, {
    interactive: true,
    occupied: [{ depth: 1, level: 1, bin: 2, count: 3 }, { depth: 2, level: 3, bin: 5 }],
    selected: { depth: 1, level: 1 },
  });
  assert.equal(count(svg, /iso-bin iso-bin-occupied/g), 2);
  assert.equal(count(svg, /iso-shelf-selected/g), 2); // the rule + the one selected board
  assert.match(svg, /data-depth="1" data-level="1" data-bin="2" data-row="1"/);
  assert.ok(svg.includes('B 1-1 2-1 — 3 items'));
  assert.doesNotMatch(buildIsoRackSVG(g, {}), /data-depth/);
});

test('buildIsoRackSVG stays cheap on a huge rack: empty-bin outlines are dropped, occupied bins are not', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 4, maxLevel: 10, maxBin: 100 });
  const svg = buildIsoRackSVG(g, { occupied: [{ depth: 2, level: 4, bin: 50 }] });
  assert.ok(count(svg, /<polygon/g) < 400, `polygons ${count(svg, /<polygon/g)}`);
  assert.equal(count(svg, /iso-bin iso-bin-occupied/g), 1);
});

test('buildIsoRackSVG dimension callouts: dashed "≈" for anything not recorded, solid values when it is', () => {
  const unrecorded = buildIsoRackSVG(resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 2, maxBin: 4 }), { showDimensions: true, sampleBin: true });
  assert.match(unrecorded, /iso-dim iso-dim-dash/);
  assert.match(unrecorded, /≈/);
  assert.ok(unrecorded.includes('sample bin'));
  const recorded = buildIsoRackSVG(resolveRackGeometry(
    { zone: 'A', max_aisle: 2, rack_width_cm: 120, rack_depth_cm: 60, rack_height_cm: 200, shelf_height_cm: 45 },
    { maxDepth: 1, maxLevel: 4, maxBin: 6 },
  ), { showDimensions: true });
  assert.doesNotMatch(recorded, /iso-dim-dash"/);
  assert.ok(recorded.includes('2 × 120 = 240 cm'));
  assert.ok(recorded.includes('200 cm'));
  assert.ok(recorded.includes('45 cm'));
  assert.doesNotMatch(recorded, /NaN|Infinity|undefined/);
});

test('buildIsoFloorSVG returns nothing when no zone is placed, otherwise blocks per zone plus a located bin', () => {
  assert.equal(buildIsoFloorSVG([]), '');
  assert.equal(buildIsoFloorSVG([{ zone: 'A', max_aisle: 3, max_rack: 1 }]), ''); // never placed on the grid
  const zones = [
    { zone: 'A', grid_col: 0, grid_row: 0, max_aisle: 6, max_rack: 2, max_level: 4, max_bin: 12 },
    { zone: 'B', grid_col: 8, grid_row: 3, max_aisle: 4, max_rack: 1, max_level: 3, max_bin: 8 },
  ];
  const svg = buildIsoFloorSVG(zones, { selectedZone: 'B', highlight: { zone: 'A', depth: 2, level: 3, bin: 5 }, interactive: true });
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('>A<') && svg.includes('>B<'));
  assert.match(svg, /data-zone="A"/);
  assert.match(svg, /iso-zone-front iso-zone-selected/);
  assert.equal(count(svg, /class="iso-hl-front"/g), 1);
  assert.ok(svg.includes('>A 2-3 5-1<'));
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
});

test('every renderer stays finite over odd inputs', () => {
  const odd = [
    [null, null], [{}, {}], [{ zone: 'A', max_aisle: 0, max_rack: 0 }, { maxDepth: 0, maxLevel: 0, maxBin: 0 }],
    [{ zone: 'Z', max_aisle: 50, rack_width_cm: 300 }, { maxDepth: 3, maxLevel: 12, maxBin: 60 }],
    [{ zone: 'Q', rack_height_cm: 40 }, { maxDepth: 1, maxLevel: 20, maxBin: 1 }],
  ];
  for (const [zone, bounds] of odd) {
    const g = resolveRackGeometry(zone, bounds, { minBin: 3, minRows: 2 });
    for (const v of [g.runLength, g.cellW, g.totalDepth, g.pitch, g.height, g.binH, g.binD]) assert.ok(Number.isFinite(v) && v > 0, JSON.stringify(g));
    const svg = buildIsoRackSVG(g, { highlight: { depth: g.depthCount, level: g.levels, bin: g.binsPerLevel, row: g.rows }, showDimensions: true, sampleBin: true, interactive: true });
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  }
});
