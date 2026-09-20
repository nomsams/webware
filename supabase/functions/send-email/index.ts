// Sends an email via SMTP, so modules/email-sender.js's sendEmail() can actually deliver a
// message rather than only opening the user's own mail client (see buildMailtoLink() there for
// that no-backend alternative). Credentials never reach the browser — they're Supabase secrets,
// same pattern as GROQ_API_KEY in groq-proxy.
//
// SMTP_PROVIDER picks a host/port preset for the common cases; use "custom" (with SMTP_HOST/
// SMTP_PORT/SMTP_SECURE) for your own server or a provider not listed. Any of SMTP_HOST/PORT/
// SECURE can also be set *alongside* a preset to override just that one field (e.g. keep the
// "office365" preset's host but force a different port) — only "custom" requires all three.
//   supabase secrets set SMTP_PROVIDER=gmail        # or outlook / office365 / one.com / custom
//   supabase secrets set SMTP_USER=you@example.com
//   supabase secrets set SMTP_PASSWORD=...          # an APP PASSWORD, not your login password — see below
//   supabase secrets set SMTP_FROM="Warehouse <you@example.com>"   # optional, defaults to SMTP_USER
//   supabase secrets set SMTP_HOST=... SMTP_PORT=... SMTP_SECURE=true   # "custom", or to override one field of a preset
//
// Gmail: needs a Google Account "App Password" (requires 2-Step Verification to be enabled) —
// your normal password will not work over SMTP.
//
// Outlook comes in two genuinely different flavors — pick the one that matches the mailbox:
//   - "outlook": a personal outlook.com/hotmail.com/live.com address. Works the same way Gmail
//     does — turn on 2-step verification, then generate an "app password" at
//     account.live.com/proofs/AppPassword and use that as SMTP_PASSWORD.
//   - "office365": a work/school mailbox on Microsoft 365 / Exchange Online. Microsoft disabled
//     basic SMTP AUTH tenant-wide by default since 2022-2023, so this will fail with an
//     authentication error until an admin explicitly re-enables it for the mailbox — see the
//     error message this function returns for exactly how. If your admin can't or won't do that,
//     SMTP isn't an option at all for that tenant; sending would need Microsoft Graph's
//     send-mail API with OAuth2 instead, which is a materially different integration and isn't
//     implemented here.
// one.com: SMTP is generally enabled by default with your mailbox password — see one.com's own
// SMTP docs for the current host/port if send.one.com stops working.
//
// Not exercised against a live SMTP server in this environment (no Deno runtime available here)
// — the denomailer usage follows its documented API (confirmed against its own README: tls:true
// is full TLS, tls:false is STARTTLS — what both Outlook presets below rely on at port 587) but
// verify it end-to-end once deployed before relying on it, especially for a mailbox/tenant this
// hasn't been tried against yet.
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
  // Personal outlook.com/hotmail.com/live.com — NOT the same host as a Microsoft 365 business
  // tenant (see "office365" below); using the wrong one of these two is the most common way this
  // preset fails outright.
  outlook: { host: "smtp-mail.outlook.com", port: 587, secure: false },
  // Work/school mailbox on Microsoft 365 / Exchange Online — see the tenant-wide SMTP AUTH caveat
  // in the header comment above.
  office365: { host: "smtp.office365.com", port: 587, secure: false },
  "one.com": { host: "send.one.com", port: 465, secure: true },
};

function resolveSmtpConfig() {
  const preset = SMTP_PRESETS[SMTP_PROVIDER];
  // SMTP_HOST/PORT/SECURE override the matching field of a preset when set, or fully define a
  // config on their own when there's no preset at all — not just for SMTP_PROVIDER=custom, but
  // for any unrecognized/typo'd provider value too, same as before this preset table grew a
  // per-field-override option (a provider name that isn't in the table above is otherwise
  // indistinguishable from "custom" as far as this function is concerned).
  const host = Deno.env.get("SMTP_HOST") || preset?.host;
  if (!host) return null;
  const portEnv = Deno.env.get("SMTP_PORT");
  const port = portEnv ? Number(portEnv) : (preset?.port ?? 587);
  const secureEnv = Deno.env.get("SMTP_SECURE");
  const secure = secureEnv ? secureEnv.toLowerCase() === "true" : (preset?.secure ?? false);
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
    const WRITE_ROLES = ["editor", "maintainer", "admin"];
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    let allowed = !profileError && !!profile && WRITE_ROLES.includes(profile.role);
    if (!allowed) {
      // A per-warehouse grant counts as well. The app's own gate (canEditItems()) lets someone who is
      // an editor/maintainer/admin in a warehouse by grant use its Send button, and checking only the
      // global role here answered that with a 403. The message isn't tied to one warehouse, so any
      // such grant qualifies. RLS lets a user read their own grants, so the caller's own client works.
      const { data: grants } = await supabase
        .from("warehouse_permissions")
        .select("role")
        .eq("user_id", user.id);
      allowed = !!grants && grants.some((g: { role: string }) => WRITE_ROLES.includes(g.role));
    }
    if (!allowed) {
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
      const rawMsg = err instanceof Error ? err.message : String(err);
      return json({ error: `send failed: ${rawMsg}${smtpFailureHint(rawMsg)}` }, 502);
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

// Turns the SMTP server's own (often cryptic) rejection text into an actionable hint for the two
// failure modes that account for nearly every real support request here: Microsoft's tenant-wide
// SMTP AUTH block (the "office365" preset's whole reason for existing as a separate warning), and
// a plain wrong-password mixup (most often someone using their real login password instead of an
// app password). Anything else is left as just the raw SMTP error — better to say nothing than to
// guess wrong.
function smtpFailureHint(rawMsg: string): string {
  if (/smtpclientauthentication is disabled/i.test(rawMsg) || /5\.7\.139/.test(rawMsg)) {
    return " — SMTP AUTH is disabled for this mailbox/tenant (Microsoft's default since 2022-2023). " +
      "An admin needs to turn it on: Exchange Admin Center → Recipients → the mailbox → " +
      "\"Manage email apps\" → enable \"Authenticated SMTP\" (or PowerShell: " +
      "Set-CASMailbox -Identity <email> -SmtpClientAuthenticationDisabled $false), then wait " +
      "up to an hour for it to take effect. If tenant policy blocks this entirely, SMTP isn't " +
      "usable here and sending would need Microsoft Graph's API with OAuth2 instead.";
  }
  if (/5\.7\.3/.test(rawMsg) || /authentication unsuccessful/i.test(rawMsg) || /invalid login/i.test(rawMsg)) {
    return " — check SMTP_USER/SMTP_PASSWORD. For Gmail and personal Outlook.com/Hotmail " +
      "accounts this must be an app password (generated after turning on 2-step verification), " +
      "not the account's normal sign-in password.";
  }
  return "";
}
