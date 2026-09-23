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
  // No rack_style recorded -> defaults to 'pallet', whose beam is thicker (7cm) than a shelf's
  // decking board (3cm) — see the 'shelving style' test below for the boardT=3 numbers this test
  // used to assert before that default existed.
  const g = resolveRackGeometry(null, { maxDepth: 2, maxLevel: 3, maxBin: 10 });
  assert.equal(g.style, 'pallet');
  assert.equal(g.binsPerLevel, 10);
  assert.equal(g.runLength, 400); // 10 bins x the 40 cm default
  assert.equal(g.cellW, 40);
  assert.equal(g.rackD, 60);
  assert.equal(g.totalDepth, 2 * 60 + 8); // two racks plus the small gap between them
  assert.equal(g.pitch, 49); // 42 clear + 7 (pallet beam thickness)
  assert.equal(g.height, 3 * 49 + 7);
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
  assert.equal(g.pitch, 57); // 50 recorded clear height + 7 (pallet beam thickness, the default style)
  assert.equal(g.height, 5 * 57 + 7);
  assert.equal(g.recorded.rackW, 120);
});

test('resolveRackGeometry: rack_style picks pallet (open beam) vs shelving (thinner board), and rejects an unknown value', () => {
  const bounds = { maxDepth: 1, maxLevel: 2, maxBin: 4 };
  assert.equal(resolveRackGeometry({ zone: 'A' }, bounds).style, 'pallet'); // unset -> pallet
  assert.equal(resolveRackGeometry({ zone: 'A', rack_style: 'pallet' }, bounds).style, 'pallet');
  const shelving = resolveRackGeometry({ zone: 'A', rack_style: 'shelving' }, bounds);
  assert.equal(shelving.style, 'shelving');
  assert.equal(shelving.boardT, 3); // the older, thinner decking-board thickness
  assert.equal(resolveRackGeometry({ zone: 'A', rack_style: 'unicorn' }, bounds).style, 'pallet'); // never crashes on junk
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

test('resolveRackGeometry widens to fit a bin, Row, or Rack beyond the configured size, and ignores junk dimensions', () => {
  const wide = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 1, maxBin: 4 }, { minBin: 9, minRows: 3, minDepth: 5 });
  assert.equal(wide.binsPerLevel, 9);
  // rows itself stays the shelf's own recorded/default capacity (1 here — nothing was recorded) and
  // is NOT widened by minRows — see buildIsoRackSVG's own per-bin binRowsAt(), which is what widens
  // a specific busy bin now, not this shelf-wide default. maxRowsAnywhere is the one minRows widens,
  // purely as an upper bound for the scene's own MAX_DRAWN_BINS estimate.
  assert.equal(wide.rows, 1);
  assert.equal(wide.maxRowsAnywhere, 3);
  assert.equal(wide.depthCount, 5); // an item actually recorded at Rack 5 is never silently dropped just because the zone's own configured max_rack says less
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
  // Default (unset) style is 'pallet' — the beam classes are what this geometry actually draws.
  // Checks must anchor on `class="X"` (actual element usage), not a bare substring: every class
  // name also appears once in the embedded <style> block's own rule, regardless of whether
  // anything on the drawing actually uses it.
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 2, maxBin: 4 });
  const svg = buildIsoRackSVG(g, { highlight: { depth: 1, level: 1, bin: 1 } });
  for (const cls of ['iso-beam-top', 'iso-beam-front', 'iso-beam-side', 'iso-bin']) {
    assert.ok(new RegExp(`class="${cls}[" ]`).test(svg), `${cls} is actually drawn`);
    const rule = svg.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`));
    assert.ok(rule, `${cls} has a rule`);
    const m = rule[1].match(/fill-opacity:([0-9.]+)/);
    assert.ok(m && parseFloat(m[1]) < 0.75, `${cls} is semi-transparent`); // beams read more solid than boards, still see-through
  }
  for (const cls of ['iso-hl-front', 'iso-hl-side', 'iso-hl-top']) {
    const rule = svg.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))[1];
    assert.doesNotMatch(rule, /fill-opacity/, `${cls} is fully opaque`);
  }
});

test('buildIsoRackSVG: shelving style draws board classes (not beam classes) and is see-through too', () => {
  const g = resolveRackGeometry({ zone: 'A', rack_style: 'shelving' }, { maxDepth: 1, maxLevel: 2, maxBin: 4 });
  const svg = buildIsoRackSVG(g, { highlight: { depth: 1, level: 1, bin: 1 } });
  assert.doesNotMatch(svg, /class="iso-beam-(top|front|side)/); // the pallet-only classes are never USED (their rule still exists in <style>)
  for (const cls of ['iso-board-top', 'iso-board-front', 'iso-board-side']) {
    assert.ok(new RegExp(`class="${cls}[" ]`).test(svg), `${cls} is actually drawn`);
    const rule = svg.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))[1];
    const m = rule.match(/fill-opacity:([0-9.]+)/);
    assert.ok(m && parseFloat(m[1]) < 0.6, `${cls} is semi-transparent`);
  }
});

test('buildIsoRackSVG: pallet racking gets yellow foot guards on the nearest rack only; shelving does not', () => {
  const pallet = resolveRackGeometry({ zone: 'A', max_aisle: 2 }, { maxDepth: 2, maxLevel: 2, maxBin: 3 });
  const svgPallet = buildIsoRackSVG(pallet);
  assert.equal(count(svgPallet, /class="iso-foot"/g), pallet.bays + 1); // one per post on the front rack only

  const shelving = resolveRackGeometry({ zone: 'A', max_aisle: 2, rack_style: 'shelving' }, { maxDepth: 2, maxLevel: 2, maxBin: 3 });
  const svgShelving = buildIsoRackSVG(shelving);
  assert.doesNotMatch(svgShelving, /class="iso-foot"/); // its <style> rule can still be present, just unused
});

test('buildIsoRackSVG: shelving racks are X cross-braced per bay per rack; pallet racking is not', () => {
  // max_aisle is ignored for a shelving zone (bays = sections instead — see the sectioned-geometry
  // tests below), so this deliberately passes a max_aisle that does NOT match maxDepth to prove that.
  const shelving = resolveRackGeometry({ zone: 'A', max_aisle: 3, rack_style: 'shelving' }, { maxDepth: 2, maxLevel: 2, maxBin: 3 });
  const svgShelving = buildIsoRackSVG(shelving);
  assert.equal(count(svgShelving, /class="iso-brace"/g), 2 * shelving.bays * shelving.depthCount); // an X = 2 lines, per bay, per depth-rack

  const pallet = resolveRackGeometry({ zone: 'A', max_aisle: 3 }, { maxDepth: 2, maxLevel: 2, maxBin: 3 });
  assert.doesNotMatch(buildIsoRackSVG(pallet), /class="iso-brace"/);
});

test('resolveRackGeometry: a shelving zone treats Depth as sections (side by side), ignoring max_aisle; pallet keeps Depth as real racks', () => {
  const shelving = resolveRackGeometry({ zone: 'A', max_aisle: 99, rack_style: 'shelving' }, { maxDepth: 6, maxLevel: 5, maxBin: 8 });
  assert.equal(shelving.sectioned, true);
  assert.equal(shelving.sections, 6);
  assert.equal(shelving.binsPerSection, 8);
  assert.equal(shelving.depthCount, 1); // one real physical row regardless of how many sections
  assert.equal(shelving.bays, 6); // bays follow sections, not the configured max_aisle
  assert.equal(shelving.binsPerLevel, 48); // 6 sections x 8 local bins, combined
  assert.equal(shelving.totalDepth, shelving.rackD); // no depth stacking, however many sections

  const pallet = resolveRackGeometry({ zone: 'B', max_aisle: 2 }, { maxDepth: 6, maxLevel: 5, maxBin: 8 });
  assert.equal(pallet.sectioned, false);
  assert.equal(pallet.sections, 6);
  assert.equal(pallet.depthCount, 6); // real front-to-back racks, unchanged from before sectioning existed
  assert.equal(pallet.bays, 2); // pallet keeps max_aisle as its own independent bay count
  assert.equal(pallet.binsPerLevel, 8);
});

test('buildIsoRackSVG: a shelving zone draws every section\'s occupied bins, not just the first, and stays one row deep', () => {
  const g = resolveRackGeometry({ zone: 'A', rack_style: 'shelving' }, { maxDepth: 3, maxLevel: 1, maxBin: 2 });
  const svg = buildIsoRackSVG(g, {
    interactive: true,
    occupied: [{ depth: 1, level: 1, bin: 1 }, { depth: 3, level: 1, bin: 2 }], // section 1 AND section 3
  });
  assert.equal(count(svg, /class="iso-bin iso-bin-occupied iso-click"/g), 2); // both sections' occupied bins render, none silently dropped
  assert.match(svg, /Section 1 · Level 1/);
  assert.match(svg, /Section 3 · Level 1/);
  assert.doesNotMatch(svg, /Rack \d/); // never uses the front/back-rack wording for a sectioned zone
});

test('buildIsoRackSVG: uprights are a fixed rack-blue, not the theme-following muted colour', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 1, maxBin: 2 });
  const svg = buildIsoRackSVG(g);
  const rule = svg.match(/\.iso-post\{([^}]*)\}/)[1];
  assert.doesNotMatch(rule, /var\(--text-muted\)/);
  assert.match(rule, /stroke:#[0-9a-f]{6}/i);
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

test('buildIsoRackSVG: a bin stacked several rows deep is sliced thinner right there, without shrinking a lightly-stacked neighbor on the same shelf', () => {
  const g = resolveRackGeometry({ zone: 'A' }, { maxDepth: 1, maxLevel: 1, maxBin: 2 }, { minRows: 4 });
  const occupied = [];
  for (let row = 1; row <= 4; row++) occupied.push({ depth: 1, level: 1, bin: 1, row }); // bin 1: 4 deep
  occupied.push({ depth: 1, level: 1, bin: 2, row: 1 }); // bin 2, same shelf: just 1
  const svg = buildIsoRackSVG(g, { occupied, interactive: true });
  // bin 1 draws 4 row-slices of its own; bin 2 draws only 1 - it is not also forced into quarters
  // just because bin 1, elsewhere on the same shelf, needed that many rows.
  assert.equal(count(svg, /data-bin="1" data-row="\d+"/g), 4);
  assert.equal(count(svg, /data-bin="2" data-row="\d+"/g), 1);
});

test('buildIsoRackSVG sectioned: the same per-bin depth-slicing applies within each section', () => {
  const g = resolveRackGeometry({ zone: 'A', rack_style: 'shelving' }, { maxDepth: 2, maxLevel: 1, maxBin: 2 }, { minRows: 3 });
  const occupied = [
    { depth: 1, level: 1, bin: 1, row: 1 }, { depth: 1, level: 1, bin: 1, row: 2 }, { depth: 1, level: 1, bin: 1, row: 3 },
    { depth: 1, level: 1, bin: 2, row: 1 },
  ];
  const svg = buildIsoRackSVG(g, { occupied, interactive: true });
  assert.equal(count(svg, /data-depth="1" data-level="1" data-bin="1" data-row="\d+"/g), 3);
  assert.equal(count(svg, /data-depth="1" data-level="1" data-bin="2" data-row="\d+"/g), 1);
});

test('buildIsoRackSVG heatmap: an occupied bin\'s fill scales with its count relative to the busiest bin, off by default', () => {
  const g = resolveRackGeometry({ zone: 'B' }, { maxDepth: 1, maxLevel: 1, maxBin: 3 });
  const occupied = [{ depth: 1, level: 1, bin: 1, count: 1 }, { depth: 1, level: 1, bin: 2, count: 5 }];
  assert.doesNotMatch(buildIsoRackSVG(g, { occupied }), /hsl\(217/); // off by default — flat .iso-bin-occupied tint only

  const svg = buildIsoRackSVG(g, { occupied, heatmap: true });
  const lightnesses = [...svg.matchAll(/style="fill:hsl\(217,85%,([\d.]+)%\)/g)].map((m) => Number(m[1]));
  assert.equal(lightnesses.length, 2);
  assert.ok(Math.min(...lightnesses) < Math.max(...lightnesses)); // the busier bin (count 5) is visibly darker/more saturated than the quieter one (count 1)
});

test('buildIsoRackSVG heatmap also colours occupied bins in a sectioned (shelving) rack', () => {
  const g = resolveRackGeometry({ zone: 'A', rack_style: 'shelving' }, { maxDepth: 2, maxLevel: 1, maxBin: 2 });
  const svg = buildIsoRackSVG(g, {
    occupied: [{ depth: 1, level: 1, bin: 1, count: 1 }, { depth: 2, level: 1, bin: 1, count: 4 }],
    heatmap: true,
  });
  assert.equal(count(svg, /style="fill:hsl\(217,85%,/g), 2); // both sections' occupied bins get heatmap fills, same as the non-sectioned path
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
    const g = resolveRackGeometry(zone, bounds, { minBin: 3, minRows: 2, minDepth: 2 });
    for (const v of [g.runLength, g.cellW, g.totalDepth, g.pitch, g.height, g.binH, g.binD]) assert.ok(Number.isFinite(v) && v > 0, JSON.stringify(g));
    const svg = buildIsoRackSVG(g, { highlight: { depth: g.depthCount, level: g.levels, bin: g.binsPerLevel, row: g.rows }, showDimensions: true, sampleBin: true, interactive: true });
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  }
});
