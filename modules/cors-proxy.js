// Browser-side CORS-proxy client for fetching pages that don't send permissive CORS headers
// (used by web-search.js to reach DuckDuckGo and search-result pages).
//
// STATUS: standalone, not wired into index.html yet.
//
// Default path calls webware's own cors-proxy Supabase Edge Function
// (supabase/functions/cors-proxy) — deploy it and call configureCorsProxy() once (same
// dependency-injected shape as groq-client.js's createGroqClient) and corsFetch() uses it
// automatically, falling back to public proxies (corsproxy.io, allorigins.win) and finally a
// direct fetch if it isn't configured or fails.
//
// On "chikibriki": crawly and timeline (github.com/nomsams/crawly, /timeline) default their
// proxy key to the literal string "chikibriki" against a CORS-proxy Edge Function on a *different*
// Supabase project than webware's own. That value is hardcoded in cleartext in both of those
// public repos, so it was never actually secret — it functions as a conventional non-secret gate
// value, not unlike a public API identifier. DEFAULT_PROXY_KEY below keeps that same convention
// (sent as the x-proxy-key header) for parity, but it is NOT what protects webware's own
// cors-proxy function — that function requires a signed-in Supabase user, the same real
// protection groq-proxy uses for GROQ_API_KEY. If you want CORS_PROXY_KEY checked server-side
// too (defense in depth, optional), set it to match: `supabase secrets set CORS_PROXY_KEY=chikibriki`.
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

const PUBLIC_FALLBACKS = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

let ownProxy = null; // { endpoint, supabaseAnonKey, getAccessToken, proxyKey } | null

export function configureCorsProxy({ supabaseUrl, supabaseAnonKey, getAccessToken, proxyKey = DEFAULT_PROXY_KEY } = {}) {
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

// Tries webware's own cors-proxy function first (if configured), then each public fallback in
// order, then finally a direct fetch (works for hosts that already send CORS headers). Returns
// the first response with res.ok; throws the last error/status if every attempt fails.
export async function corsFetch(targetUrl, options = {}, { fetchImpl = fetch } = {}) {
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
  ownProxy = null;
}
