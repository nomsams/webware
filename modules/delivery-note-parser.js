// Turns a photo of a delivery note ("följsedel") into a structured draft — supplier/manufacturer,
// warehouse delivery address, and line items (name, item number, quantity) — using a multimodal
// Groq model (GROQ_MODELS.MULTIMODAL) to read the photo directly, rather than a separate
// Tesseract-OCR-then-text-cleanup pass the way the scanner's "📝 Scan Text" capture works
// (aiHandleOcrCleanup in index.html): a vision model reads layout/context along with the text
// (which column is quantity vs. item number, which block is the ship-to address vs. the
// supplier's own letterhead address), which flattened OCR text alone loses.
//
// STATUS: wired in, as the scanner modal's "🧾 Delivery Note" button — it captures a photo,
// converts it to a data: URL (downscaled — see index.html's scannerCaptureDeliveryNote()), and
// calls parseDeliveryNoteImage(). index.html then
// resolves each line against globalInventory entirely offline (via findByPartNumber/findByName
// callbacks backed by its own buildPartNumberIndex/findItemByAnyPartNumber and aiFuzzyFindItem)
// and walks the user through a two-step review — matched items' quantity updates first, then (only
// once those are handled) any unmatched lines as new-item proposals, each editable — before
// anything is written to Supabase, exactly as requested. Both writes (stock adjustments and new
// item inserts) share one activity_log batch_id so the whole delivery note can be undone as one
// action via the existing undoImportBatch() (see schema_activity_log_batch_id.sql).
//
// Usage:
//   import { parseDeliveryNoteImage, resolveDeliveryNoteItems } from './delivery-note-parser.js';
//   const draft = await parseDeliveryNoteImage(groqClient, imageDataUrl);
//   // draft: { manufacturer: string|null, warehouseAddress: string|null,
//   //          items: [{ name, itemNumber, quantity }] }
//   const resolved = resolveDeliveryNoteItems(draft.items, {
//     findByPartNumber: (itemNumber) => ({ btk, name, currentQty }) | null,
//     findByName: (name) => ({ btk, name, currentQty }) | null, // fuzzy fallback, confident matches only
//   });
//   // resolved: {
//   //   matched: [{ btk, name, currentQty, deliveredQty, newQty, source: 'part_number'|'name', reference, referenceItemNumber }],
//   //   unmatched: [{ name, itemNumber, quantity }],
//   // }

import { GROQ_MODELS } from './groq-client.js';
import { extractJsonObjects, lastJsonObject } from './json-extract.js';

export const DELIVERY_NOTE_SYSTEM_PROMPT = `You read a delivery note / packing slip ("följsedel"), possibly in Swedish, English, or a mix of both, from a photo. Respond with ONLY a JSON object, no prose, matching:
{
  "manufacturer": string | null,
  "warehouseAddress": string | null,
  "items": [{ "name": string, "itemNumber": string | null, "quantity": number }]
}
"manufacturer" is the supplier/sender's company name shown on the note. "warehouseAddress" is the delivery/recipient ("ship to"/"leverans till") address the goods are being sent to — not the sender's own letterhead address. "itemNumber" is the manufacturer's own part/article number for that line if the note actually shows one, otherwise null — never invent one. "quantity" is the delivered quantity for that line (only default to 1 if the note truly gives no number at all for an otherwise clear line item). If the image isn't a delivery note, or nothing readable is on it, respond with {"manufacturer":null,"warehouseAddress":null,"items":[]} instead of guessing.`;

// 8192 (matches order-parser.js's own default, and groq-proxy's MAX_COMPLETION_TOKENS ceiling): a
// delivery note can carry many line items, and — same risk as order-parser.js's own extraction —
// a reasoning-capable model's internal reasoning tokens count against this same budget as the
// visible JSON answer, so a low ceiling risks the answer arriving truncated.
export async function parseDeliveryNoteImage(groqClient, imageDataUrl, { model = GROQ_MODELS.MULTIMODAL, reasoningEffort, maxTokens = 8192 } = {}) {
  if (!imageDataUrl) throw new Error('parseDeliveryNoteImage: imageDataUrl is required');
  const reply = await groqClient.chat({
    model,
    reasoningEffort,
    maxTokens,
    messages: [
      { role: 'system', content: DELIVERY_NOTE_SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: 'Extract this delivery note.' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ] },
    ],
  });
  return parseDeliveryNoteReply(reply);
}

// Exported standalone so the "model replied with prose/code-fences around the JSON anyway" path
// is testable without a real vision call — same approach as order-parser.js's parseJsonReply.
export function parseDeliveryNoteReply(reply) {
  // Not a greedy first-"{"-to-last-"}" span: any brace after the JSON made that invalid (see
  // json-extract.js). The last object that has an items array is the answer.
  const objects = extractJsonObjects(reply);
  if (!objects.length) throw new Error('delivery-note-parser: model reply did not contain JSON');
  const parsed = lastJsonObject(reply, (o) => Array.isArray(o.items));
  if (!parsed) throw new Error('delivery-note-parser: model reply missing items array');
  return {
    manufacturer: parsed.manufacturer || null,
    warehouseAddress: parsed.warehouseAddress || null,
    items: parsed.items
      .map((it) => {
        const hasQty = it && it.quantity !== undefined && it.quantity !== null;
        const qtyNum = hasQty ? Number(it.quantity) : NaN;
        return {
          name: (it && typeof it.name === 'string') ? it.name.trim() : '',
          itemNumber: (it && it.itemNumber) ? String(it.itemNumber).trim() : null,
          // A real 0 (e.g. a backordered line) must survive as 0, not be treated the same as "no
          // number given at all" — only a missing/non-numeric/negative reading falls back to 1.
          quantity: (Number.isFinite(qtyNum) && qtyNum >= 0) ? Math.round(qtyNum) : 1,
        };
      })
      .filter((it) => it.name),
  };
}

// Resolves each extracted line against the loaded inventory — a part number match is the strong
// signal (a supplier's own article number either matches an existing item's itemnumber/2/3 exactly
// or it doesn't), so it's tried first and only falls back to a name-based fuzzy match when no item
// number was read at all or it didn't match anything. Pure/offline: both finder callbacks are
// dependency-injected (index.html supplies buildPartNumberIndex/findItemByAnyPartNumber for the
// first, aiFuzzyFindItem — accepting only a *confident* match, never a "did you mean?" guess, since
// this runs unattended before the user has seen anything — for the second), so this is testable
// without a live inventory or a DOM, same shape as order-parser.js's resolveItem().
export function resolveDeliveryNoteItems(items, { findByPartNumber, findByName } = {}) {
  const matched = [];
  const unmatched = [];
  for (const it of items) {
    let hit = null;
    let source = null;
    if (it.itemNumber && findByPartNumber) {
      hit = findByPartNumber(it.itemNumber);
      if (hit) source = 'part_number';
    }
    if (!hit && findByName) {
      hit = findByName(it.name);
      if (hit) source = 'name';
    }
    if (hit) {
      const currentQty = Number(hit.currentQty) || 0;
      matched.push({
        btk: hit.btk,
        name: hit.name,
        currentQty,
        deliveredQty: it.quantity,
        newQty: currentQty + it.quantity,
        source,
        reference: it.name,
        referenceItemNumber: it.itemNumber,
      });
    } else {
      unmatched.push(it);
    }
  }
  return { matched, unmatched };
}
