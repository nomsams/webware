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

// A literal IP, from a DNS answer, against the same ranges (plus IPv6 — loopback, unique-local, link-local,
// unspecified, and every IPv4-mapped form, since ::ffff:7f00:1 is just 127.0.0.1 in another spelling).
function isBlockedIp(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr.includes(":")) {
    return addr === "::" || addr === "::1"
      || /^f[cd][0-9a-f]{2}:/.test(addr)        // fc00::/7 unique-local
      || /^fe[89ab][0-9a-f]:/.test(addr)        // fe80::/10 link-local
      || addr.startsWith("::ffff:")             // IPv4-mapped, every spelling
      || addr.startsWith("64:ff9b:");           // NAT64 — can embed a private v4
  }
  return isBlockedHost(addr);
}

// DNS-aware check. The literal-host guard above can't see that "evil.example" resolves to 10.0.0.5, so the name
// is resolved here and every answer vetted too. This closes the plain "my domain points at your network" case;
// it cannot close a rebinding race (the answer can change between this lookup and fetch()'s own — Deno exposes
// no way to pin the connection to a vetted address), so the function must still never run anywhere with
// private-network access it doesn't need. Where Deno.resolveDns isn't available the literal checks stand alone.
async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith("[")) return false; // literal: already vetted by isBlockedHost
  try {
    for (const type of ["A", "AAAA"] as const) {
      let answers: string[] = [];
      try { answers = await Deno.resolveDns(hostname, type); } catch { continue; } // no records of that type
      if (answers.some(isBlockedIp)) return true;
    }
  } catch { /* resolveDns not permitted/available in this runtime */ }
  return false;
}

// Follows redirects by hand so EVERY hop is checked. The guard above only sees the URL the caller
// sent, and fetch() follows redirects on its own — so a public page that answers 302 →
// http://169.254.169.254/… walked straight past it.
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
class BlockedTarget extends Error {}
async function fetchChecked(start: URL): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (await resolvesToBlockedAddress(current.hostname)) throw new BlockedTarget("that host resolves to a private address");
    const res = await fetch(current.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; webware-cors-proxy/1.0)" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // a tarpit can't hold the function open indefinitely
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

// Caps what a single call can pull through this function: a search page and a page of text are tens of KB.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
function capBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) { controller.terminate(); return; } // stop at the cap; the caller gets a truncated page
      controller.enqueue(chunk);
    },
  }));
}

// Best-effort per-user brake (see groq-proxy for why it is only that).
const RATE_LIMIT_PER_MINUTE = 30;
const recentCalls = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const calls = (recentCalls.get(userId) ?? []).filter((t) => t > now - 60_000);
  if (calls.length >= RATE_LIMIT_PER_MINUTE) { recentCalls.set(userId, calls); return true; }
  calls.push(now);
  recentCalls.set(userId, calls);
  if (recentCalls.size > 5000) recentCalls.clear();
  return false;
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
    if (rateLimited(user.id)) {
      return json({ error: "too many requests — wait a moment and try again" }, 429);
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

    // The body is untrusted third-party content relayed from this function's own origin: hand it back inert —
    // no sniffing it into something executable, and a sandboxing CSP in case anything ever navigates to it.
    return new Response(capBody(upstream.body), {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return json({ error: "the target took too long to answer" }, 504);
    }
    console.error("cors-proxy: unhandled error:", err);
    return json({ error: "internal error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
