// Browser-side CORS-proxy wrapper for fetching pages that don't send permissive CORS headers
// (used by web-search.js to reach DuckDuckGo and search-result pages). Ported from the
// primary-then-fallback proxy chain used in https://github.com/nomsams/crawly and
// https://github.com/nomsams/timeline.
//
// STATUS: standalone, not wired into index.html yet.
//
// SECURITY NOTE on "chikibriki": crawly and timeline both default their proxy key to the literal
// string "chikibriki" against a specific Supabase Edge Function
// (onbkfqayveownervyktu.supabase.co/functions/v1/cors-proxy) whenever no key is typed into their
// UI. That value is hardcoded in cleartext in two public repos, so treat it as an
// already-exposed, low-value shared secret, not something to protect — and not something to
// silently depend on either, since it points at a different Supabase project than webware's own,
// outside this app's control. It is deliberately NOT wired in as a default here. If you still
// control that project and want parity with crawly/timeline, call:
//   configureCorsProxy(supabaseCorsProxy('https://onbkfqayveownervyktu.supabase.co', 'chikibriki'))
// Out of the box this module skips straight to the public fallback proxies below.

const PUBLIC_FALLBACKS = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

let primaryProxy = null; // { buildUrl(url), headers } | null

// buildUrl: (targetUrl) => proxiedUrl. headers: extra headers to send with the proxied request
// (e.g. an auth key). Pass no args (or a falsy buildUrl) to clear the primary proxy.
export function configureCorsProxy({ buildUrl, headers = {} } = {}) {
  primaryProxy = buildUrl ? { buildUrl, headers } : null;
}

// Convenience builder matching crawly/timeline's own primary proxy shape:
// <supabaseUrl>/functions/v1/cors-proxy?url=<target>, key sent as the x-proxy-key header.
export function supabaseCorsProxy(supabaseUrl, key) {
  return {
    buildUrl: (url) => `${supabaseUrl.replace(/\/$/, '')}/functions/v1/cors-proxy?url=${encodeURIComponent(url)}`,
    headers: { 'x-proxy-key': key },
  };
}

// Tries the configured primary proxy first (if any), then each public fallback in order, then
// finally a direct fetch (works for hosts that already send CORS headers). Returns the first
// response with res.ok; throws the last error/status if every attempt fails.
export async function corsFetch(targetUrl, options = {}, { fetchImpl = fetch } = {}) {
  const attempts = [];
  if (primaryProxy) {
    attempts.push(() => fetchImpl(primaryProxy.buildUrl(targetUrl), {
      ...options,
      headers: { ...(options.headers || {}), ...primaryProxy.headers },
    }));
  }
  for (const build of PUBLIC_FALLBACKS) {
    attempts.push(() => fetchImpl(build(targetUrl), options));
  }
  attempts.push(() => fetchImpl(targetUrl, options));

  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await attempt();
      if (res.ok) return res;
      lastError = new Error(`corsFetch: HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('corsFetch: all proxies failed');
}

// Exposed for tests / callers that want to reset state between uses.
export function _resetCorsProxy() {
  primaryProxy = null;
}
