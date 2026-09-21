// Run: node --test modules/tests/visma-sync.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncStateFor, summarizeSyncStates, buildSyncExport, planAuditImport, planScrapeImport,
  parseQuantity, vismaArticleNumber, SYNC_EXPORT_COLUMNS,
} from '../visma-sync.js';

// W = Numberofitems (ours), B = VismaQty (what Visma held at the last sync)
const item = (btk, articleNumber, W, B, extra = {}) => ({
  BTKnumber: btk, itemnumber3: articleNumber, Numberofitems: String(W),
  VismaQty: B === undefined ? null : B, 'itemname(english)': `Item ${btk}`, ...extra,
});

test('parseQuantity accepts the shapes Visma and the add-on produce', () => {
  assert.equal(parseQuantity('12'), 12);
  assert.equal(parseQuantity('1 234,5'), 1234.5);
  assert.equal(parseQuantity('1,234.5'), 1234.5);
  assert.equal(parseQuantity('-3'), -3);
  assert.equal(parseQuantity('0'), 0);
  for (const bad of ['', '   ', 'None', 'abc', '1.2.3', null, undefined]) assert.equal(parseQuantity(bad), null, JSON.stringify(bad));
});

test('vismaArticleNumber reads Item #3 and treats the blank spellings as no number', () => {
  assert.equal(vismaArticleNumber({ itemnumber3: '1103013MB' }), '1103013MB');
  for (const v of ['', '  ', 'None', 'null', undefined]) assert.equal(vismaArticleNumber({ itemnumber3: v }), '');
});

test('syncStateFor names the four states and the delta a push would apply', () => {
  assert.deepEqual(syncStateFor(item('A', '100MB', 5, 5)), { state: 'in-sync', articleNumber: '100MB', current: 5, baseline: 5, delta: 0 });
  assert.deepEqual(syncStateFor(item('B', '100MB', 7, 5)), { state: 'pending', articleNumber: '100MB', current: 7, baseline: 5, delta: 2 });
  assert.deepEqual(syncStateFor(item('C', '100MB', 3, 5)), { state: 'pending', articleNumber: '100MB', current: 3, baseline: 5, delta: -2 });
  assert.equal(syncStateFor(item('D', '100MB', 5, null)).state, 'never-synced');
  assert.equal(syncStateFor(item('E', 'None', 5, 5)).state, 'no-number');
  assert.equal(syncStateFor(item('F', '100MB', 0, 0)).state, 'in-sync'); // 0 is a real baseline, not "unset"
});

test('summarizeSyncStates counts every item exactly once', () => {
  const counts = summarizeSyncStates([item('A', '1MB', 5, 5), item('B', '2MB', 7, 5), item('C', '3MB', 1, null), item('D', '', 1, 1)]);
  assert.deepEqual(counts, { 'in-sync': 1, pending: 1, 'never-synced': 1, 'no-number': 1 });
});

test('buildSyncExport uses the add-on\'s own column names and carries both numbers', () => {
  const { columns, rows } = buildSyncExport([item('BTK1W01', '1103013MB', 7, 5, { LocationCode: 'A 3-2 1-1', UnitType: 'st' })], { warehouseName: 'Malmö Best' });
  assert.deepEqual(columns, [...SYNC_EXPORT_COLUMNS]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visma_artikelnummer, '1103013MB'); // the add-on's first-choice article column
  assert.equal(rows[0].Antal, '7');                       // the add-on's exact quantity column
  assert.equal(rows[0].Antal_forvantad, '5');             // the baseline it should still find
  assert.equal(rows[0].Antal_differens, '+2');
  assert.equal(rows[0].btk, 'BTK1W01');
  assert.equal(rows[0].Lagerplats, 'A 3-2 1-1');
  assert.equal(rows[0].webware_warehouse, 'Malmö Best');
});

test('buildSyncExport leaves the baseline BLANK when there is none, rather than claiming Visma holds 0', () => {
  const { rows } = buildSyncExport([item('A', '1MB', 4, null)]);
  assert.equal(rows[0].Antal_forvantad, '');
  assert.equal(rows[0].Antal_differens, '');
});

