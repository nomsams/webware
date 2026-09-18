// Run: node --test modules/tests/visma-import.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySuffix, findBrandPrefix, extractHanyStyleCode, extractItemNumberCandidates, inferManufacturer,
  resolveQuantity, parsePlatsLocation, mapEnhetToUnitType, buildVismaImportDraft,
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

test('inferManufacturer prefers Företag, then the CSV\'s own manufacturers column, then a brand prefix, then a HÄNY-style code shape, then blank', () => {
  assert.equal(inferManufacturer('794.035 O-RING', { foretag: 'HÄNY', csvManufacturer: 'Someone Else' }), 'HÄNY');
  assert.equal(inferManufacturer('MYSTERY WIDGET', { csvManufacturer: 'Nycander' }), 'Nycander');
  assert.equal(inferManufacturer('WEBER EXM 725 ANL. GROV 20 KG', {}), 'WEBER');
  assert.equal(inferManufacturer('2261-CS-11 GREASE RING', {}), 'HÄNY');
  assert.equal(inferManufacturer('MINIPALL', {}), null);
  assert.equal(inferManufacturer('MINIPALL'), null); // no options object at all
});

test('inferManufacturer infers the manufacturer from a whitelisted model-code prefix when the brand word itself is missing from the name', () => {
  assert.equal(inferManufacturer('EXM 702 EXPANDER 20 KG', {}), 'WEBER');
  assert.equal(inferManufacturer('REP 995 YTSLAMMA 20 KG (A+B)', {}), 'WEBER');
  assert.equal(inferManufacturer('ZMP 725 HÄNY INJEKTERINGSPUMP', {}), 'HÄNY'); // also has the word HÄNY, but confirms the code-prefix tier agrees
});

test('extractItemNumberCandidates finds a bare 6-8 digit part number', () => {
  assert.deepEqual(extractItemNumberCandidates('1012785 HÄNY SEAL KIT CYLINDER'), ['1012785']);
});

test('extractItemNumberCandidates finds a Weber/TEI-style "LETTERS space DIGITS" model code', () => {
  assert.deepEqual(extractItemNumberCandidates('WEBER REP 990 BETONGSKYDD KOMP B 6,8KG'), ['REP 990']);
  assert.deepEqual(extractItemNumberCandidates('WEBER EXM 731 EXPANDERANDE FOGBETONG TIX'), ['EXM 731']);
  assert.deepEqual(extractItemNumberCandidates('TEI TE 726 BORRHAMMARE 26,7 Kw'), ['TE 726']);
});

test('extractItemNumberCandidates finds two distinct codes when a name carries both a dotted and a letter-dash-digits shape', () => {
  assert.deepEqual(extractItemNumberCandidates('793.539 HÄNY LUFTFILTER HPU6 H-5075'), ['793.539', 'H-5075']);
});

test('extractItemNumberCandidates finds a dotted code (with trailing letter) alongside a digits-dash-letters-dash-digits code', () => {
  assert.deepEqual(extractItemNumberCandidates('HÄNY 398.022C 3-WAY VALVE 2 1/2" 1862-WQ-99'), ['398.022C', '1862-WQ-99']);
});

test('extractItemNumberCandidates never returns the same code twice even if it appears more than once', () => {
  assert.deepEqual(extractItemNumberCandidates('793.539 SPARE FOR 793.539 O-RING'), ['793.539']);
});

test('extractItemNumberCandidates returns an empty array when nothing matches', () => {
  assert.deepEqual(extractItemNumberCandidates('PALLHUV'), []);
});

test('mapEnhetToUnitType maps every distinct Swedish unit confirmed in the real export, case-insensitively', () => {
  assert.equal(mapEnhetToUnitType('Styck'), 'st');
  assert.equal(mapEnhetToUnitType('KILO'), 'kg');
  assert.equal(mapEnhetToUnitType('liter'), 'liter');
  assert.equal(mapEnhetToUnitType('Pall'), 'pallet');
  assert.equal(mapEnhetToUnitType('Dag'), 'dag');
  assert.equal(mapEnhetToUnitType('Rulle'), 'rulle');
  assert.equal(mapEnhetToUnitType('Meter'), 'meter');
  assert.equal(mapEnhetToUnitType('Kvadratmeter'), 'kvadratmeter');
  assert.equal(mapEnhetToUnitType('Vecka'), 'vecka');
  assert.equal(mapEnhetToUnitType('Paket'), 'paket');
  assert.equal(mapEnhetToUnitType('Timmar'), 'timmar');
  assert.equal(mapEnhetToUnitType('Löpmeter'), 'lopmeter');
  assert.equal(mapEnhetToUnitType('Månad'), 'manad');
  assert.equal(mapEnhetToUnitType('Förpackning'), 'forpackning');
  assert.equal(mapEnhetToUnitType('Kilometer'), 'kilometer');
});

