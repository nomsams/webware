// Turns free-text like "plocka BTK000012 och item 2 till Acme AB, sök upp adressen" into a
// structured pack-order draft: which items to pick (resolved to real BTKs, with a quantity),
// plus a recipient name/address and (optionally) a from-address — using an LLM (via
// groq-client.js) for the extraction, modules/web-search.js to look up a recipient's
// address/phone when the text names them but gives no address, and a live items-table lookup to
// resolve item references the pre-loaded catalog doesn't already cover.
//
// This is the actual feature behind the "box where we can write or paste something like
// 'plocka item 1 and item 2...'" request. STATUS: standalone, not wired into the Pack Order UI
// yet. Intended integration point: a free-text box above the existing recipient name/address
// fields in #pack-order-view — parseOrderRequest() returns a best-effort draft (items with BTKs
// and quantities already resolved where possible, recipient, from-address) for the user to
// review/edit before Save Order. It never writes to the order, queries the database, or searches
// the web on its own — the caller decides what to do with the draft and supplies whichever of
// knownItems/searchItemCandidates/webSearch/fetchPageText it wants enabled.
//
// Item resolution order, per extracted reference:
//   1. Exact/ordinal match against knownItems (fast path — no network call, e.g. items already
//      loaded for the current warehouse).
//   2. Looks like a bare BTK (e.g. "BTK000012") — used as-is.
//   3. searchItemCandidates(text), if provided — a caller-supplied function that queries the
//      live items table *scoped to the current warehouse* for candidates matching the reference
//      text, scored by bestCandidateMatch() to pick the closest one.
//   4. Still nothing — if searchOtherWarehouses is provided, check whether the item exists in a
//      *different* warehouse and attach it as `elsewhere` (informational only — never used as
//      this item's btk).
//   5. Unresolved — btk stays null, matchedName stays null, left for the user to fix by hand.
//
// Multi-warehouse handling: a saved order already belongs to exactly one warehouse
// (orders.warehouse_id) and pack orders are only ever sent from one warehouse at a time, so btk
// resolution deliberately never crosses warehouses — searchItemCandidates should be scoped with
// `.eq('warehouse_id', currentWarehouseId)`. The same physical product can still be a separate
// row (its own BTK, its own numberofitems) in another warehouse; there's no new "product family"
// column for that — items already carry `manufacturer` + `itemnumber` (the manufacturer's own
// part number), which is what actually identifies "the same product" across warehouses, so
// matching on those is enough without a schema change. searchOtherWarehouses is how you plug
// that in: same shape as searchItemCandidates but querying `.neq('warehouse_id', currentWarehouseId)`
// (or matching manufacturer+itemnumber directly). Its only effect is a non-blocking `elsewhere`
// note on the item — e.g. "not in this warehouse, but 12 in Warehouse 2" — for a human to act on
// (transfer stock first, or tell the recipient it's coming from elsewhere), never an automatic
// cross-warehouse substitution.
//
// Usage:
//   import { parseOrderRequest } from './order-parser.js';
//   import { webSearch, fetchPageText } from './web-search.js'; // optional, for address lookup
//   const draft = await parseOrderRequest(groqClient, freeText, {
//     knownItems: items.map(i => ({ btk: i.BTK, name: i.Name })), // lets "item 1"-style refs resolve to real BTKs
//     searchItemCandidates: (text) => sb.from('items').select('BTK,Name')
//       .eq('warehouse_id', currentWarehouseId).ilike('Name', `%${text}%`).limit(5)
//       .then(({ data }) => (data || []).map(r => ({ btk: r.BTK, name: r.Name }))),
//     searchOtherWarehouses: (text) => sb.from('items').select('BTK,Name,warehouse_id,numberofitems')
//       .neq('warehouse_id', currentWarehouseId).ilike('Name', `%${text}%`).limit(5)
//       .then(({ data }) => (data || []).map(r => ({ btk: r.BTK, name: r.Name, warehouseId: r.warehouse_id, quantity: r.numberofitems }))),
//     webSearch, fetchPageText, // omit to skip address lookup entirely
//     fromAddress: { name: warehouseName, address: warehouseAddress }, // the app's own known data, not inferred
//   });
//   // draft: {
//   //   items: [{ reference, quantity, btk, matchedName, elsewhere }],
//   //   recipient: { name, address, confidence },
//   //   from: { name, address } | null,
//   // }

import { GROQ_MODELS } from './groq-client.js';

const EXTRACTION_SYSTEM_PROMPT = `You extract structured pack-order data from free-form text, which may be in English, Swedish, or Finnish (e.g. "plocka" = pick/pack). Respond with ONLY a JSON object, no prose, matching:
{
  "items": [{ "reference": string, "quantity": number }],
  "recipientName": string | null,
  "recipientAddressHint": string | null,
  "needsAddressLookup": boolean
}
"reference" is whatever the text used to identify an item (a BTK number, a name, or an ordinal like "item 1" — resolve ordinals against the numbered list of known items you're given, if one is provided). "quantity" defaults to 1 when the text doesn't say a number. "needsAddressLookup" is true when the text names a recipient but gives no address and asks (or implies) that one should be found.`;

