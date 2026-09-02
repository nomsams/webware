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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    console.error("groq-proxy: unhandled error:", err);
    return json({ error: err instanceof Error ? err.message : "internal error" }, 500);
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
  if (error || !data) return [];
  return data.map((row: { api_key: string }) => row.api_key).filter(Boolean);
}

async function handleChat(req: Request, keys: string[]): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

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

  const payload = JSON.stringify({
    model,
    messages,
    temperature: temperature ?? 1,
    max_completion_tokens: max_completion_tokens ?? 2048,
    top_p: top_p ?? 1,
    reasoning_effort: reasoning_effort ?? "medium",
    stream: !!stream,
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
