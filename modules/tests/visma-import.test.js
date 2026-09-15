// Run: node --test modules/tests/visma-import.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySuffix, findBrandPrefix, extractHanyStyleCode, inferManufacturer,
  resolveQuantity, parsePlatsLocation, buildVismaImportDraft,
  UNRECOGNIZED_SUFFIX, UNRECOGNIZED_WAREHOUSE_NAME,
} from '../visma-import.js';

test('classifySuffix recognizes each known code', () => {
  assert.equal(classifySuffix('1103236MB'), 'MB');
  assert.equal(classifySuffix('1733MBBD'), 'BBD');
  assert.equal(classifySuffix('REP933GN'), 'GN');
  assert.equal(classifySuffix('2517525GJ'), 'GJ');
  assert.equal(classifySuffix('1733601866SN'), 'SN');
});

test('classifySuffix is case-insensitive', () => {
  assert.equal(classifySuffix('1103236mb'), 'MB');
});

test('classifySuffix lumps an unrecognized suffix and a bare numeric code into the same unrecognized bucket', () => {
  assert.equal(classifySuffix('1733601866WDL'), UNRECOGNIZED_SUFFIX);
  assert.equal(classifySuffix('900145'), UNRECOGNIZED_SUFFIX);
  assert.equal(classifySuffix('TE726R'), UNRECOGNIZED_SUFFIX);
  assert.equal(classifySuffix(''), UNRECOGNIZED_SUFFIX);
});

test('findBrandPrefix matches a known brand at the start of the name, including product-line variants', () => {
  assert.equal(findBrandPrefix('HÄNY O-RING ID 104,4 X 3,53 MM D-2728'), 'HÄNY');
  assert.equal(findBrandPrefix('WEBER EXM 725 ANL. GROV 20 KG'), 'WEBER');
  assert.equal(findBrandPrefix('WEBERFLOOR 4650 20KG'), 'WEBER');
  assert.equal(findBrandPrefix('MAPEFLOOR FINISH 52 W 5L'), 'MAPE');
  assert.equal(findBrandPrefix('completely unrelated product name'), null);
});

test('extractHanyStyleCode finds each of the three confirmed code shapes', () => {
  assert.equal(extractHanyStyleCode('794.035 HÄNY O-RING ID 104,4 X 3,53 MM D-2728'), '794.035');
  assert.equal(extractHanyStyleCode('HÄNY VALVE BALL H-1170 DIAM 48MM 784.017'), '784.017'); // dotted wins over letter-dash when both present
  assert.equal(extractHanyStyleCode('613.036 GREASE RING TMP 9 2261-CS-11'), '613.036');
  assert.equal(extractHanyStyleCode('GREASE RING TMP 9 2261-CS-11'), '2261-CS-11'); // digits-dash-letters-dash-digits, no dotted code present
  assert.equal(extractHanyStyleCode('614.038 HÄNY SHAFT SEAL 1005302'), '614.038');
  assert.equal(extractHanyStyleCode('a totally unrelated product'), null);
});

test('inferManufacturer prefers Företag, then a brand prefix, then a HÄNY-style code shape, then blank', () => {
  assert.equal(inferManufacturer('794.035 O-RING', 'HÄNY'), 'HÄNY');
  assert.equal(inferManufacturer('WEBER EXM 725 ANL. GROV 20 KG', null), 'WEBER');
  assert.equal(inferManufacturer('2261-CS-11 GREASE RING', null), 'HÄNY');
  assert.equal(inferManufacturer('MINIPALL', null), null);
});

test('resolveQuantity uses the inventering match\'s physical count when present, ignoring ant_i_lager entirely', () => {
  assert.deepEqual(resolveQuantity('-432,00', { Antal: '36.0' }), { quantity: 36, comment: null });
});

test('resolveQuantity uses ant_i_lager as-is when non-negative and there is no inventering match', () => {
  assert.deepEqual(resolveQuantity('48,00', null), { quantity: 48, comment: null });
});

test('resolveQuantity resets a negative ant_i_lager to 0 with a comment, handling Swedish number formatting', () => {
  const result = resolveQuantity('-9 225,00', null);
  assert.equal(result.quantity, 0);
  assert.match(result.comment, /-9225/);
  assert.match(result.comment, /needs physical count/);
});

test('resolveQuantity flags a negative physical count the same way it flags a negative ant_i_lager, rather than silently clamping it', () => {
  const result = resolveQuantity('0,00', { Antal: '-5' });
  assert.equal(result.quantity, 0);
  assert.match(result.comment, /-5/);
  assert.match(result.comment, /recount/);
});

