// DuckDuckGo web search + page-text extraction, for feeding search results to an LLM (e.g.
// order-parser.js looking up a recipient's address).
//
// The search logic is ported from https://github.com/nomsams/timeline — that's where the actual
// DuckDuckGo search lives, despite the name "crawly" sounding like the obvious source: crawly
// itself takes explicit URLs, not a search query, and only does the Readability-based page
// cleanup step (mirrored here in fetchPageText/extractWithReadability).
//
// STATUS: standalone, not wired into index.html yet. Depends on modules/cors-proxy.js for the
// actual network calls (DuckDuckGo doesn't send CORS headers for direct browser fetches).
//
// Optional progressive enhancement: if a `Readability` global is present (load
// https://cdn.jsdelivr.net/npm/@mozilla/readability/Readability.js via a <script> tag, same as
// crawly does), fetchPageText() uses it for higher-quality article extraction. Without it, falls
// back to a dependency-free regex strip (stripHtmlToText) — no new dependency required to use
// this module as-is.
//
// webSearch()/fetchPageText() need a browser (DOMParser) — only the pure string-logic pieces
// (resolveDuckDuckGoLink, stripHtmlToText) are unit tested in Node; the DOM-dependent parts are
// meant to be exercised manually once this is wired into the app.

import { corsFetch } from './cors-proxy.js';

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';

export async function webSearch(query, { limit = 5 } = {}) {
  const url = `${DDG_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const res = await corsFetch(url);
  const html = await res.text();
  return parseDuckDuckGoResults(html).slice(0, limit);
}

// DuckDuckGo's HTML endpoint wraps result links in a redirect
// (//duckduckgo.com/l/?uddg=<encoded-real-url>&...) — unwrap it to the actual target.
export function parseDuckDuckGoResults(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results = [];
  doc.querySelectorAll('.result__a').forEach((a) => {
    const href = resolveDuckDuckGoLink(a.getAttribute('href'));
    if (!href || !href.startsWith('http') || href.includes('duckduckgo.com/y.js')) return;
    const snippetEl = a.closest('.result')?.querySelector('.result__snippet');
    results.push({
      title: a.textContent.trim(),
      url: href,
      snippet: snippetEl ? snippetEl.textContent.trim() : '',
    });
  });
  return results;
}

export function resolveDuckDuckGoLink(href) {
  if (!href) return null;
  if (href.includes('uddg=')) {
    try {
      return decodeURIComponent(new URL(href, 'https://duckduckgo.com').searchParams.get('uddg'));
    } catch {
      return null;
    }
  }
  return href;
}

// Fetches a page and reduces it to LLM-friendly plain text.
export async function fetchPageText(url, { maxChars = 8000 } = {}) {
  const res = await corsFetch(url);
  const html = await res.text();
  const text = typeof Readability !== 'undefined' ? extractWithReadability(html, url) : stripHtmlToText(html);
  return text.slice(0, maxChars);
}

function extractWithReadability(html, url) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = doc.createElement('base');
  base.href = url;
  doc.head.appendChild(base);
  const article = new Readability(doc).parse();
  return article?.textContent?.trim() || stripHtmlToText(html);
}

// Dependency-free fallback: strips scripts/styles/comments/tags via regex, decodes the common
// HTML entities, collapses whitespace. Good enough context for an LLM without pulling in a
// parser library.
export function stripHtmlToText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}
