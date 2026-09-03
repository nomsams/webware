// Browser-side CORS-proxy client for fetching pages that don't send permissive CORS headers
// (used by web-search.js to reach DuckDuckGo and search-result pages).
//
// STATUS: wired into index.html — configureCorsProxy() is called once from the module bridge near
// the end of the page, so window.duckySearch/window.crawly (web-search.js) route through
// webware's own cors-proxy Edge Function when it's deployed, and the known external
// chikibriki-gated proxy otherwise (see KNOWN_EXTERNAL_PROXY_URL below) — so web search works even
// before webware's own function is deployed.
//
// Default path calls webware's own cors-proxy Supabase Edge Function
// (supabase/functions/cors-proxy) — deploy it and call configureCorsProxy() once (same
// dependency-injected shape as groq-client.js's createGroqClient) and corsFetch() uses it
// automatically, falling through to KNOWN_EXTERNAL_PROXY_URL below (always tried, no opt-in
// needed), then — only if allowPublicFallback is true — the fully-anonymous PUBLIC_FALLBACKS,
// then finally a direct fetch (works for hosts that already send CORS headers) if everything
// above isn't configured or fails.
//
// On "chikibriki": crawly and timeline (github.com/nomsams/crawly, /timeline — same author as
// webware) default their proxy key to the literal string "chikibriki" against a CORS-proxy Edge
// Function on Supabase project `onbkfqayveownervyktu` — a *different* project than webware's own,
// but the same author's, not a random public service. That value is hardcoded in cleartext in both
// of those public repos, so it was never actually secret — it functions as a conventional
// non-secret gate value, not unlike a public API identifier, and (being a shared public-utility
// function across that author's own projects) doesn't require a signed-in user of ITS project the
// way webware's own cors-proxy does. KNOWN_EXTERNAL_PROXY_URL below calls it directly with that
// key — a genuinely useful fallback for exactly the case where webware's own function isn't
// deployed yet, at the cost of that project's own logs seeing the URL/query in the clear whenever
// it's actually used (i.e. whenever webware's own function is skipped or fails). Webware's own
// cors-proxy function is NOT what this key protects, either — it requires a signed-in Supabase
// user, the same real protection groq-proxy uses for GROQ_API_KEY. If you want CORS_PROXY_KEY
// checked server-side too (defense in depth, optional), set it to match:
// `supabase secrets set CORS_PROXY_KEY=chikibriki`.
//
// Fully-anonymous public proxies (corsproxy.io, allorigins.win) are a separate, stricter tier —
// NOT used unless allowPublicFallback is true — passed per-call, or set as the running default via
// configureCorsProxy({allowPublicFallback}) or setAllowPublicFallback() (index.html wires this to
// Settings → AI Assistant → "Allow public CORS proxy fallback"). Those are truly unrelated third
// parties; failing the request instead of silently leaking to one is the safer default, opt in
// only if that trade-off is acceptable for your use case.
//
// Usage:
//   import { configureCorsProxy } from './cors-proxy.js';
//   configureCorsProxy({
//     supabaseUrl: SUPABASE_URL,
//     supabaseAnonKey: SUPABASE_ANON_KEY,
//     getAccessToken: async () => (await sb.auth.getSession()).data.session?.access_token,
//   });
//   const res = await corsFetch('https://html.duckduckgo.com/html/?q=...');

export const DEFAULT_PROXY_KEY = 'chikibriki';
export const KNOWN_EXTERNAL_PROXY_URL = 'https://onbkfqayveownervyktu.supabase.co/functions/v1/cors-proxy';

const PUBLIC_FALLBACKS = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

let ownProxy = null; // { endpoint, supabaseAnonKey, getAccessToken, proxyKey } | null
let allowPublicFallbackDefault = false;

export function configureCorsProxy({ supabaseUrl, supabaseAnonKey, getAccessToken, proxyKey = DEFAULT_PROXY_KEY, allowPublicFallback } = {}) {
  if (allowPublicFallback !== undefined) allowPublicFallbackDefault = !!allowPublicFallback;
  if (!supabaseUrl) { ownProxy = null; return; }
  if (!supabaseAnonKey || !getAccessToken) {
    throw new Error('configureCorsProxy: supabaseAnonKey and getAccessToken are required alongside supabaseUrl');
  }
  ownProxy = {
    endpoint: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/cors-proxy`,
    supabaseAnonKey,
    getAccessToken,
    proxyKey,
  };
}

// Lets a caller flip the public-proxy-fallback default at runtime (e.g. a Settings toggle) without
// re-supplying the rest of configureCorsProxy's args.
export function setAllowPublicFallback(value) {
  allowPublicFallbackDefault = !!value;
}

// Tries webware's own cors-proxy function first (if configured), then the known external
// chikibriki-gated proxy (always tried — see KNOWN_EXTERNAL_PROXY_URL above; set
// `useKnownExternalProxy: false` to skip it), then — only when allowPublicFallback is true,
// either passed per-call or via configureCorsProxy()/setAllowPublicFallback() — each fully-public
// proxy in order, then finally a direct fetch. Returns the first response with res.ok; throws the
// last error/status if every attempt fails.
export async function corsFetch(targetUrl, options = {}, { fetchImpl = fetch, allowPublicFallback = allowPublicFallbackDefault, useKnownExternalProxy = true } = {}) {
  const attempts = [];
  if (ownProxy) {
    attempts.push(async () => {
      const accessToken = await ownProxy.getAccessToken();
      if (!accessToken) throw new Error('corsFetch: no active session for the cors-proxy function');
      return fetchImpl(`${ownProxy.endpoint}?url=${encodeURIComponent(targetUrl)}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          'Authorization': `Bearer ${accessToken}`,
          'apikey': ownProxy.supabaseAnonKey,
          'x-proxy-key': ownProxy.proxyKey,
        },
      });
    });
  }
  if (useKnownExternalProxy) {
    attempts.push(() => fetchImpl(`${KNOWN_EXTERNAL_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, {
      ...options,
      headers: { ...(options.headers || {}), 'x-proxy-key': DEFAULT_PROXY_KEY },
    }));
  }
  if (allowPublicFallback) {
    for (const build of PUBLIC_FALLBACKS) {
      attempts.push(() => fetchImpl(build(targetUrl), options));
    }
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
  ownProxy = null;
  allowPublicFallbackDefault = false;
}
