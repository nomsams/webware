// Turns a Visma article export plus a physical inventory-count file into structured,
// per-destination-warehouse item drafts — no Supabase/DOM access; index.html does all the actual
// writing (warehouse creation, BTK allocation, activity logging), same convention as
// order-parser.js/delivery-note-parser.js.
//
// STATUS: wired in, as the header's "📥 Import from Visma" button (admin only, Supabase mode) —
// see index.html's commitVismaImport()/parseVismaImportFiles()/renderVismaImportSummary().
//
// Background: Visma's own article numbers (`artikelnr`, called `visma_artikelnummer` in the
// inventory-count file) carry a trailing company/city suffix — confirmed against the real export
// and the person who runs this business: MB (Malmö/Best), BBD (Malmö/BBD), GN (Göteborg/Ntex),
// GJ (Göteborg/Johns), SN (Stockholm/Ntex). Anything else — no suffix at all, or an unrecognized
// one (e.g. "WDL") — is one shared "unrecognized" bucket, never guessed into Best by default.
//
// Two more things confirmed against the real data, not guessable from the files alone:
//   - Visma's own `ant_i_lager` (stock qty) is unreliable — most non-zero values in the real
//     export are negative, some by thousands — so it's only used as a fallback (when the
//     inventory-count file has no matching row), and a negative value there is reset to 0 with a
//     comment recording what it was, never trusted as a literal quantity.
//   - The inventory-count file's "Plats" values (e.g. "A 3-3 1-1") are Zone, Depth, Level, Bin,
//     Row in that order (Depth = racks from the walkway, Level = levels up, Bin = position
//     left-to-right, Row = position front-to-back, 1 = closest to the walkway) — matching
//     webware's own LocationCode format (Zone+Depth-Level-Bin(-Row), Row omitted when 1).
//
// Usage:
//   import { buildVismaImportDraft } from './visma-import.js';
//   const draft = buildVismaImportDraft(vismaRows, inventeringRows);
//   // vismaRows: parsed rows of the Visma export (Papa.parse(text, {header:true}).data) — each
//   //   needs at least artikelnr/artikelnamn/ant_i_lager.
//   // inventeringRows: parsed rows of the physical count file — each needs at least
//   //   visma_artikelnummer/Artikelnummer/Företag/Plats/Antal.
//   // draft: {
//   //   groups: [{ suffixCode, isBest, needsNewWarehouse, warehouseName, city, items: [{
//   //     vismaCode, name, manufacturer, itemnumber, itemnumber3, quantity, comment,
//   //     locationCode, inventoryLocation,
//   //   }] }],
//   //   unresolvedManufacturerCount, noLocationCount, resetQuantityCount,
//   // }

export const KNOWN_ARTICLE_SUFFIXES = {
  MB:  { city: 'Malmö',     company: 'Best',  warehouseName: 'Best',             existingWarehouseId: '1' },
  BBD: { city: 'Malmö',     company: 'BBD',   warehouseName: 'BBD',              existingWarehouseId: null },
  GN:  { city: 'Göteborg',  company: 'Ntex',  warehouseName: 'Ntex (Göteborg)',  existingWarehouseId: null },
  GJ:  { city: 'Göteborg',  company: 'Johns', warehouseName: 'Johns (Göteborg)', existingWarehouseId: null },
  SN:  { city: 'Stockholm', company: 'Ntex',  warehouseName: 'Ntex (Stockholm)', existingWarehouseId: null },
};
const SUFFIX_CODES = Object.keys(KNOWN_ARTICLE_SUFFIXES);
// Longest-first isn't load-bearing today (no known code is a suffix of another), but guards
// against that becoming true later without anyone noticing.
const SUFFIXES_BY_LENGTH_DESC = [...SUFFIX_CODES].sort((a, b) => b.length - a.length);

export const UNRECOGNIZED_SUFFIX = 'UNRECOGNIZED';
export const UNRECOGNIZED_WAREHOUSE_NAME = 'Unrecognized (Visma import)';

