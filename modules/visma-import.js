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
//     left-to-right, Row = position front-to-back, 1 = closest to the walkway) — which is
//     webware's own LocationCode format ("Zone Depth-Level Bin-Row", written the same way).
//
// A later export ("v3") added two more columns directly on the Visma rows themselves —
// `manufacturers` (hand-curated for ~60% of rows) and `location` (the same Plats values as the
// separate inventory-count file, for the same 62 Best rows) — so both are used as an ADDITIONAL,
// lower-priority source alongside the inventory-count file's own Företag/Plats, not a replacement
// for it: the inventory-count file is still authoritative when a row has one.
//
// A still-later export ("v6") added three more: `clean_name` (the product description with brand
// and part numbers already stripped, e.g. "KOMPLETT RESERVDELSLÅDA" for a name whose raw form was
// "TEI TE 726 KOMPLETT RESERVDELSLÅDA" — used only as the item's DISPLAY name, never for
// extraction, since stripping the brand word is exactly what would break manufacturer inference)
// and `article_code_1`/`article_code_2` (item numbers already extracted by whatever produced that
// file, covering roughly a third of rows with shapes this module's own regex whitelist doesn't —
// "TE3549R25WS", "CF2016PF" — populated alongside, not instead of, the ~two-thirds of rows that
// still need the regex fallback below).
//
// Item numbers: `artikelnr` (Visma's own code) is always Item #3 ("internal"). Item #1/#2 come
// from pooling every source that might have one — the inventory-count file's own Artikelnummer
// (hand-verified, e.g. Reed's "12070", wins outright), the v6 export's own article_code_1/2, and
// up to two *distinct* manufacturer-style codes pulled out of the raw product name — HÄNY parts
// often carry two at once (e.g. "793.539 HÄNY LUFTFILTER HPU6 H-5075" has both a dotted code and a
// letter-dash-digits code), Weber/TEI-style parts use a "LETTERS space DIGITS" shape ("REP 990",
// "EXM 731", "TE 726"), and some are just a bare 6-8 digit part number — then taking the first two
// genuinely distinct values across all of them, in that priority order. A lower-priority source
// never overwrites a higher one, it only fills whichever of #1/#2 nothing more authoritative
// already covered.
//
// Usage:
//   import { buildVismaImportDraft } from './visma-import.js';
//   const draft = buildVismaImportDraft(vismaRows, inventeringRows);
//   // vismaRows: parsed rows of the Visma export (Papa.parse(text, {header:true}).data) — each
//   //   needs at least artikelnr/artikelnamn/ant_i_lager/enhet, plus optionally
//   //   manufacturers/location (v3) and clean_name/article_code_1/article_code_2 (v6).
//   // inventeringRows: parsed rows of the physical count file — each needs at least
//   //   visma_artikelnummer/Artikelnummer/Företag/Plats/Antal. Optional — pass [] if you're relying
//   //   entirely on a Visma export that already has its own manufacturers/location columns.
//   // draft: {
//   //   groups: [{ suffixCode, isBest, needsNewWarehouse, warehouseName, city, items: [{
//   //     vismaCode, name, manufacturer, itemnumber, itemnumber2, itemnumber3, unitType,
//   //     quantity, comment, locationCode, inventoryLocation,
//   //   }] }],
//   //   unresolvedManufacturerCount, noLocationCount, resetQuantityCount,
//   // }

