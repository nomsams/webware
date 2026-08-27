// Only the DOM-free pieces of web-search.js are unit tested here — webSearch()/fetchPageText()/
// parseDuckDuckGoResults() need a browser DOMParser and are meant to be exercised manually once
// this module is wired into the app.
//
// Run: node --test modules/tests/web-search.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDuckDuckGoLink, stripHtmlToText } from '../web-search.js';

test('resolveDuckDuckGoLink unwraps a DuckDuckGo redirect to the real URL', () => {
  const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1&rut=abc';
  assert.equal(resolveDuckDuckGoLink(wrapped), 'https://example.com/page?a=1');
});

test('resolveDuckDuckGoLink passes plain hrefs through unchanged', () => {
  assert.equal(resolveDuckDuckGoLink('https://example.com/'), 'https://example.com/');
});

test('resolveDuckDuckGoLink returns null for missing href', () => {
  assert.equal(resolveDuckDuckGoLink(null), null);
});

test('stripHtmlToText drops scripts, styles, and comments', () => {
  const html = '<html><head><style>.a{color:red}</style></head><body><script>evil()</script><!-- hi --><p>Hello world</p></body></html>';
  assert.equal(stripHtmlToText(html), 'Hello world');
});

test('stripHtmlToText turns block-level closing tags into line breaks', () => {
  const html = '<div>Line one</div><div>Line two</div>';
  assert.equal(stripHtmlToText(html), 'Line one\nLine two');
});

test('stripHtmlToText decodes common HTML entities', () => {
  const html = '<p>Tom &amp; Jerry say &quot;hi&quot; &lt;3</p>';
  assert.equal(stripHtmlToText(html), 'Tom & Jerry say "hi" <3');
});

test('stripHtmlToText collapses runs of whitespace and drops empty lines', () => {
  const html = '<p>  spaced   out   text  </p><p></p><p>next</p>';
  assert.equal(stripHtmlToText(html), 'spaced out text\nnext');
});
