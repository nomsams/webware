// Sends an email via SMTP, so modules/email-sender.js's sendEmail() can actually deliver a
// message rather than only opening the user's own mail client (see buildMailtoLink() there for
// that no-backend alternative). Credentials never reach the browser — they're Supabase secrets,
// same pattern as GROQ_API_KEY in groq-proxy.
//
// SMTP_PROVIDER picks a host/port preset for the common cases; use "custom" (with SMTP_HOST/
// SMTP_PORT/SMTP_SECURE) for your own server or a provider not listed.
//   supabase secrets set SMTP_PROVIDER=gmail        # or outlook / one.com / custom
//   supabase secrets set SMTP_USER=you@gmail.com
//   supabase secrets set SMTP_PASSWORD=...          # an APP PASSWORD, not your login password — see below
//   supabase secrets set SMTP_FROM="Warehouse <you@gmail.com>"   # optional, defaults to SMTP_USER
//   supabase secrets set SMTP_HOST=... SMTP_PORT=... SMTP_SECURE=true   # only when SMTP_PROVIDER=custom
//
// Gmail: needs a Google Account "App Password" (requires 2-Step Verification to be enabled) —
// your normal password will not work over SMTP.
// Outlook/Office 365: Microsoft has disabled basic SMTP AUTH for most tenants since 2022-2023;
// plain user/password SMTP may simply be rejected depending on your tenant's settings. If so,
// you'd need an OAuth2 flow or Microsoft Graph's send-mail API instead of SMTP — not implemented
// here. Worth confirming your tenant still allows SMTP AUTH before relying on this preset.
// one.com: SMTP is generally enabled by default with your mailbox password — see one.com's own
// SMTP docs for the current host/port if send.one.com stops working.
//
// This has not been exercised against a live SMTP server in this environment (no Deno runtime
// available here) — the denomailer usage follows its documented API, but verify it end-to-end
// once deployed before relying on it.
//
// Deploy: supabase functions deploy send-email

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const SMTP_PROVIDER = (Deno.env.get("SMTP_PROVIDER") || "custom").toLowerCase();
const SMTP_USER = Deno.env.get("SMTP_USER");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SMTP_FROM = Deno.env.get("SMTP_FROM") || SMTP_USER;

const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
  outlook: { host: "smtp.office365.com", port: 587, secure: false }, // STARTTLS, see the tenant caveat above
  "one.com": { host: "send.one.com", port: 465, secure: true },
};

function resolveSmtpConfig() {
  if (SMTP_PROVIDER !== "custom" && SMTP_PRESETS[SMTP_PROVIDER]) {
    return SMTP_PRESETS[SMTP_PROVIDER];
  }
  const host = Deno.env.get("SMTP_HOST");
  const port = Number(Deno.env.get("SMTP_PORT") || 587);
  const secure = (Deno.env.get("SMTP_SECURE") || "false").toLowerCase() === "true";
  if (!host) return null;
  return { host, port, secure };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  // Wrapped for the same reason as groq-proxy/cors-proxy: an unhandled throw here would fall
  // through to Deno's own default error response, which carries no CORS headers — the browser
  // blocks it outright on a cross-origin call, surfacing only a bare "Failed to fetch".
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const smtpConfig = resolveSmtpConfig();
    if (!smtpConfig || !SMTP_USER || !SMTP_PASSWORD) {
      return json({ error: "SMTP is not configured (SMTP_PROVIDER/SMTP_HOST, SMTP_USER, SMTP_PASSWORD secrets)" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "not authenticated" }, 401);
    }

    // Signed in isn't the same as authorized — sending mail through the org's own SMTP identity to
    // an arbitrary recipient with arbitrary content is sensitive enough to need the same "can write"
    // bar the rest of the app uses (editor/maintainer/admin), not just any signed-in viewer.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (profileError || !profile || !["editor", "maintainer", "admin"].includes(profile.role)) {
      return json({ error: "not authorized to send email" }, 403);
    }

    let body: { to?: string; subject?: string; text?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const { to, subject, text } = body;
    if (!to || typeof to !== "string") return json({ error: "to is required" }, 400);

    // Basic shape check + CRLF rejection on the two header-bound fields — defense in depth against
    // header injection (e.g. a smuggled extra "Bcc:" line) regardless of what denomailer itself
    // guards against internally. `text` is the message body, not a header, so newlines there are
    // expected and left alone.
    const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
    if (!EMAIL_RE.test(to) || /[\r\n]/.test(to)) {
      return json({ error: "to must be a single, valid email address" }, 400);
    }
    if (subject !== undefined && subject !== null && (typeof subject !== "string" || /[\r\n]/.test(subject))) {
      return json({ error: "subject must not contain line breaks" }, 400);
    }

    const client = new SMTPClient({
      connection: {
        hostname: smtpConfig.host,
        port: smtpConfig.port,
        tls: smtpConfig.secure,
        auth: { username: SMTP_USER, password: SMTP_PASSWORD },
      },
    });

    try {
      await client.send({
        from: SMTP_FROM!,
        to,
        subject: subject || "(no subject)",
        content: text || "",
      });
    } catch (err) {
      return json({ error: `send failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    } finally {
      await client.close();
    }

    return json({ sent: true });
  } catch (err) {
    console.error("send-email: unhandled error:", err);
    return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