export function classifySuffix(artikelnr) {
  const code = String(artikelnr || '').trim().toUpperCase();
  for (const suf of SUFFIXES_BY_LENGTH_DESC) {
    if (code.endsWith(suf)) return suf;
  }
  return UNRECOGNIZED_SUFFIX;
}

// Brand names actually observed in the real export, as a plain "name starts with" prefix check —
// deliberately a short, hand-maintained list rather than anything fuzzy, since a wrong brand guess
// is worse than leaving a manufacturer blank for a human to fill in during review.
export const KNOWN_BRAND_PREFIXES = [
  'HÄNY', 'WEBER', 'MAPE', 'TEI', 'ECOBETON', 'SIKA', 'REED', 'GA LINDBERG',
];

export function findBrandPrefix(name) {
  const upper = String(name || '').trim().toUpperCase();
  return KNOWN_BRAND_PREFIXES.find((b) => upper.startsWith(b)) || null;
}

// The three HÄNY-internal numbering shapes confirmed against the real catalog — a dotted 3-digit
// code ("794.035"), a letter-dash-digits code ("D-2728"/"H-5189"), or a digits-dash-letters-dash-
// digits code ("2261-CS-11"). Checked in this order; the first match wins.
const RE_DOTTED = /\b\d{3}\.\d{2,3}[A-Z]?\b/;
const RE_LETTER_DASH_DIGITS = /\b[A-Z]-\d{3,4}\b/;
const RE_DIGITS_DASH_LETTERS_DASH_DIGITS = /\b\d{3,4}-[A-Z]{1,2}-\d{2,3}\b/;

export function extractHanyStyleCode(name) {
  const upper = String(name || '').toUpperCase();
  const m = upper.match(RE_DOTTED) || upper.match(RE_LETTER_DASH_DIGITS) || upper.match(RE_DIGITS_DASH_LETTERS_DASH_DIGITS);
  return m ? m[0] : null;
}

// Företag (from the inventory-count file) wins outright when given; otherwise a known brand
// prefix in the name; otherwise a HÄNY-style code shape in the name implies HÄNY specifically —
// the one case worth inferring from a code shape alone, per how HÄNY's own parts are actually
// named in this catalog (their brand word doesn't always appear, their numbering scheme does).
// Anything else is left blank for a human to fill in during review, never guessed further.
export function inferManufacturer(name, foretag) {
  if (foretag && String(foretag).trim()) return String(foretag).trim();
  const brand = findBrandPrefix(name);
  if (brand) return brand;
  if (extractHanyStyleCode(name)) return 'HÄNY';
  return null;
}

// Visma exports Swedish-formatted numbers (comma decimal, space thousands-separator, e.g.
// "-9 225,00") — plain Number() would silently read these as NaN.
function parseSwedishNumber(value) {
  if (value === undefined || value === null || value === '') return NaN;
  return Number(String(value).replace(/\s/g, '').replace(',', '.'));
}

// The inventory-count file's own physically-counted Antal, when this row has a match there, is
// authoritative. Otherwise Visma's ant_i_lager is used as-is when it's a real stock number
// (>= 0) — but that field is unreliable (most non-zero values in the real export are negative,
// some by thousands), so a negative reading is reset to 0 rather than trusted, with a comment
// recording what it actually said for whoever does the physical recount.
export function resolveQuantity(antiLager, inventeringMatch) {
  if (inventeringMatch && inventeringMatch.Antal !== undefined && inventeringMatch.Antal !== null && inventeringMatch.Antal !== '') {
    const counted = parseSwedishNumber(inventeringMatch.Antal);
    if (!Number.isFinite(counted)) return { quantity: 0, comment: null };
    if (counted >= 0) return { quantity: Math.round(counted), comment: null };
    // A negative physical count is almost certainly a data-entry slip rather than a real reading —
    // flagged the same way a negative ant_i_lager is below, rather than silently dropped, so a
    // typo in the count file doesn't disappear without a trace during review.
    return { quantity: 0, comment: `Physical count was ${Math.round(counted)} — reset to 0, needs recount.` };
  }
  const n = parseSwedishNumber(antiLager);
  if (!Number.isFinite(n)) return { quantity: 0, comment: null };
  if (n >= 0) return { quantity: Math.round(n), comment: null };
  return { quantity: 0, comment: `Visma stock was ${Math.round(n)} — reset to 0, needs physical count.` };
}

