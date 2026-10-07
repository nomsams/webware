// Proxies both chat-completion and audio-transcription requests to the Groq API so no API key
// ever reaches the browser — the client (modules/groq-client.js for chat; the classic script's
// aiTranscribeAudio() for voice) calls this function instead of Groq directly.
//
// Key storage: unlike a typical Edge Function secret, the Groq key(s) live in the
// public.llm_api_keys table (see supabase/schema_llm_assistant.sql) — shared across every user of
// the app, with optional backup keys. RLS on that table has NO select policy at all, so no client
// can ever read a raw key back; only this function can, because it authenticates to Postgres with
// SUPABASE_SERVICE_ROLE_KEY (auto-provided to every Edge Function by Supabase — no manual secret
// needed), which bypasses RLS entirely. Keys are tried in order (oldest/primary first); a 401 or
// 429 from Groq falls through to the next one instead of failing the whole request.
//
// One-time setup: supabase functions deploy groq-proxy — no `supabase secrets set` needed, since
// the key(s) come from the database, not from function secrets. Add at least one key via the app's
// own Settings → AI Assistant screen (or directly in the llm_api_keys table) before this does
// anything real.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Free-tier models the user has confirmed limits for. Reject anything else so a client can't
// silently point this proxy at a paid/high-limit model and run up usage.
// NOTE: "qwen/qwen3.8-27b" is exactly what was supplied — verify it against your Groq console
// (it doesn't match Groq's usual model-id naming) before relying on the multimodal path.
const ALLOWED_MODELS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
const ALLOWED_TRANSCRIBE_MODELS = new Set(["whisper-large-v3-turbo", "whisper-large-v3"]);

// The model allow-list above stops a client pointing the shared key at a costlier model, but the
// reply length was left to the caller: any signed-in user could ask for the model's maximum on every
// call. The app itself only ever requests the default, so this ceiling costs it nothing.
const DEFAULT_COMPLETION_TOKENS = 2048;
const MAX_COMPLETION_TOKENS = 8192;
function clampCompletionTokens(requested: unknown): number {
  const n = Number(requested);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_COMPLETION_TOKENS) : DEFAULT_COMPLETION_TOKENS;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Abuse limits ─────────────────────────────────────────────────────────────────────────────────────────
// Any signed-in user spends the one shared Groq key, so everything a caller controls is bounded: how often,
// how big, which roles, which parameters. (Nothing here is needed by the app's own calls.)
const ALLOWED_EFFORTS = new Set(["low", "medium", "high"]);
const MAX_MESSAGES = 60;
const MAX_CHAT_BODY_BYTES = 6 * 1024 * 1024;        // a downscaled delivery-note photo as a data: URL fits easily
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;      // Groq's own ceiling for audio uploads
const RATE_LIMIT_PER_MINUTE = 40;

// Best-effort per-user sliding window. An Edge Function isolate is short-lived and there can be several, so
// this is a brake, not a guarantee — but it turns "a script burns the whole free-tier quota in a minute" into
// "a script is slowed to a trickle".
const recentCalls = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const calls = (recentCalls.get(userId) ?? []).filter((t) => t > windowStart);
  if (calls.length >= RATE_LIMIT_PER_MINUTE) { recentCalls.set(userId, calls); return true; }
  calls.push(now);
  recentCalls.set(userId, calls);
  if (recentCalls.size > 5000) recentCalls.clear(); // never grows without bound
  return false;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Only plain chat turns: a role from the allow-list and either a string or text / data:-image parts. A part
// carrying a remote image URL is refused — Groq would fetch it on this proxy's behalf — and every other key
// on a message is dropped rather than forwarded.
function sanitizeMessages(messages: unknown[]): { ok: true; messages: unknown[] } | { ok: false; error: string } {
  if (messages.length > MAX_MESSAGES) return { ok: false, error: `at most ${MAX_MESSAGES} messages` };
  const clean: unknown[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") return { ok: false, error: "invalid message" };
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "system" && role !== "user" && role !== "assistant") return { ok: false, error: "invalid message role" };
    if (typeof content === "string") { clean.push({ role, content }); continue; }
    if (!Array.isArray(content)) return { ok: false, error: "invalid message content" };
    const parts: unknown[] = [];
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } } | null;
      if (p && p.type === "text" && typeof p.text === "string") { parts.push({ type: "text", text: p.text }); continue; }
      if (p && p.type === "image_url" && typeof p.image_url?.url === "string"
          && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image_url.url)) {
        parts.push({ type: "image_url", image_url: { url: p.image_url.url } });
        continue;
      }
      return { ok: false, error: "only text and data: images are accepted in message content" };
    }
    clean.push({ role, content: parts });
  }
  return { ok: true, messages: clean };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  // Everything past this point is wrapped — an unhandled throw here (a bad env var, a Supabase
  // client error, anything) would otherwise fall through to Deno's own default error response,
  // which does NOT carry CORS_HEADERS. Since every real call to this function is cross-origin, the
  // browser then blocks that response entirely and reports it to the caller as a bare network
  // failure ("Failed to fetch") with zero detail — indistinguishable from the function never having
  // been deployed at all. Catching here turns that into a real, visible error instead.
  try {
    if (req.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const authedClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authedClient.auth.getUser();
    if (authError || !user) {
      return json({ error: "not authenticated" }, 401);
    }
    if (rateLimited(user.id)) {
      return json({ error: "too many requests — wait a moment and try again" }, 429);
    }

    const keys = await loadActiveKeys();
    if (keys.length === 0) {
      return json({ error: "no Groq API key configured — add one in Settings → AI Assistant" }, 500);
    }

    const contentType = req.headers.get("Content-Type") || "";
    if (contentType.includes("multipart/form-data")) {
      return await handleTranscription(req, keys);
    }
    return await handleChat(req, keys);
  } catch (err) {
    // The detail stays in the function's own logs; a caller only learns that it failed (a thrown message can
    // carry a connection string, a table name, or part of a key).
    console.error("groq-proxy: unhandled error:", err);
    return json({ error: "internal error" }, 500);
  }
});