test('buildSyncExport sends only what needs sending, and reports items with no article number', () => {
  const items = [item('A', '1MB', 5, 5), item('B', '2MB', 7, 5), item('C', '3MB', 1, null), item('D', 'None', 9, 1)];
  const { rows, skipped, counts } = buildSyncExport(items);
  assert.deepEqual(rows.map((r) => r.visma_artikelnummer), ['2MB', '3MB']); // in-sync is left out
  assert.deepEqual(skipped, [{ btk: 'D', name: 'Item D', reason: 'no Visma article number' }]);
  assert.equal(counts.rows, 2);
  assert.equal(counts['in-sync'], 1);
  assert.deepEqual(buildSyncExport(items, { states: ['pending'] }).rows.map((r) => r.btk), ['B']);
});

// ── the add-on's audit CSV coming back ──────────────────────────────────────────────────────────
const audit = (articleNumber, status, extra = {}) => ({
  article_number: articleNumber, status, confirmed_quantity: '', before_stock: '', after_stock: '',
  message: '', timestamp: '2026-09-22T10:00:00.000Z', ...extra,
});

test('a confirmed update moves the baseline and needs no review', () => {
  const items = [item('A', '1MB', 7, 5)];
  const plan = planAuditImport([audit('1MB', 'updated', { confirmed_quantity: '7', before_stock: '5' })], items);
  assert.equal(plan.counts.review, 0);
  assert.equal(plan.apply.length, 1);
  assert.equal(plan.apply[0].changes.VismaQty, 7);
  assert.equal(plan.apply[0].changes.VismaSyncedAt, '2026-09-22T10:00:00.000Z');
  assert.equal(plan.apply[0].changes.Numberofitems, undefined); // our own quantity is not touched
});

test('Visma having moved before the add-on wrote is flagged, not applied', () => {
  // we exported baseline 5; the add-on found 4 (someone sold one) and still saved 7
  const plan = planAuditImport([audit('1MB', 'updated', { confirmed_quantity: '7', before_stock: '4' })], [item('A', '1MB', 7, 5)]);
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.review.length, 1);
  assert.match(plan.review[0].reason, /sold or received/);
  assert.deepEqual(plan.review[0].conflicts[0], { field: 'Visma before the update', ours: '5', theirs: '4', fill: false });
});

test('our own quantity changing after the export is flagged too', () => {
  // exported 7, someone then set it to 9 here; Visma was written with the older 7
  const plan = planAuditImport([audit('1MB', 'updated', { confirmed_quantity: '7', before_stock: '5' })], [item('A', '1MB', 9, 5)]);
  assert.equal(plan.review.length, 1);
  assert.match(plan.review[0].reason, /changed after the export/);
});

test('an unconfirmed save never moves the baseline', () => {
  const plan = planAuditImport([audit('1MB', 'save_unconfirmed', { confirmed_quantity: '7', before_stock: '5' })], [item('A', '1MB', 7, 5)]);
  assert.equal(plan.apply.length, 0);
  assert.match(plan.review[0].reason, /could not confirm/);
});

test('statuses where Visma was not changed are ignored, with the reason kept', () => {
  const items = [item('A', '1MB', 7, 5)];
  for (const status of ['skipped', 'not_found', 'invalid', 'duplicate', 'not_processed']) {
    const plan = planAuditImport([audit('1MB', status)], items);
    assert.equal(plan.apply.length, 0, status);
    assert.equal(plan.review.length, 0, status);
    assert.match(plan.ignored[0].reason, /Visma was not changed/, status);
  }
});

test('a created article is matched by its resolved number and starts a baseline', () => {
  const plan = planAuditImport(
    [audit('', 'created', { resolved_article_number: '9MB', confirmed_quantity: '4' })],
    [item('A', '9MB', 4, null)],
  );
  assert.equal(plan.apply.length, 1);
  assert.equal(plan.apply[0].changes.VismaQty, 4);
});

test('audit rows that match nothing, or match several items, are reported not guessed', () => {
  const items = [item('A', '1MB', 7, 5), item('B', '1MB', 2, 2)];
  const plan = planAuditImport([audit('1MB', 'updated', { confirmed_quantity: '7' }), audit('ZZZ', 'updated', { confirmed_quantity: '1' })], items);
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.counts.unmatched, 1);
  assert.match(plan.ignored.find((i) => i.articleNumber === '1MB').reason, /several items/);
});

// ── a scraped article list coming in ────────────────────────────────────────────────────────────
const scrape = (articleNumber, qty, extra = {}) => ({ article_number: articleNumber, antal_i_lager: String(qty), ...extra });

