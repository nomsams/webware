// Turns free-text like "plocka BTK000012 och item 2 till Acme AB, sök upp adressen" into a
// structured pack-order draft: which items to pick, plus a recipient name and address — using an
// LLM (via groq-client.js) for the extraction, and optionally web-search.js to look up a
// recipient's address/phone when the text names them but gives no address.
//
// This is the actual feature behind the "box where we can write or paste something like
// 'plocka item 1 and item 2...'" request. STATUS: standalone, not wired into the Pack Order UI
// yet. Intended integration point: a free-text box above the existing recipient name/address
// fields in #pack-order-view — parseOrderRequest() returns a best-effort draft for the user to
// review/edit before Save Order. It never writes to the order or searches the web on its own;
// the caller decides what to do with the draft.
//
// Usage:
//   import { parseOrderRequest } from './order-parser.js';
//   import { webSearch, fetchPageText } from './web-search.js'; // optional, for address lookup
//   const draft = await parseOrderRequest(groqClient, freeText, {
//     knownItems: items.map(i => ({ btk: i.BTK, name: i.Name })), // lets "item 1"-style refs resolve to real BTKs
//     webSearch, fetchPageText, // omit to skip address lookup entirely
//   });
//   // draft: { items: [{ reference, quantity, btk }], recipient: { name, address, confidence } }

import { GROQ_MODELS } from './groq-client.js';

const EXTRACTION_SYSTEM_PROMPT = `You extract structured pack-order data from free-form text, which may be in English, Swedish, or Finnish (e.g. "plocka" = pick/pack). Respond with ONLY a JSON object, no prose, matching:
{
  "items": [{ "reference": string, "quantity": number }],
  "recipientName": string | null,
  "recipientAddressHint": string | null,
  "needsAddressLookup": boolean
}
"reference" is whatever the text used to identify an item (a BTK number, a name, or an ordinal like "item 1" — resolve ordinals against the numbered list of known items you're given, if one is provided). "needsAddressLookup" is true when the text names a recipient but gives no address and asks (or implies) that one should be found.`;

export async function parseOrderRequest(groqClient, text, {
  knownItems = [],
  webSearch,
  fetchPageText,
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
  const items = extracted.items.map((entry) => ({
    ...entry,
    btk: matchKnownItem(entry.reference, knownItems)?.btk ?? (looksLikeBtk(entry.reference) ? entry.reference.trim().toUpperCase() : null),
  }));

  const draft = {
    items,
    recipient: {
      name: extracted.recipientName || null,
      address: extracted.recipientAddressHint || null,
      confidence: extracted.recipientAddressHint ? 'given' : 'unknown',
    },
  };

  if (extracted.needsAddressLookup && extracted.recipientName && webSearch && fetchPageText) {
    draft.recipient.address = await lookupAddress(extracted.recipientName, { webSearch, fetchPageText });
    draft.recipient.confidence = draft.recipient.address ? 'searched' : 'not_found';
  }

  return draft;
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