test('resolveQuantity treats an unparseable value as 0 with no comment', () => {
  assert.deepEqual(resolveQuantity('', null), { quantity: 0, comment: null });
});

test('parsePlatsLocation implements the confirmed Depth-Level/Bin-Row breakdown, omitting Row when 1', () => {
  assert.deepEqual(parsePlatsLocation('A 3-3 1-1'), { locationCode: 'A3-3-01', zone: 'A', depth: 3, level: 3, bin: 1, row: 1 });
});

test('parsePlatsLocation keeps Row in the code when greater than 1', () => {
  assert.deepEqual(parsePlatsLocation('A 4-3 4-2'), { locationCode: 'A4-3-04-2', zone: 'A', depth: 4, level: 3, bin: 4, row: 2 });
});

test('parsePlatsLocation returns null for anything not matching the expected shape', () => {
  assert.equal(parsePlatsLocation(''), null);
  assert.equal(parsePlatsLocation('somewhere on shelf 3'), null);
});

test('buildVismaImportDraft routes rows to the right destination and enriches matched ones from the inventering file', () => {
  const vismaRows = [
    { artikelnr: '1103236MB', artikelnamn: '794.035 HÄNY O-RING ID 104,4 X 3,53 MM D-2728', ant_i_lager: '-432,00' },
    { artikelnr: 'REP933GN', artikelnamn: 'WEBER REP 933 PUMP 0-8 MM 25 KG', ant_i_lager: '0,00' },
    { artikelnr: '900145', artikelnamn: 'ROTPUMP M21 GRUNDAVGIFT', ant_i_lager: '0,00' },
  ];
  const inventeringRows = [
    { visma_artikelnummer: '1103236MB', Artikelnummer: '', 'Företag': 'HÄNY', Plats: 'A 3-3 1-1', Antal: '36.0' },
  ];

  const draft = buildVismaImportDraft(vismaRows, inventeringRows);

  assert.equal(draft.groups.length, 3);
  const best = draft.groups.find((g) => g.suffixCode === 'MB');
  assert.equal(best.isBest, true);
  assert.equal(best.needsNewWarehouse, false);
  assert.equal(best.items[0].quantity, 36); // from inventering Antal, not ant_i_lager
  assert.equal(best.items[0].locationCode, 'A3-3-01');
  assert.equal(best.items[0].itemnumber3, '1103236MB');
  assert.equal(best.items[0].manufacturer, 'HÄNY');

  const gn = draft.groups.find((g) => g.suffixCode === 'GN');
  assert.equal(gn.needsNewWarehouse, true);
  assert.equal(gn.warehouseName, 'Ntex (Göteborg)');
  assert.equal(gn.items[0].manufacturer, 'WEBER');

  const unrecognized = draft.groups.find((g) => g.suffixCode === UNRECOGNIZED_SUFFIX);
  assert.equal(unrecognized.warehouseName, UNRECOGNIZED_WAREHOUSE_NAME);
  assert.equal(unrecognized.items[0].manufacturer, null);

  assert.equal(draft.unresolvedManufacturerCount, 1); // ROTPUMP row
  assert.equal(draft.noLocationCount, 2); // GN row + unrecognized row have no inventering match
  assert.equal(draft.resetQuantityCount, 0); // the only negative ant_i_lager row had an inventering match instead
});

test('buildVismaImportDraft resets a negative ant_i_lager to 0 with a comment when there is no inventering match', () => {
  const draft = buildVismaImportDraft(
    [{ artikelnr: 'EXM703GN', artikelnamn: 'WEBER EXM 703 EXP.BETONG 20KG', ant_i_lager: '-411,00' }],
    [],
  );
  assert.equal(draft.groups[0].items[0].quantity, 0);
  assert.match(draft.groups[0].items[0].comment, /-411/);
  assert.equal(draft.resetQuantityCount, 1);
});

test('buildVismaImportDraft skips a row with no article number or no name rather than guessing', () => {
  const draft = buildVismaImportDraft(
    [{ artikelnr: '', artikelnamn: 'Something', ant_i_lager: '0' }, { artikelnr: 'ABC123MB', artikelnamn: '', ant_i_lager: '0' }],
    [],
  );
  assert.equal(draft.groups.length, 0);
});

test('buildVismaImportDraft handles empty input without throwing', () => {
  assert.deepEqual(buildVismaImportDraft([], []), { groups: [], unresolvedManufacturerCount: 0, noLocationCount: 0, resetQuantityCount: 0 });
  assert.deepEqual(buildVismaImportDraft(undefined, undefined), { groups: [], unresolvedManufacturerCount: 0, noLocationCount: 0, resetQuantityCount: 0 });
});