export const KNOWN_ARTICLE_SUFFIXES = {
  MB:  { city: 'Malmö',     company: 'Best',  warehouseName: 'Malmö Best',       existingWarehouseId: '1' },
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
// is worse than leaving a manufacturer blank for a human to fill in during review. Kept to brands
// that are both frequent AND distinctive enough as a prefix to be safe (a generic word like
// "Superior" or "Flex" — also seen in the data, just 1-2 rows each — is exactly the kind of
// plausible-looking guess this list deliberately excludes; those rows rely on the CSV's own
// `manufacturers` column or the inventory-count file's Företag instead, see inferManufacturer()).
export const KNOWN_BRAND_PREFIXES = [
  'HÄNY', 'WEBER', 'MAPE', 'TEI', 'ECOBETON', 'SIKA', 'REED', 'GA LINDBERG',
  'KRAFT TOOLS', 'NYCANDER', 'HEIDELBERG', 'RAMBOARD',
];

export function findBrandPrefix(name) {
  const upper = String(name || '').trim().toUpperCase();
  return KNOWN_BRAND_PREFIXES.find((b) => upper.startsWith(b)) || null;
}

// The three HÄNY-internal numbering shapes confirmed against the real catalog — a dotted 3-digit
// code ("794.035"), a letter-dash-digits code ("D-2728"/"H-5189"), or a digits-dash-letters-dash-
// digits code ("2261-CS-11"). Checked in this order; the first match wins. These three are also
// used as a manufacturer signal (see inferManufacturer) — they're specific enough to HÄNY's own
// numbering that a match alone is worth trusting, unlike the two below.
const RE_DOTTED = /\b\d{3}\.\d{2,3}[A-Z]?\b/;
const RE_LETTER_DASH_DIGITS = /\b[A-Z]-\d{3,4}\b/;
const RE_DIGITS_DASH_LETTERS_DASH_DIGITS = /\b\d{3,4}-[A-Z]{1,2}-\d{2,3}\b/;
// A bare manufacturer part number with no separators at all (e.g. HÄNY's "1012785") — 6-8 digits
// specifically to avoid catching a short quantity/year-like number or colliding with Item #3 (the
// Visma article number, which itself is usually shorter or carries a letter suffix).
const RE_BARE_DIGITS = /\b\d{6,8}\b/;
// Weber/TEI/HÄNY-style model codes: a short letter prefix, a space, then digits ("REP 990",
// "EXM 731", "TE 726", "IC 311", "ZMP 725", "MF 80") — distinct from the Visma article number's
// own compact form of the same code (e.g. "REP990MB", no space), which is why this needs to look
// at the *name*, not artikelnr. Deliberately a whitelist of confirmed real prefixes rather than
// "any 2-5 letters" — checked against the full real export, a generic version of this pattern
// matches on plenty of ordinary descriptive words followed by a measurement or weight ("RING 142"
// from "O-RING 142,5 X...", "VIT 25" = "white, 25 kg", "MM 20", "DIN 912", cement grade "LL 42",
// etc.) — every one of those would have been a wrong item number, not a real manufacturer code.
const RE_LETTERS_SPACE_DIGITS = /\b(REP|EXM|TE|IC|ZMP|MF)\s\d{2,4}\b/;

// Each whitelisted model-code prefix above belongs to exactly one manufacturer in this catalog —
// confirmed against every real occurrence, not guessed — so a row missing both Företag and the
// brand word itself in its name (e.g. "EXM 702 EXPANDER 20 KG", no "WEBER" anywhere) can still be
// resolved via its own model code instead of falling back to blank.
const CODE_PREFIX_MANUFACTURER = { REP: 'WEBER', EXM: 'WEBER', TE: 'TEI', IC: 'HÄNY', ZMP: 'HÄNY', MF: 'HÄNY' };

function inferManufacturerFromCodePrefix(name) {
  const m = String(name || '').toUpperCase().match(RE_LETTERS_SPACE_DIGITS);
  return m ? (CODE_PREFIX_MANUFACTURER[m[1]] || null) : null;
}

export function extractHanyStyleCode(name) {
  const upper = String(name || '').toUpperCase();
  const m = upper.match(RE_DOTTED) || upper.match(RE_LETTER_DASH_DIGITS) || upper.match(RE_DIGITS_DASH_LETTERS_DASH_DIGITS);
  return m ? m[0] : null;
}

// Up to two *distinct* manufacturer-style codes found in a product name, checked in this priority
// order (most specific/least likely to be a false hit, first) and de-duplicated — a name carrying
// two different code shapes (common for HÄNY, see the module header comment) yields both, a name
// with only one shape yields just that one, repeated occurrences of the same code count once.
const CODE_PATTERNS = [RE_DOTTED, RE_LETTER_DASH_DIGITS, RE_DIGITS_DASH_LETTERS_DASH_DIGITS, RE_BARE_DIGITS, RE_LETTERS_SPACE_DIGITS];

export function extractItemNumberCandidates(name) {
  const upper = String(name || '').toUpperCase();
  const found = [];
  for (const re of CODE_PATTERNS) {
    const m = upper.match(re);
    if (m && !found.includes(m[0])) {
      found.push(m[0]);
      if (found.length >= 2) break;
    }
  }
  return found;
}

// Priority: the inventory-count file's own Företag (hand-verified for the 62 Best rows it covers)
// wins outright; then the Visma export's own `manufacturers` column (hand-curated for ~60% of the
// full catalog, added in the "v3" export) when given; then a known brand prefix in the name; then
// a whitelisted model-code prefix (REP/EXM/TE/IC/ZMP/MF, see CODE_PREFIX_MANUFACTURER) — for a row
// missing the brand word itself; then a HÄNY-style code shape in the name implies HÄNY specifically
// — the one case worth inferring from a code shape alone, per how HÄNY's own parts are actually
// named in this catalog (their brand word doesn't always appear, their numbering scheme does).
// Anything else is left blank for a human to fill in during review, never guessed further.
export function inferManufacturer(name, { foretag, csvManufacturer } = {}) {
  if (foretag && String(foretag).trim()) return String(foretag).trim();
  if (csvManufacturer && String(csvManufacturer).trim()) return String(csvManufacturer).trim();
  const brand = findBrandPrefix(name);
  if (brand) return brand;
  const fromCode = inferManufacturerFromCodePrefix(name);
  if (fromCode) return fromCode;
  if (extractHanyStyleCode(name)) return 'HÄNY';
  return null;
}

// Visma's `enhet` column uses Swedish unit words — mapped to webware's own UNIT_TYPES values
// (index.html) rather than used verbatim, so the app's Add/Edit-item dropdown and this import
// agree on one canonical value per unit instead of two spellings for the same thing. Falls back to
// 'st' (the app's own default) for anything unrecognized, same as itemToSupabaseRow() already does
// for any UnitType value outside UNIT_TYPES — so an unmapped unit degrades safely either way.
const ENHET_TO_UNIT_TYPE = {
  styck: 'st', kilo: 'kg', liter: 'liter', pall: 'pallet',
  dag: 'dag', rulle: 'rulle', meter: 'meter', kvadratmeter: 'kvadratmeter',
  vecka: 'vecka', paket: 'paket', timmar: 'timmar', 'löpmeter': 'lopmeter',
  'månad': 'manad', 'förpackning': 'forpackning', kilometer: 'kilometer',
};

// The strict lookup: null for anything that isn't a known Swedish unit word, instead of quietly
// becoming 'st' — for a caller that needs to tell "Styck" apart from "no idea what this says"
// (e.g. an update that should leave an item's unit alone rather than overwrite it with a guess).
export function lookupEnhetUnitType(enhet) {
  const key = String(enhet || '').trim().toLowerCase();
  return ENHET_TO_UNIT_TYPE[key] || null;
}

export function mapEnhetToUnitType(enhet) {
  return lookupEnhetUnitType(enhet) || 'st';
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
// Row = a bin's own front-to-back position (1 = closest to the walkway). This notation IS webware's
// own LocationCode format (see the README's "Bin Location Codes" section), so the code is the same
// text, only tidied: upper-case zone, single spaces, no leading zeros, Row always present.
// The zone is ASCII letters only, because that is all the database's CHECK on items.location_code
// accepts; a zone like "Å" is not a bin coordinate as far as webware is concerned (it stays as text).
const PLATS_RE = /^([A-Za-z]{1,2})\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2})-(\d{1,2})$/;