// Service-role client — bypasses RLS, so this is the only place able to read llm_api_keys.api_key.
async function loadActiveKeys(): Promise<string[]> {
  const admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await admin
    .from("llm_api_keys")
    .select("api_key")
    .eq("active", true)
    .eq("provider", "groq")
    .order("created_at", { ascending: true });
  // Logged rather than silently swallowed into an indistinguishable-from-"really no key configured"
  // empty array — this table's own key row existing (has_llm_api_key() confirms it, and it's a
  // SECURITY DEFINER function, so it always could regardless of this) says nothing about whether
  // THIS query, running as service_role, can actually read it: RLS bypass and the base table GRANT
  // are two separate permission layers, and this table intentionally has no client-facing SELECT
  // grant at all (see schema_llm_assistant.sql) — service_role needs its own explicit one
  // (schema_llm_assistant_service_role_select.sql), and a fresh project or a role/grant reset can
  // lose it just like schema_llm_assistant_grant_repair.sql found happened to authenticated's
  // insert/delete grants. Visible in the function's own logs (Supabase dashboard -> Edge Functions
  // -> groq-proxy -> Logs), not just this table's activity.
  if (error) console.error("groq-proxy: loadActiveKeys query failed:", error);
  if (error || !data) return [];
  return data.map((row: { api_key: string }) => row.api_key).filter(Boolean);
}

async function handleChat(req: Request, keys: string[]): Promise<Response> {
  const declared = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_CHAT_BODY_BYTES) return json({ error: "request too large" }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > MAX_CHAT_BODY_BYTES) return json({ error: "request too large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid JSON body" }, 400);

  const { model, messages, temperature, max_completion_tokens, top_p, reasoning_effort, stream } = body as {
    model?: string;
    messages?: unknown;
    temperature?: number;
    max_completion_tokens?: number;
    top_p?: number;
    reasoning_effort?: string;
    stream?: boolean;
  };

  if (!model || !ALLOWED_MODELS.has(model)) {
    return json({ error: `model must be one of: ${[...ALLOWED_MODELS].join(", ")}` }, 400);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "messages must be a non-empty array" }, 400);
  }

  const checked = sanitizeMessages(messages);
  if (!checked.ok) return json({ error: checked.error }, 400);
  if (reasoning_effort !== undefined && reasoning_effort !== null && !ALLOWED_EFFORTS.has(String(reasoning_effort))) {
    return json({ error: `reasoning_effort must be one of: ${[...ALLOWED_EFFORTS].join(", ")}` }, 400);
  }

  const payload = JSON.stringify({
    model,
    messages: checked.messages,
    temperature: clampNumber(temperature, 0, 2, 1),
    max_completion_tokens: clampCompletionTokens(max_completion_tokens),
    top_p: clampNumber(top_p, 0, 1, 1),
    reasoning_effort: reasoning_effort ?? "medium",
    stream: stream === true,
  });

  let lastRes: Response | null = null;
  for (const apiKey of keys) {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: payload,
    });
    if (groqRes.status !== 401 && groqRes.status !== 429) {
      // Forward the Groq response through as-is — SSE body untouched when streaming, JSON body
      // untouched otherwise. The client (modules/groq-client.js) does the parsing.
      return new Response(groqRes.body, {
        status: groqRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": groqRes.headers.get("Content-Type") ?? "application/json" },
      });
    }
    lastRes = groqRes; // that key is exhausted/invalid — try the next backup
  }
  return new Response(lastRes!.body, {
    status: lastRes!.status,
    headers: { ...CORS_HEADERS, "Content-Type": lastRes!.headers.get("Content-Type") ?? "application/json" },
  });
}

async function handleTranscription(req: Request, keys: string[]): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "invalid multipart body" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: "file is required" }, 400);
  }
  if (file.size > MAX_TRANSCRIBE_BYTES) return json({ error: "audio file too large (25 MB max)" }, 413);
  if (file.type && !file.type.startsWith("audio/") && file.type !== "video/webm") {
    return json({ error: "file must be audio" }, 400);
  }
  const model = (form.get("model") as string) || "whisper-large-v3-turbo";
  if (!ALLOWED_TRANSCRIBE_MODELS.has(model)) {
    return json({ error: `model must be one of: ${[...ALLOWED_TRANSCRIBE_MODELS].join(", ")}` }, 400);
  }

  let lastRes: Response | null = null;
  for (const apiKey of keys) {
    const upstreamForm = new FormData();
    upstreamForm.append("file", file, file.name || "speech.webm");
    upstreamForm.append("model", model);
    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: upstreamForm,
    });
    if (groqRes.status !== 401 && groqRes.status !== 429) {
      const data = await groqRes.json();
      return json(data, groqRes.status);
    }
    lastRes = groqRes;
  }
  const data = await lastRes!.json().catch(() => ({ error: `HTTP ${lastRes!.status}` }));
  return json(data, lastRes!.status);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
