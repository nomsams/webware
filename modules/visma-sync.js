// Two-way stock sync between webware and Visma, through the VismaScrap add-on's own CSV files.
// Pure and dependency-injected — no Supabase/DOM access; index.html does the reading and writing,
// same convention as visma-import.js and the other modules.
//
// THE BASELINE. Each item stores what VISMA held the last time the two were in step
// (`items.visma_qty`, `visma_synced_at` — supabase/schema_visma_sync.sql). Call it B; webware's own
// quantity W; Visma's live quantity V. B is written only by a sync, never by an ordinary edit, so:
//
//     W = B                 nothing to send
//     W != B  and  V = B    safe: nobody touched Visma, push W
//     W != B  and  V != B   SOMEONE SOLD OR RECEIVED in Visma since the last sync — never overwrite
//                           silently; flag it, and offer V + (W - B) so both changes survive
//     W = B   and  V != B   Visma moved alone — offer to pull V into webware
//
// The add-on is the half that can check V, because it reads the live article right before saving.
// That is why the export carries BOTH numbers: `Antal` (the value to write) and `Antal_forvantad`
// (the baseline it should still find). An add-on that doesn't know that column yet simply ignores
// it, and webware still catches the drift afterwards from the audit's own `before_stock`.
//
// Nothing here overwrites a value webware already has. Anything that would is returned in `review`
// for the person running the import to decide, per the same rule everywhere: fill a blank, leave a
// difference alone until it is confirmed.
//
// Usage:
//   import { buildSyncExport, planAuditImport, planScrapeImport, syncStateFor } from './visma-sync.js';
//   const { rows } = buildSyncExport(items);                  // -> CSV for the add-on
//   const plan = planAuditImport(auditRows, items);           // <- the add-on's audit CSV
//   const plan = planScrapeImport(scrapedRows, items);        // <- a scraped article list
//   // items are the app's own objects: { BTKnumber, itemnumber3, Numberofitems, VismaQty, ... }

// ── the add-on's own column names ───────────────────────────────────────────────────────────────
// Its inventory importer looks for the article number under `visma_artikelnummer` (then
// `Artikelnummer`), the quantity under exactly `Antal`, and the product name under exactly
// `Produktnamn` — so the export uses those names verbatim and needs no column mapping by hand.
// `Antal_forvantad` ("expected quantity") is the baseline. The rest are for the person reviewing
// each article in the add-on, which shows every column of the row beside the live Visma article.
export const SYNC_EXPORT_COLUMNS = Object.freeze([
  'visma_artikelnummer',
  'Produktnamn',
  'Antal',
  'Antal_forvantad',
  'Antal_differens',
  'btk',
  'Lagerplats',
  'Enhet',
  'webware_warehouse',
]);

// What the add-on's audit CSV calls things (its INVENTORY_AUDIT_COLUMNS).
const AUDIT_ARTICLE_KEYS = ['resolved_article_number', 'article_number'];
const AUDIT_QTY_KEYS = ['confirmed_quantity', 'requested_quantity', 'csv_quantity'];
// A scraped article list: `article_number` plus Visma's own visible column headers, normalized to
// lower_snake_case by the add-on. Stock shows up under a few different names depending on the
// Visma column set, and a plain Visma article export uses `artikelnr`/`ant_i_lager` instead.
const SCRAPE_ARTICLE_KEYS = ['visma_artikelnummer', 'article_number', 'artikelnr', 'artikelnummer'];
const SCRAPE_QTY_KEYS = ['antal_i_lager', 'ant_i_lager', 'lagersaldo', 'stock_balance', 'antal', 'saldo'];
const SCRAPE_NAME_KEYS = ['artikelnamn', 'benamning', 'produktnamn', 'article_name', 'clean_name', 'namn'];
const SCRAPE_UNIT_KEYS = ['enhet', 'unit', 'unittype'];

// Statuses the add-on writes for an article it really did save.
const AUDIT_SAVED = new Set(['updated', 'created']);
// ...and ones where Visma was NOT changed, or we can't tell. 'save_unconfirmed' is the dangerous
// one: Save was clicked but completion could not be verified, so the baseline must not move.
const AUDIT_NOT_SAVED = new Set(['skipped', 'not_found', 'invalid', 'duplicate', 'not_processed']);

const text = (v) => String(v ?? '').trim();
const lower = (v) => text(v).toLowerCase();
const isBlank = (v) => { const t = lower(v); return !t || t === 'none' || t === 'null' || t === 'n/a' || t === 'nan' || t === '—'; };