export function parsePlatsLocation(plats) {
  const m = String(plats || '').trim().match(PLATS_RE);
  if (!m) return null;
  const zone = m[1].toUpperCase();
  const [depth, level, bin, row] = m.slice(2).map((n) => parseInt(n, 10));
  return { locationCode: `${zone} ${depth}-${level} ${bin}-${row}`, zone, depth, level, bin, row };
}

function normalizeCode(code) {
  return String(code || '').trim();
}

// De-dupes a priority-ordered list of candidate item-number strings down to the first 2 genuinely
// distinct ones, comparing case-insensitively (a manually-typed or CSV-provided code isn't
// guaranteed the same case as a regex-extracted one, e.g. manual 'd-2728' vs extracted 'D-2728').
function firstTwoDistinctCodes(candidates) {
  const out = [];
  candidates.filter(Boolean).forEach((c) => {
    if (out.length < 2 && !out.some((d) => d.toUpperCase() === c.toUpperCase())) out.push(c);
  });
  return out;
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
    // A later ("v6") export adds `clean_name` — the same product description with the brand and
    // any part numbers already stripped out by whatever produced the file — as a nicer display
    // name than the raw `artikelnamn`. Extraction (manufacturer inference, regex item-number
    // fallback below) still runs against the RAW name, never clean_name: clean_name has the brand
    // word deliberately removed, which is exactly the signal inferManufacturer()/findBrandPrefix()
    // need, and often still contains a leftover code fragment (e.g. "NACKE TE 260") that isn't
    // reliably the *whole* story the raw name would give a regex to work with.
    const rawName = String(row.artikelnamn || '').trim();
    if (!vismaCode || !rawName) return; // an unusable row (shouldn't happen in a real export) is skipped, not guessed at
    const cleanName = row.clean_name ? String(row.clean_name).trim() : '';
    const displayName = cleanName || rawName;

    const inventeringMatch = inventeringByCode.get(vismaCode) || null;
    const suffixCode = classifySuffix(vismaCode);

    const manufacturer = inferManufacturer(rawName, {
      foretag: inventeringMatch && inventeringMatch['Företag'],
      csvManufacturer: row.manufacturers,
    });
    if (!manufacturer) unresolvedManufacturerCount++;

    // Item #1/#2, in priority order: the inventory-count file's own manually-verified Artikelnummer
    // (hand-checked against the physical shelf, wins outright); the "v6" export's own
    // article_code_1/article_code_2 columns (already extracted by whatever produced that file —
    // populated for roughly a third of rows, covering shapes this module's own regex whitelist
    // doesn't, like "TE3549R25WS" or "CF2016PF"); then up to two regex-extracted codes from the raw
    // name, for the majority of rows that have neither. All candidates are pooled and de-duplicated
    // together (case-insensitively) rather than picking one source per field outright, so e.g. a
    // row with only article_code_1 given can still pick up a genuinely different second code the
    // name itself carries.
    const manualNumber = inventeringMatch && normalizeCode(inventeringMatch.Artikelnummer);
    const csvCode1 = normalizeCode(row.article_code_1);
    const csvCode2 = normalizeCode(row.article_code_2);
    const regexCandidates = extractItemNumberCandidates(rawName).filter((c) => c.toUpperCase() !== vismaCode.toUpperCase());
    const [itemnumber = null, itemnumber2 = null] = firstTwoDistinctCodes(
      [manualNumber, csvCode1, csvCode2, ...regexCandidates].filter((c) => c && c.toUpperCase() !== vismaCode.toUpperCase())
    );

    const { quantity, comment } = resolveQuantity(row.ant_i_lager, inventeringMatch);
    if (comment) resetQuantityCount++;

    // The inventory-count file's own Plats wins when this row has a match there; otherwise fall
    // back to the Visma export's own `location` column (added in the "v3" export, carrying the same
    // values for the same 62 Best rows directly on each row, so a separate count-file upload becomes
    // optional rather than required once a row already has this).
    const platsValue = (inventeringMatch && inventeringMatch.Plats) || row.location || null;
    const location = platsValue ? parsePlatsLocation(platsValue) : null;
    if (!location) noLocationCount++;

    // A value that is a bin coordinate lives in the bin location only — it is not repeated in the
    // free-text Inventory Location. One that isn't (a note like "by the door") stays there as written.
    const item = {
      vismaCode, name: displayName, manufacturer,
      itemnumber, itemnumber2, itemnumber3: vismaCode,
      unitType: mapEnhetToUnitType(row.enhet),
      quantity, comment,
      locationCode: location ? location.locationCode : null,
      inventoryLocation: location ? null : platsValue,
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