export async function parseOrderRequest(groqClient, text, {
  knownItems = [],
  searchItemCandidates,
  searchOtherWarehouses,
  webSearch,
  fetchPageText,
  fromAddress = null,
  model = GROQ_MODELS.TEXT,
  reasoningEffort = 'medium',
} = {}) {
  if (!text || !text.trim()) throw new Error('parseOrderRequest: text is required');

  const itemsList = knownItems.length
    ? `Known items (reference by number or BTK):\n${knownItems.map((it, i) => `${i + 1}. ${it.btk} — ${it.name}`).join('\n')}`
    : 'No item catalog was provided — extract references exactly as given in the text.';

  const reply = await groqClient.chat({
    model,
    reasoningEffort,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: `${itemsList}\n\nText:\n${text}` },
    ],
  });

  const extracted = parseJsonReply(reply);
  const items = await Promise.all(extracted.items.map((entry) => resolveItem(entry, knownItems, searchItemCandidates, searchOtherWarehouses)));

  const draft = {
    items,
    recipient: {
      name: extracted.recipientName || null,
      address: extracted.recipientAddressHint || null,
      confidence: extracted.recipientAddressHint ? 'given' : 'unknown',
    },
    from: fromAddress || null,
  };

  if (extracted.needsAddressLookup && extracted.recipientName && webSearch && fetchPageText) {
    draft.recipient.address = await lookupAddress(extracted.recipientName, { webSearch, fetchPageText });
    draft.recipient.confidence = draft.recipient.address ? 'searched' : 'not_found';
  }

  return draft;
}

async function resolveItem(entry, knownItems, searchItemCandidates, searchOtherWarehouses) {
  const quantity = entry.quantity && entry.quantity > 0 ? entry.quantity : 1;

  const known = matchKnownItem(entry.reference, knownItems);
  if (known) return { ...entry, quantity, btk: known.btk, matchedName: known.name, elsewhere: null };

  if (looksLikeBtk(entry.reference)) {
    return { ...entry, quantity, btk: entry.reference.trim().toUpperCase(), matchedName: null, elsewhere: null };
  }

  if (searchItemCandidates) {
    const candidates = await searchItemCandidates(entry.reference);
    const match = bestCandidateMatch(entry.reference, candidates);
    if (match) return { ...entry, quantity, btk: match.btk, matchedName: match.name, elsewhere: null };
  }

  // Not found in this warehouse. Check whether it exists in another one — purely informational:
  // this order still belongs to one warehouse, so it's never used as the resolved btk.
  let elsewhere = null;
  if (searchOtherWarehouses) {
    const otherCandidates = await searchOtherWarehouses(entry.reference);
    elsewhere = bestCandidateMatch(entry.reference, otherCandidates);
  }

  return { ...entry, quantity, btk: null, matchedName: null, elsewhere };
}

// Exported standalone so the "model replied with prose/code-fences around the JSON anyway" path
// is testable without a real LLM call.
export function parseJsonReply(reply) {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('order-parser: model reply did not contain JSON');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.items)) throw new Error('order-parser: model reply missing items array');
  return parsed;
}

export function looksLikeBtk(reference) {
  return typeof reference === 'string' && /^BTK\d{6}$/i.test(reference.trim());
}

// Resolves "item 3" / "3" ordinals against the 1-indexed knownItems list, otherwise matches by
// exact BTK or name (case-insensitive).
export function matchKnownItem(reference, knownItems) {
  if (!reference || !knownItems.length) return null;
  const ref = reference.trim().toLowerCase();
  const ordinal = ref.match(/^item\s*(\d+)$/) || ref.match(/^(\d+)$/);
  if (ordinal) return knownItems[Number(ordinal[1]) - 1] || null;
  return knownItems.find((it) => it.btk?.toLowerCase() === ref || it.name?.toLowerCase() === ref) || null;
}

// Picks the closest candidate (from a live items-table search) to a free-text reference, by a
// simple word-overlap score. Exact BTK match short-circuits. Below the 0.4 threshold, treated as
// no match at all — better to leave an item unresolved for the user to fix than guess wrong.
export function bestCandidateMatch(reference, candidates) {
  if (!reference || !candidates || !candidates.length) return null;
  const ref = reference.trim().toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const btk = (candidate.btk || '').toLowerCase();
    if (btk === ref) return candidate;
    const score = nameSimilarity(ref, (candidate.name || '').toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.4 ? best : null;
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  const overlap = [...aTokens].filter((t) => bTokens.has(t)).length;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

async function lookupAddress(name, { webSearch, fetchPageText }) {
  const results = await webSearch(`${name} address contact`, { limit: 3 });
  for (const result of results) {
    try {
      const text = await fetchPageText(result.url, { maxChars: 3000 });
      const addressLine = guessAddressLine(text);
      if (addressLine) return addressLine;
    } catch {
      // that result didn't pan out — try the next one
    }
  }
  return null;
}

// Rough heuristic (a line containing a postal-code-then-city shape, e.g. "123 45 Stockholm" or
// "12345 Springfield") meant as a starting point for the user to correct, not an authoritative
// address parse. Deliberately narrower than "any digits" so it doesn't grab onto unrelated
// numbers in body text (a founding year, a phone number, etc).
export function guessAddressLine(text) {
  const line = text.split('\n').find((l) => /\b\d{3}\s?\d{2}\s+[A-ZÅÄÖ][a-zåäö]/.test(l) && l.length < 200);
  return line ? line.trim() : null;
}
