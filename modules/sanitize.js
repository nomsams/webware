// Input sanitising for everything the app writes to the database or hands to another program. Pure - no DOM,
// no Supabase - same convention as the other modules, so every rule here is unit-tested.
//
// STATUS: wired in (index.html: itemToSupabaseRow, saving a Pack Order, warehouse / manufacturer / display-name
// edits, messages, and the add-on bridge's URL setting). The database enforces its own limits too
// (supabase/schema_security_hardening.sql) - this is the first line, that is the last one, and a hand-written
// API call only ever meets the second.
//
// Escaping for HTML is a different job and stays where the HTML is built (escapeHtml in index.html): this module
// decides what is allowed to be STORED, not how it is shown.
//
// What "clean" means for free text:
//   * control characters are removed (NUL and friends break CSV, logs, and some databases; keep newline and tab
//     only where a field is genuinely multi-line);
//   * zero-width and bidirectional-override characters are removed - "RLO" text can make a part number or a
//     recipient name read as something else than what is stored (the "Trojan Source" trick), and zero-width
//     characters make two visibly identical names different;
//   * Unicode is normalised (NFC), so an accented letter typed two ways is one value;
//   * single-line fields lose line breaks; everything is trimmed and length-capped without cutting a character in half.
//
// This file is deliberately pure ASCII: the invisible characters it removes are built from code points below, so
// none of them can hide inside the source of the very function that is meant to catch them.
//
// Usage:
//   import { cleanText, cleanUrl, cleanInt, safeBaseUrl } from './sanitize.js';
//   cleanText('  Part 123 ', { max: 300 })                 // -> 'Part 123'
//   cleanUrl('example.com/x')                              // -> 'https://example.com/x'
//   cleanUrl('javascript:alert(1)')                        // -> ''
//   cleanInt('12abc', { min: 0, max: 99, fallback: 0 })    // -> 12

// A global character class from [low, high?] code point ranges (none of these is '-', ']', '^' or a backslash).
const classOf = (ranges) => new RegExp(
  '[' + ranges.map(([lo, hi]) => String.fromCharCode(lo) + (hi ? '-' + String.fromCharCode(hi) : '')).join('') + ']', 'g');

// C0 + DEL + C1 controls, minus tab / line feed / carriage return (handled separately below).
const CONTROL_CHARS = classOf([[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x9F]]);
// zero-width space/joiners, LRM/RLM, the line/paragraph separators (they act as line breaks in JS and some parsers),
// bidi embeddings/overrides (U+202A-202E) and isolates (U+2066-2069), word joiner + invisible math operators, BOM.
const INVISIBLE_CHARS = classOf([[0x200B, 0x200F], [0x2028, 0x2029], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x2069], [0xFEFF]]);

/**
 * @param {unknown} value  anything; null/undefined become ''
 * @param {{max?: number, multiline?: boolean}} [opts]  max is in UTF-16 code units, like the database's char_length
 *   after normalisation; multiline keeps line breaks (normalised to \n) and tabs.
 */
export function cleanText(value, { max = 500, multiline = false } = {}) {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.normalize('NFC').replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\t\r\n]+/g, ' ');
  s = s.trim();
  if (s.length > max) {
    s = s.slice(0, max);
    // never leave half of a surrogate pair (an emoji) dangling at the cut
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s;
}

/**
 * A link a person typed or a CSV carried, made safe to store and later render as a clickable href: http(s) only.
 * A bare domain ("example.com/page") becomes https://example.com/page - what the item page already did when
 * showing it. Anything else - javascript:, data:, vbscript:, file:, a made-up scheme, or just words - is '' (dropped),
 * never repaired into something that still runs.
 */
export function cleanUrl(value, { max = 2000 } = {}) {
  // cleanText has already removed every control/invisible character (so "java<TAB>script:" cannot survive as
  // "javascript:" later); a space inside a link becomes %20 rather than silently vanishing.
  const raw = cleanText(value, { max: max + 100 }).replace(/ /g, '%20');
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    // no scheme: only accept something that looks like a host, optionally followed by a path
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i.test(candidate)) return '';
    candidate = `https://${candidate}`;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\d/.test(candidate) && !/^https?:/i.test(candidate)) {
    // "example.com:8080/x" parses as scheme "example.com" - treat host:port as a bare domain instead
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{1,5}(?:[/?#].*)?$/i.test(candidate)) return '';
    candidate = `https://${candidate}`;
  }
  let url;
  try { url = new URL(candidate); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return ''; // https://trusted.com@evil.com/ spoofing
  return candidate.length > max ? '' : candidate;
}

/** An integer from messy input ("12abc", "  7 ", 3.9) clamped into [min, max]; `fallback` when there is no number at all. */
export function cleanInt(value, { min = 0, max = 1000000, fallback = 0 } = {}) {
  const n = parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The add-on bridge sends a bearer token to whatever URL is configured, so the URL has to be one that cannot leak
 * it: https anywhere, or plain http only to this very machine (127.0.0.1 / localhost / [::1]), never to a remote host
 * in the clear, never with credentials, a path, a query or a fragment in it. Returns the bare origin, or null.
 */
export function safeBaseUrl(value) {
  const raw = cleanText(value, { max: 300 });
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && loopback) return url.origin;
  return null;
}