test('Visma moving on its own is pulled in when we have not edited since', () => {
  const plan = planScrapeImport([scrape('1MB', 3)], [item('A', '1MB', 5, 5)], { scrapedAt: 'T' });
  assert.equal(plan.review.length, 0);
  assert.deepEqual(plan.apply[0].changes, { VismaQty: 3, VismaSyncedAt: 'T', Numberofitems: 3 });
  assert.match(plan.apply[0].reason, /Visma changed on its own/);
});

test('both sides having moved is never resolved automatically, and suggests the merged number', () => {
  // baseline 5; we went to 7 (+2), Visma went to 4 (-1) -> 4 + 2 = 6
  const plan = planScrapeImport([scrape('1MB', 4)], [item('A', '1MB', 7, 5)]);
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.review[0].suggestion, 6);
  assert.match(plan.review[0].reason, /both changed/);
  assert.equal(plan.review[0].changes.Numberofitems, undefined);
});

test('an item still waiting to be pushed is not pulled backwards', () => {
  // baseline 5, we are at 7, Visma is still 5 — the pending push, not a pull
  const plan = planScrapeImport([scrape('1MB', 5)], [item('A', '1MB', 7, 5)]);
  assert.equal(plan.review.length, 0);
  assert.equal(plan.apply[0].changes.Numberofitems, undefined);
  assert.equal(plan.apply[0].changes.VismaQty, 5);
  assert.match(plan.apply[0].reason, /waiting to be pushed/);
});

test('a first scrape with no baseline and disagreeing numbers asks rather than picking a side', () => {
  const plan = planScrapeImport([scrape('1MB', 3)], [item('A', '1MB', 5, null)]);
  assert.equal(plan.apply.length, 0);
  assert.match(plan.review[0].reason, /never synced before/);
});

test('a first scrape that already agrees just records the baseline', () => {
  const plan = planScrapeImport([scrape('1MB', 5)], [item('A', '1MB', 5, null)], { scrapedAt: 'T' });
  assert.deepEqual(plan.apply[0].changes, { VismaQty: 5, VismaSyncedAt: 'T' });
});

test('an item already in sync is not listed as work', () => {
  const plan = planScrapeImport([scrape('1MB', 5)], [item('A', '1MB', 5, 5)]);
  assert.equal(plan.apply.length, 0);
  assert.equal(plan.review.length, 0);
  assert.match(plan.ignored[0].reason, /already in sync/);
});

test('extra fields fill a blank but never overwrite a value we already have', () => {
  const items = [item('A', '1MB', 5, 5, { 'itemname(english)': '', UnitType: 'st' })];
  const plan = planScrapeImport([scrape('1MB', 3, { artikelnamn: 'O-RING 104', enhet: 'kg' })], items, { fields: ['quantity', 'name', 'unit'] });
  assert.equal(plan.apply.length, 0); // the unit clashes, so the whole row goes to review
  assert.equal(plan.review[0].changes['itemname(english)'], 'O-RING 104'); // blank name filled
  assert.deepEqual(plan.review[0].conflicts.find((c) => c.field === 'UnitType'), { field: 'UnitType', ours: 'st', theirs: 'kg', fill: false });
});

test('the quantity column is found under any of Visma\'s names, and the article number too', () => {
  for (const row of [
    { artikelnr: '1MB', ant_i_lager: '3' },
    { visma_artikelnummer: '1MB', 'Antal i lager': '3' },
    { article_number: '1MB', lagersaldo: '3' },
  ]) {
    const plan = planScrapeImport([row], [item('A', '1MB', 5, 5)]);
    assert.equal(plan.apply.length + plan.review.length, 1, JSON.stringify(row));
  }
});

test('a row with nothing usable is reported, never silently dropped', () => {
  const plan = planScrapeImport([scrape('', 3), scrape('1MB', 'abc'), scrape('ZZZ', 1)], [item('A', '1MB', 5, 5)]);
  assert.equal(plan.counts.ignored, 3);
  assert.equal(plan.counts.unmatched, 1);
});

test('empty input is fine on both sides', () => {
  for (const plan of [planAuditImport([], []), planScrapeImport([], []), planAuditImport(undefined, undefined), planScrapeImport(undefined, undefined)]) {
    assert.deepEqual(plan.counts, { apply: 0, review: 0, ignored: 0, unmatched: 0 });
  }
  assert.deepEqual(buildSyncExport(undefined).rows, []);
});