test('mapEnhetToUnitType falls back to \'st\' for an unrecognized or missing unit', () => {
  assert.equal(mapEnhetToUnitType('Something Else'), 'st');
  assert.equal(mapEnhetToUnitType(''), 'st');
  assert.equal(mapEnhetToUnitType(undefined), 'st');
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

test('buildVismaImportDraft uses the v3 export\'s own manufacturers/location columns and extracts two item numbers from a HÄNY-style name', () => {
  const draft = buildVismaImportDraft([
    { artikelnr: '1733621MB', artikelnamn: '793.539 HÄNY LUFTFILTER HPU6 H-5075', enhet: 'Styck', ant_i_lager: '11,00', manufacturers: 'HÄNY', location: 'A 2-3 1-2' },
  ], []); // no separate inventory-count file — everything comes from the v3 row itself

  const item = draft.groups[0].items[0];
  assert.equal(item.manufacturer, 'HÄNY');
  assert.equal(item.itemnumber, '793.539');
  assert.equal(item.itemnumber2, 'H-5075');
  assert.equal(item.itemnumber3, '1733621MB');
  assert.equal(item.unitType, 'st');
  assert.equal(item.locationCode, 'A2-3-01-2');
  assert.equal(item.quantity, 11); // no inventering match, ant_i_lager is non-negative
  assert.equal(draft.noLocationCount, 0);
});

test('buildVismaImportDraft prefers the inventory-count file\'s Plats/Antal/Artikelnummer over the v3 row\'s own columns when both are present', () => {
  const draft = buildVismaImportDraft(
    [{ artikelnr: '1103188MB', artikelnamn: '12070 REED WASHER RED RUBBER 1"', enhet: 'Kilo', ant_i_lager: '-99,00', manufacturers: 'Wrong Brand', location: 'A 9-9 9-9' }],
    [{ visma_artikelnummer: '1103188MB', Artikelnummer: '12070', 'Företag': 'Reed', Plats: 'A 4-3 4-2', Antal: '20.0' }],
  );
  const item = draft.groups[0].items[0];
  assert.equal(item.manufacturer, 'Reed'); // Företag wins over the CSV's own manufacturers column
  assert.equal(item.itemnumber, '12070'); // manual Artikelnummer wins over regex extraction from the name
  assert.equal(item.quantity, 20); // inventering Antal wins over ant_i_lager
  assert.equal(item.locationCode, 'A4-3-04-2'); // inventering Plats wins over the v3 row's own location
  assert.equal(item.unitType, 'kg');
});

test('buildVismaImportDraft does not treat a manual Artikelnummer as a distinct Item #2 when it only differs from a regex-extracted code by case', () => {
  const draft = buildVismaImportDraft(
    [{ artikelnr: '1900001MB', artikelnamn: 'D-2728 HÄNY VALVE', enhet: 'Styck', ant_i_lager: '5' }],
    [{ visma_artikelnummer: '1900001MB', Artikelnummer: 'd-2728', 'Företag': 'HÄNY', Plats: 'A 1-1 1-1', Antal: '5' }],
  );
  const item = draft.groups[0].items[0];
  assert.equal(item.itemnumber, 'd-2728'); // manual Artikelnummer wins as Item #1
  assert.equal(item.itemnumber2, null); // same code as Item #1, just different case — not a second code
});

test('buildVismaImportDraft handles empty input without throwing', () => {
  assert.deepEqual(buildVismaImportDraft([], []), { groups: [], unresolvedManufacturerCount: 0, noLocationCount: 0, resetQuantityCount: 0 });
  assert.deepEqual(buildVismaImportDraft(undefined, undefined), { groups: [], unresolvedManufacturerCount: 0, noLocationCount: 0, resetQuantityCount: 0 });
});