function pick(row, keys) {
  if (!row) return '';
  // exact key first, then a case/spacing-insensitive match, so "Antal i lager" finds `antal_i_lager`
  for (const k of keys) if (row[k] !== undefined && !isBlank(row[k])) return text(row[k]);
  const norm = {};
  for (const k of Object.keys(row)) norm[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = row[k];
  for (const k of keys) {
    const v = norm[k.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (v !== undefined && !isBlank(v)) return text(v);
  }
  return '';
}

// "1 234,5" / "1,234.5" / "12" -> 12345 / 1234.5 / 12, or null. Same shapes the add-on accepts, so a
// number that survived one side's parser survives the other's.
export function parseQuantity(value) {
  let s = text(value).replace(/[\s ]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else s = s.replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Visma's own article number — webware keeps it in Item #3 (see visma-import.js). Without one there
// is nothing to match on, so the item can only be CREATED in Visma, never updated.
export function vismaArticleNumber(item) {
  const n = text(item && item.itemnumber3);
  return isBlank(n) ? '' : n;
}

function currentQty(item) {
  const n = parseQuantity(item && item.Numberofitems);
  return n === null ? 0 : n;
}

// The baseline, as stored on the item (null when this item has never been synced).
function baselineQty(item) {
  if (!item || item.VismaQty === undefined || item.VismaQty === null || item.VismaQty === '') return null;
  return parseQuantity(item.VismaQty);
}

// Where one item stands relative to Visma. `delta` is what a push would change Visma BY, which is
// also what has to be re-applied on top of V when Visma has moved on its own.
export function syncStateFor(item) {
  const articleNumber = vismaArticleNumber(item);
  const current = currentQty(item);
  const baseline = baselineQty(item);
  if (!articleNumber) return { state: 'no-number', articleNumber: '', current, baseline, delta: 0 };
  if (baseline === null) return { state: 'never-synced', articleNumber, current, baseline: null, delta: 0 };
  const delta = current - baseline;
  return { state: delta === 0 ? 'in-sync' : 'pending', articleNumber, current, baseline, delta };
}

export function summarizeSyncStates(items) {
  const counts = { 'in-sync': 0, pending: 0, 'never-synced': 0, 'no-number': 0 };
  (items || []).forEach((item) => { counts[syncStateFor(item).state] += 1; });
  return counts;
}

// ── export: what to send to the add-on ──────────────────────────────────────────────────────────
// `states` picks which items to include; the default is everything the add-on could act on —
// items whose quantity differs from the baseline, plus ones never synced (their baseline is blank,
// so the add-on has nothing to check against and its reviewer decides).
export function buildSyncExport(items, { states = ['pending', 'never-synced'], warehouseName = '' } = {}) {
  const wanted = new Set(states);
  const rows = [];
  const skipped = [];
  const counts = { ...summarizeSyncStates(items), rows: 0 };
  (items || []).forEach((item) => {
    const s = syncStateFor(item);
    if (!wanted.has(s.state)) {
      if (s.state === 'no-number') skipped.push({ btk: item.BTKnumber, name: item['itemname(english)'] || '', reason: 'no Visma article number' });
      return;
    }
    if (s.state === 'no-number') { skipped.push({ btk: item.BTKnumber, name: item['itemname(english)'] || '', reason: 'no Visma article number' }); return; }
    rows.push({
      visma_artikelnummer: s.articleNumber,
      'Produktnamn': item['itemname(english)'] || item['itemname(swedish)'] || '',
      'Antal': String(s.current),
      // blank, not 0, when there is no baseline — 0 would claim Visma holds nothing
      'Antal_forvantad': s.baseline === null ? '' : String(s.baseline),
      'Antal_differens': s.baseline === null ? '' : (s.delta > 0 ? `+${s.delta}` : String(s.delta)),
      btk: item.BTKnumber || '',
      'Lagerplats': (item.LocationCode && item.LocationCode !== 'None') ? item.LocationCode : '',
      'Enhet': item.UnitType || '',
      webware_warehouse: warehouseName,
    });
  });
  counts.rows = rows.length;
  return { columns: [...SYNC_EXPORT_COLUMNS], rows, skipped, counts };
}

// ── shared plan shape ───────────────────────────────────────────────────────────────────────────
// apply:   changes that are safe to write without asking (a blank being filled, a baseline moving
//          to a value the person already confirmed in Visma)
// review:  everything else, each with the exact values that disagree, for the person to decide
// ignored: rows that say nothing to act on (skipped articles, unmatched numbers, unreadable values)
function emptyPlan() {
  return { apply: [], review: [], ignored: [], counts: { apply: 0, review: 0, ignored: 0, unmatched: 0 } };
}
function finishPlan(plan) {
  plan.counts.apply = plan.apply.length;
  plan.counts.review = plan.review.length;
  plan.counts.ignored = plan.ignored.length;
  plan.counts.unmatched = plan.ignored.filter((i) => i.reason === 'unmatched').length;
  return plan;
}

// Article number -> the item(s) carrying it. Item #3 is the Visma number, but a number that has
// ended up in #1/#2 instead still identifies the item, so those count as a match too.
function indexByArticleNumber(items) {
  const index = new Map();
  (items || []).forEach((item) => {
    ['itemnumber3', 'itemnumber', 'itemnumber2'].forEach((field) => {
      const v = text(item[field]);
      if (isBlank(v)) return;
      const key = v.toUpperCase();
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(item);
    });
  });
  return index;
}
function matchItem(index, articleNumber) {
  const hits = [...(index.get(text(articleNumber).toUpperCase()) || [])];
  if (hits.length === 1) return { item: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return {};
}

// A value webware already has, and the incoming one differs -> a collision, never an overwrite.
// A blank on our side is not a collision: there is nothing to lose by filling it.
function fieldCollision(field, ours, theirs) {
  if (isBlank(theirs)) return null;
  if (isBlank(ours)) return { field, ours: '', theirs: text(theirs), fill: true };
  if (lower(ours) === lower(theirs)) return null;
  return { field, ours: text(ours), theirs: text(theirs), fill: false };
}

// ── the add-on's audit CSV, after it updated Visma ──────────────────────────────────────────────
// The point of this import is the BASELINE: an article the add-on really saved now holds the
// confirmed quantity, so B moves there and the item stops looking pending. Two things make a row
// need a person instead:
//   * the add-on's `before_stock` is not the baseline we exported — Visma had already moved, so
//     whatever it wrote may have overwritten someone else's sale;
//   * webware's own quantity changed after the export, so pushing that value did not push what we
//     have now.
export function planAuditImport(auditRows, items, { exportedAt = null } = {}) {
  const plan = emptyPlan();
  const index = indexByArticleNumber(items);
  (auditRows || []).forEach((row, i) => {
    const rowNumber = i + 2;
    const articleNumber = pick(row, AUDIT_ARTICLE_KEYS);
    const status = lower(pick(row, ['status'])) || 'unknown';
    const base = { rowNumber, articleNumber, status, message: text(row.message) };
    if (!articleNumber) { plan.ignored.push({ ...base, reason: 'no article number in the audit row' }); return; }
    if (AUDIT_NOT_SAVED.has(status)) { plan.ignored.push({ ...base, reason: `Visma was not changed (${status})` }); return; }

    const found = matchItem(index, articleNumber);
    if (found.ambiguous) { plan.ignored.push({ ...base, reason: 'several items carry this article number' }); return; }
    if (!found.item) { plan.ignored.push({ ...base, reason: 'unmatched' }); return; }
    const item = found.item;
    const s = syncStateFor(item);
    const confirmed = parseQuantity(pick(row, AUDIT_QTY_KEYS));
    const beforeStock = parseQuantity(pick(row, ['before_stock']));
    const entry = {
      ...base, btk: item.BTKnumber, name: item['itemname(english)'] || '',
      ours: s.current, baseline: s.baseline, visma: confirmed, beforeStock,
      changes: {}, conflicts: [],
    };

    if (!AUDIT_SAVED.has(status)) {
      // 'error', 'save_unconfirmed', anything unknown: the add-on could not confirm what Visma holds.
      entry.conflicts.push({ field: 'save', ours: String(s.current), theirs: confirmed === null ? '(unknown)' : String(confirmed), fill: false });
      entry.reason = status === 'save_unconfirmed'
        ? 'Save was clicked but the add-on could not confirm it — check this article in Visma before trusting either number'
        : `the add-on reported "${status}"`;
      plan.review.push(entry);
      return;
    }
    if (confirmed === null) { plan.ignored.push({ ...base, reason: 'no usable quantity in the audit row' }); return; }

    entry.changes.VismaQty = confirmed;
    entry.changes.VismaSyncedAt = text(row.timestamp) || exportedAt || null;

    // Did Visma hold what we thought it did, just before the add-on wrote to it?
    if (beforeStock !== null && s.baseline !== null && beforeStock !== s.baseline) {
      entry.conflicts.push({ field: 'Visma before the update', ours: String(s.baseline), theirs: String(beforeStock), fill: false });
      entry.reason = 'Visma held a different number than we last recorded — someone sold or received these in the meantime';
    }
    // Did our own number move after the export?
    if (confirmed !== s.current) {
      entry.conflicts.push({ field: 'Numberofitems', ours: String(s.current), theirs: String(confirmed), fill: false });
      entry.reason = entry.reason || 'webware’s quantity changed after the export, so Visma was set to the older value';
    }
    if (entry.conflicts.length) plan.review.push(entry); else { entry.reason = 'confirmed in Visma'; plan.apply.push(entry); }
  });
  return finishPlan(plan);
}

// ── a scraped article list, or a plain Visma export: what Visma holds right now ──────────────────
// This is the pull direction and the one that can genuinely clash, so the rule is strict: a value is
// applied on its own only when webware has nothing to lose — our quantity still equals the baseline
// (we have not edited since) or there is no baseline yet and the numbers already agree.
export function planScrapeImport(scrapeRows, items, { scrapedAt = null, fields = ['quantity'] } = {}) {
  const plan = emptyPlan();
  const index = indexByArticleNumber(items);
  const wantName = fields.includes('name');
  const wantUnit = fields.includes('unit');
  (scrapeRows || []).forEach((row, i) => {
    const rowNumber = i + 2;
    const articleNumber = pick(row, SCRAPE_ARTICLE_KEYS);
    const base = { rowNumber, articleNumber };
    if (!articleNumber) { plan.ignored.push({ ...base, reason: 'no article number in the row' }); return; }
    const found = matchItem(index, articleNumber);
    if (found.ambiguous) { plan.ignored.push({ ...base, reason: 'several items carry this article number' }); return; }
    if (!found.item) { plan.ignored.push({ ...base, reason: 'unmatched' }); return; }

    const item = found.item;
    const s = syncStateFor(item);
    const visma = parseQuantity(pick(row, SCRAPE_QTY_KEYS));
    const entry = {
      ...base, btk: item.BTKnumber, name: item['itemname(english)'] || '',
      ours: s.current, baseline: s.baseline, visma, changes: {}, conflicts: [],
    };

    if (visma === null) { plan.ignored.push({ ...base, reason: 'no usable quantity in the row' }); return; }

    // Whatever else happens, the scrape tells us what Visma holds — that IS the new baseline.
    entry.changes.VismaQty = visma;
    entry.changes.VismaSyncedAt = scrapedAt;

    if (visma !== s.current) {
      if (s.baseline === null) {
        // Never synced and the two disagree: no way to tell which side moved.
        entry.conflicts.push({ field: 'Numberofitems', ours: String(s.current), theirs: String(visma), fill: false });
        entry.reason = 'never synced before, and the two disagree — pick which number is right';
      } else if (s.current === s.baseline) {
        // We have not touched it since the last sync, so Visma moved alone: safe to pull.
        entry.changes.Numberofitems = visma;
        entry.reason = `Visma changed on its own (${s.baseline} → ${visma})`;
      } else if (visma === s.baseline) {
        // Visma is where we left it; ours is the newer number — nothing to pull, this is a push.
        delete entry.changes.Numberofitems;
        entry.reason = `still waiting to be pushed to Visma (${s.baseline} → ${s.current})`;
      } else {
        // Both moved.
        entry.conflicts.push({ field: 'Numberofitems', ours: String(s.current), theirs: String(visma), fill: false });
        entry.suggestion = visma + (s.current - s.baseline);
        entry.reason = `both changed since the last sync (we ${s.baseline}→${s.current}, Visma ${s.baseline}→${visma})`;
      }
    } else if (s.baseline !== visma) {
      entry.reason = 'already agree — recording it as the new baseline';
    } else {
      plan.ignored.push({ ...base, btk: item.BTKnumber, reason: 'already in sync' });
      return;
    }

    // Optional extra fields, same rule: fill a blank, never overwrite a difference.
    if (wantName) {
      const c = fieldCollision('itemname(english)', item['itemname(english)'], pick(row, SCRAPE_NAME_KEYS));
      if (c && c.fill) entry.changes['itemname(english)'] = c.theirs;
      else if (c) entry.conflicts.push(c);
    }
    if (wantUnit) {
      const c = fieldCollision('UnitType', item.UnitType, pick(row, SCRAPE_UNIT_KEYS));
      if (c && c.fill) entry.changes.UnitType = c.theirs;
      else if (c) entry.conflicts.push(c);
    }

    if (entry.conflicts.length) plan.review.push(entry); else plan.apply.push(entry);
  });
  return finishPlan(plan);
}
