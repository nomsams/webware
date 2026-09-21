// Re-attaches kit recipe lines to items by ITEM NUMBER, for when the items they pointed at were
// deleted and created again under new BTK numbers (a re-import, the Visma import's wipe of Best, ...).
//
// Why this is needed: kit_items.btk has a foreign key to items.btk with ON DELETE CASCADE, so the
// moment an item row is deleted every kit line that pointed at it is deleted with it. The kit itself
// survives, but empty. A BTK is only a system-assigned label and is never reused for the "same" item
// after a re-import, so the only way to find the item again is what the item IS: its item numbers
// (Item #3 holds Visma's own article number, the most stable of them; #1/#2 the manufacturer's).
//
// No Supabase/DOM access — same convention as the other modules; index.html snapshots the lines before
// a wipe and writes the result back afterwards.
//
// Usage:
//   import { relinkKitLines } from './kit-relink.js';
//   const { links, unmatched } = relinkKitLines(lines, items);
//   // lines: [{ kit_id, quantity, itemnumber, itemnumber2, itemnumber3, manufacturer, name? }]
//   //        — the identity the item had when the line was saved
//   // items: [{ btk, itemnumber, itemnumber2, itemnumber3, manufacturer }] — what exists now
//   // links: [{ kit_id, btk, quantity }] one per (kit, item), quantities added up
//   // unmatched: [{ line, reason: 'none' | 'ambiguous' }]

// A number that can say something about identity. The 444-prefixed numbers are synthetic per-row
// fillers, not real part numbers (see the standing rule about not treating them as identity), and 'None'
// is how the app spells "empty".
export function isRealItemNumber(value) {
  const s = String(value ?? '').trim();
  if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return false;
  if (/^444/.test(s)) return false;
  return true;
}

const norm = (v) => String(v ?? '').trim().toUpperCase();
const NUMBER_FIELDS = ['itemnumber3', 'itemnumber', 'itemnumber2']; // most to least stable

export function relinkKitLines(lines, items) {
  // every real number an item carries, in any of the three slots (which slot a number ends up in is
  // inconsistent across entries) -> the items carrying it
  const index = new Map();
  for (const item of items || []) {
    for (const f of NUMBER_FIELDS) {
      if (!isRealItemNumber(item[f])) continue;
      const key = norm(item[f]);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(item);
    }
  }

  const merged = new Map(); // "kit|btk" -> link
  const unmatched = [];
  for (const line of lines || []) {
    let hit = null;
    let sawAmbiguous = false;
    for (const f of NUMBER_FIELDS) {
      if (!isRealItemNumber(line[f])) continue;
      const candidates = [...(index.get(norm(line[f])) || [])];
      if (!candidates.length) continue;
      if (candidates.length === 1) { hit = candidates[0]; break; }
      // Several items share the number (an "oil filter cartridge" that fits many pumps): the
      // manufacturer can settle it; if it can't, a later number of the same line still might.
      const sameMaker = isRealItemNumber(line.manufacturer)
        ? candidates.filter((c) => norm(c.manufacturer) === norm(line.manufacturer))
        : [];
      if (sameMaker.length === 1) { hit = sameMaker[0]; break; }
      sawAmbiguous = true;
    }
    if (!hit) { unmatched.push({ line, reason: sawAmbiguous ? 'ambiguous' : 'none' }); continue; }
    const key = `${line.kit_id}|${hit.btk}`;
    const qty = Number(line.quantity) || 0;
    const prev = merged.get(key);
    if (prev) prev.quantity += qty; else merged.set(key, { kit_id: line.kit_id, btk: hit.btk, quantity: qty });
  }
  return { links: [...merged.values()], unmatched };
}