// "A 3-3 1-1" -> Zone A, Depth 3, Level 3, Bin 1, Row 1, confirmed against the actual warehouse:
// Depth = racks counted from the walkway/front, Level = levels up, Bin = position left-to-right,
// Row = a bin's own front-to-back position (1 = closest to the walkway). Row 1 is the front-most
// position and is omitted from the composed code entirely, per webware's own LocationCode format
// (see the README's "Bin Location Codes" section).
const PLATS_RE = /^([A-Za-zÅÄÖåäö]{1,2})\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2})-(\d{1,2})$/;

export function parsePlatsLocation(plats) {
  const m = String(plats || '').trim().match(PLATS_RE);
  if (!m) return null;
  const [, zone, depth, level, bin, row] = m;
  const rowNum = parseInt(row, 10);
  const locationCode = `${zone.toUpperCase()}${depth}-${level}-${bin.padStart(2, '0')}` + (rowNum > 1 ? `-${rowNum}` : '');
  return { locationCode, zone: zone.toUpperCase(), depth: parseInt(depth, 10), level: parseInt(level, 10), bin: parseInt(bin, 10), row: rowNum };
}

function normalizeCode(code) {
  return String(code || '').trim();
}

export function buildVismaImportDraft(vismaRows, inventeringRows) {
  const inventeringByCode = new Map();
  (inventeringRows || []).forEach((r) => {
    const code = normalizeCode(r.visma_artikelnummer);
    if (code) inventeringByCode.set(code, r);
  });

  const buckets = new Map(); // suffixCode | UNRECOGNIZED_SUFFIX -> items[]
  let unresolvedManufacturerCount = 0;
  let noLocationCount = 0;
  let resetQuantityCount = 0;

  (vismaRows || []).forEach((row) => {
    const vismaCode = normalizeCode(row.artikelnr);
    const name = String(row.artikelnamn || '').trim();
    if (!vismaCode || !name) return; // an unusable row (shouldn't happen in a real export) is skipped, not guessed at

    const inventeringMatch = inventeringByCode.get(vismaCode) || null;
    const suffixCode = classifySuffix(vismaCode);

    const manufacturer = inferManufacturer(name, inventeringMatch && inventeringMatch['Företag']);
    if (!manufacturer) unresolvedManufacturerCount++;

    const itemnumber = (inventeringMatch && normalizeCode(inventeringMatch.Artikelnummer)) || extractHanyStyleCode(name) || null;

    const { quantity, comment } = resolveQuantity(row.ant_i_lager, inventeringMatch);
    if (comment) resetQuantityCount++;

    const location = inventeringMatch ? parsePlatsLocation(inventeringMatch.Plats) : null;
    if (!location) noLocationCount++;

    const item = {
      vismaCode, name, manufacturer,
      itemnumber, itemnumber3: vismaCode,
      quantity, comment,
      locationCode: location ? location.locationCode : null,
      inventoryLocation: inventeringMatch ? (inventeringMatch.Plats || null) : null,
    };

    if (!buckets.has(suffixCode)) buckets.set(suffixCode, []);
    buckets.get(suffixCode).push(item);
  });

  const groups = [];
  buckets.forEach((items, suffixCode) => {
    if (suffixCode === UNRECOGNIZED_SUFFIX) {
      groups.push({ suffixCode, isBest: false, needsNewWarehouse: true, warehouseName: UNRECOGNIZED_WAREHOUSE_NAME, city: null, items });
    } else {
      const info = KNOWN_ARTICLE_SUFFIXES[suffixCode];
      groups.push({
        suffixCode, isBest: suffixCode === 'MB',
        needsNewWarehouse: !info.existingWarehouseId,
        warehouseName: info.warehouseName, city: info.city, items,
      });
    }
  });

  return { groups, unresolvedManufacturerCount, noLocationCount, resetQuantityCount };
}
