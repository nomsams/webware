// Proxies chat-completion requests to the Groq API so the GROQ_API_KEY secret never reaches
// the browser — the client (modules/groq-client.js) calls this function instead of Groq
// directly. Only signed-in Supabase users can reach it (checked below), which is enough to
// keep the free-tier rate limits from being burned by anonymous traffic.
//
// One-time setup:
//   supabase functions deploy groq-proxy
//   supabase secrets set GROQ_API_KEY=gsk_...
//
// STATUS: standalone, not deployed or called from index.html yet.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

// Free-tier models the user has confirmed limits for. Reject anything else so a client can't
// silently point this proxy at a paid/high-limit model and run up usage.
// NOTE: "qwen/qwen3.8-27b" is exactly what was supplied — verify it against your Groq console
// (it doesn't match Groq's usual model-id naming) before relying on the multimodal path.
const ALLOWED_MODELS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  if (!GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY not configured on the server" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return json({ error: "not authenticated" }, 401);
  }

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

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: temperature ?? 1,
      max_completion_tokens: max_completion_tokens ?? 2048,
      top_p: top_p ?? 1,
      reasoning_effort: reasoning_effort ?? "medium",
      stream: !!stream,
    }),
  });

  // Forward the Groq response through as-is — SSE body untouched when streaming, JSON body
  // untouched otherwise. The client (modules/groq-client.js) does the parsing.
  return new Response(groqRes.body, {
    status: groqRes.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": groqRes.headers.get("Content-Type") ?? "application/json",
    },
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
