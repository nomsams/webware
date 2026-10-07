// Run: node --test modules/tests/sanitize.test.js
// ASCII-only source: every invisible/odd character under test is built from its code point, so it cannot be
// lost or silently altered by an editor, and nothing invisible hides in this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, cleanUrl, cleanInt, safeBaseUrl } from '../sanitize.js';

const ch = (...cps) => String.fromCodePoint(...cps);
const RLO = ch(0x202E), LRI = ch(0x2066), PDI = ch(0x2069), ZWSP = ch(0x200B), ZWJ = ch(0x200D), BOM = ch(0xFEFF);
const LS = ch(0x2028), PS = ch(0x2029), NUL = ch(0), BEL = ch(7), ESC = ch(0x1B), DEL = ch(0x7F), NEL = ch(0x85);
const E_ACUTE = ch(0xE9), COMBINING_ACUTE = ch(0x301), GRIN = ch(0x1F600);

// -- cleanText ---------------------------------------------------------------------------------
test('cleanText: null/undefined are empty, numbers become text', () => {
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(42), '42');
});

test('cleanText strips control characters but keeps normal text', () => {
  assert.equal(cleanText(`Part${NUL} 12${BEL}${ESC}3`), 'Part 123');
  assert.equal(cleanText(`P${ch(0xE4)}rt ${ch(0xD6)} 123`), `P${ch(0xE4)}rt ${ch(0xD6)} 123`);
  assert.equal(cleanText(`del${DEL}ete${NEL}`), 'delete');
});

test('cleanText strips bidi overrides and zero-width characters (Trojan Source / look-alike names)', () => {
  assert.equal(cleanText(`invoice${RLO}gnp.exe`), 'invoicegnp.exe');
  assert.equal(cleanText(`A${ZWSP}B${ZWJ}C${BOM}`), 'ABC');
  assert.equal(cleanText(`x${LRI}y${PDI}z`), 'xyz');
  assert.equal(cleanText(`a${LS}b${PS}c`), 'abc');
});

test('cleanText normalises Unicode so one name is one value', () => {
  assert.equal(cleanText(`e${COMBINING_ACUTE}`), E_ACUTE);
});

test('cleanText: a single-line field loses line breaks and tabs', () => {
  assert.equal(cleanText('a\r\nb\nc\td'), 'a b c d');
  assert.equal(cleanText('  padded  '), 'padded');
});

test('cleanText: a multi-line field keeps its breaks (normalised) and tabs', () => {
  assert.equal(cleanText('a\r\nb\rc\td', { multiline: true }), 'a\nb\nc\td');
  assert.equal(cleanText(`a${NUL}\nb`, { multiline: true }), 'a\nb');
});

test('cleanText caps the length', () => {
  assert.equal(cleanText('abcdef', { max: 3 }), 'abc');
  assert.equal(cleanText('abc  def', { max: 4 }), 'abc'); // the trailing space left by the cut is trimmed
});

test('cleanText never cuts an emoji in half', () => {
  const s = `ab${GRIN}cd`; // the emoji is two UTF-16 units
  assert.equal(cleanText(s, { max: 3 }), 'ab');
  assert.equal(cleanText(s, { max: 4 }), `ab${GRIN}`);
});

test('cleanText leaves the "None" placeholder alone', () => {
  assert.equal(cleanText('None'), 'None');
});

// -- cleanUrl ----------------------------------------------------------------------------------
test('cleanUrl accepts http(s) and turns a bare domain into https', () => {
  assert.equal(cleanUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(cleanUrl('http://example.com'), 'http://example.com');
  assert.equal(cleanUrl('example.com'), 'https://example.com');
  assert.equal(cleanUrl('  www.example.se/produkt/1  '), 'https://www.example.se/produkt/1');
  assert.equal(cleanUrl('example.com:8080/x'), 'https://example.com:8080/x');
});

test('cleanUrl drops every script-bearing or unknown scheme', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd',
    'ftp://example.com', 'blob:https://example.com/x', '  javascript:alert(1)']) {
    assert.equal(cleanUrl(bad), '', bad);
  }
});

test('cleanUrl defeats control-character smuggling in the scheme', () => {
  assert.equal(cleanUrl('java\tscript:alert(1)'), '');
  assert.equal(cleanUrl('java\nscript:alert(1)'), '');
  assert.equal(cleanUrl(`${ch(1)}javascript:alert(1)`), '');
  assert.equal(cleanUrl(`java${ZWSP}script:alert(1)`), '');
});

test('cleanUrl drops credentials-in-URL spoofing, plain words and junk', () => {
  assert.equal(cleanUrl('https://trusted.com@evil.com/'), '');
  assert.equal(cleanUrl('not a url'), '');
  assert.equal(cleanUrl('hello'), '');
  assert.equal(cleanUrl(''), '');
  assert.equal(cleanUrl(null), '');
});

test('cleanUrl rejects an over-long link rather than truncating it into a different one', () => {
  assert.equal(cleanUrl('https://example.com/' + 'a'.repeat(3000)), '');
});

// -- cleanInt ----------------------------------------------------------------------------------
test('cleanInt parses, clamps and falls back', () => {
  assert.equal(cleanInt('12abc'), 12);
  assert.equal(cleanInt('  7 '), 7);
  assert.equal(cleanInt(3.9), 3);
  assert.equal(cleanInt('-5', { min: 0 }), 0);
  assert.equal(cleanInt('999999999', { max: 100 }), 100);
  assert.equal(cleanInt('abc', { fallback: 9 }), 9);
  assert.equal(cleanInt(null, { fallback: 4 }), 4);
});

// -- safeBaseUrl -------------------------------------------------------------------------------
test('safeBaseUrl allows https anywhere and plain http only to this machine', () => {
  assert.equal(safeBaseUrl('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(safeBaseUrl('http://localhost:8765/'), 'http://localhost:8765');
  assert.equal(safeBaseUrl('http://[::1]:8765'), 'http://[::1]:8765');
  assert.equal(safeBaseUrl('https://192.168.50.4:8766'), 'https://192.168.50.4:8766');
});

test('safeBaseUrl refuses anything that could leak the bearer token', () => {
  for (const bad of ['http://192.168.50.4:8766', 'http://evil.example', 'ftp://127.0.0.1', 'javascript:alert(1)',
    'https://user:pw@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#x', 'nonsense', '', null]) {
    assert.equal(safeBaseUrl(bad), null, String(bad));
  }
});

test('safeBaseUrl: a look-alike host is not loopback', () => {
  assert.equal(safeBaseUrl('http://127.0.0.1.evil.com:8765'), null);
  assert.equal(safeBaseUrl('http://localhost.evil.com'), null);
});
