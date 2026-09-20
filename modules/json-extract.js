// Pulls JSON objects out of free-form model output — a reply that wraps its JSON in prose or a code
// fence, shows a draft before the real answer, or thinks aloud with a brace or two first.
//
// STATUS: wired in — order-parser.js and delivery-note-parser.js use it for their replies, and
// index.html's AI assistant uses it (as window.extractJsonObjects, via the module bridge) to read the
// action a reply asks for.
//
// Why not one regex: the parsers used /\{[\s\S]*\}/, which runs from the FIRST "{" to the LAST "}" in
// the whole reply. Anything after the JSON that contains a brace ("…as requested. {see note}") — or a
// stray "{" in the prose before it — made that span invalid JSON and the whole reply was rejected,
// although the answer was sitting right there. This scans instead: from each "{" it finds the matching
// "}" (skipping braces inside strings, honouring escapes) and keeps the piece only if it really parses.
//
// Only top-level objects are returned, in order of appearance; an object nested inside another is part
// of its parent. Callers pick the one they want — typically the LAST one with the field they need,
// since a model that quotes a draft and then answers puts its answer at the end.

// Index of the "}" that closes the "{" at `start`, or -1 if it never closes.
function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++; // skip whatever is escaped, so \" doesn't end the string
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function extractJsonObjects(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    const end = findMatchingBrace(text, start);
    if (end !== -1) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          found.push(parsed);
          i = end + 1;
          continue;
        }
      } catch {
        // Balanced braces but not JSON (prose like "{see note}") — keep looking after this brace.
      }
    }
    i = start + 1;
  }
  return found;
}

// The last extracted object satisfying `accept`, or null.
export function lastJsonObject(text, accept = () => true) {
  const objects = extractJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) if (accept(objects[i])) return objects[i];
  return null;
}
