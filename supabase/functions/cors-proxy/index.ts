// Fetches an arbitrary URL server-side and returns it with permissive CORS headers, for browser
// code (modules/web-search.js) that needs to reach hosts which don't send their own CORS headers
// (e.g. DuckDuckGo's HTML search results). Deno has no browser-style CORS restriction on outbound
// fetch, so this function just fetches the target directly — no third-party proxy dependency
// (crawly/timeline's own "chikibriki" proxy, on a different Supabase project, isn't used here).
//
// Auth mirrors groq-proxy: only signed-in Supabase users can reach it — that's the real
// protection. CORS_PROXY_KEY is an optional *extra* header check on top of that, not a
// replacement for it (an unset secret disables the check entirely and relies on Auth alone).
// Set it to keep parity with the conventional default modules/cors-proxy.js sends:
//   supabase secrets set CORS_PROXY_KEY=chikibriki
//
// Deploy: supabase functions deploy cors-proxy

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const CORS_PROXY_KEY = Deno.env.get("CORS_PROXY_KEY"); // optional, see note above

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Defense in depth against SSRF: an authenticated app user could otherwise point this at
// internal-network or cloud-metadata addresses. This only catches literal IPs and well-known
// internal names in the URL, not DNS rebinding to a private address — a stronger guard would resolve
// the hostname and check the resulting IP, which Deno's fetch doesn't expose a hook for here.
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "169.254.169.254", "metadata.google.internal"]);
function isBlockedHost(rawHostname: string): boolean {
  // "localhost." (a trailing dot) is the same host and used to slip past an exact-name check.
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".internal") || hostname.endsWith(".local")) return true;
  // IPv6 literals ([::1], [::ffff:7f00:1], [fd00::…]) can't be vetted with a pattern and a web page
  // is never fetched by one, so they are refused outright.
  if (hostname.startsWith("[")) return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 127 || a === 10                 // "this" network, loopback, private 10/8
    || (a === 172 && b >= 16 && b <= 31)                  // private 172.16/12
    || (a === 192 && b === 168)                           // private 192.168/16
    || (a === 169 && b === 254)                           // link-local, incl. every cloud metadata address
    || (a === 100 && b >= 64 && b <= 127);                // carrier-grade NAT 100.64/10
}

// Follows redirects by hand so EVERY hop is checked. The guard above only sees the URL the caller
// sent, and fetch() follows redirects on its own — so a public page that answers 302 →
// http://169.254.169.254/… walked straight past it.
const MAX_REDIRECTS = 5;
class BlockedTarget extends Error {}
async function fetchChecked(start: URL): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; webware-cors-proxy/1.0)" },
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      const next = new URL(location, current); // relative Location headers resolve against the current URL
      if ((next.protocol !== "http:" && next.protocol !== "https:") || isBlockedHost(next.hostname)) {
        throw new BlockedTarget("redirected to a host that is not allowed");
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  // Wrapped for the same reason as groq-proxy: an unhandled throw here would fall through to
  // Deno's own default error response, which carries no CORS headers — the browser blocks it
  // outright on a cross-origin call, and the caller sees a bare "Failed to fetch" with no detail,
  // indistinguishable from this function never having been deployed.
  try {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "not authenticated" }, 401);
    }

    if (CORS_PROXY_KEY && req.headers.get("x-proxy-key") !== CORS_PROXY_KEY) {
      return json({ error: "invalid proxy key" }, 403);
    }

    const targetUrl = new URL(req.url).searchParams.get("url");
    if (!targetUrl) return json({ error: "?url= is required" }, 400);

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return json({ error: "invalid url" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return json({ error: "only http/https urls are allowed" }, 400);
    }
    if (isBlockedHost(parsed.hostname)) {
      return json({ error: "that host is not allowed" }, 400);
    }

    let upstream: Response;
    try {
      upstream = await fetchChecked(parsed);
    } catch (err) {
      if (err instanceof BlockedTarget) return json({ error: err.message }, 400);
      throw err;
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain",
      },
    });
  } catch (err) {
    console.error("cors-proxy: unhandled error:", err);
    return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
