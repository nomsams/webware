// Browser-side client for chatting with Groq-hosted models via the groq-proxy Supabase Edge
// Function (supabase/functions/groq-proxy) — the GROQ_API_KEY secret lives only in Supabase's
// function secrets and never reaches the browser.
//
// STATUS: standalone, not wired into index.html yet. Requires groq-proxy to be deployed
// (`supabase functions deploy groq-proxy`) with GROQ_API_KEY set
// (`supabase secrets set GROQ_API_KEY=gsk_...`) before it will actually work.
//
// Usage:
//   import { createGroqClient, GROQ_MODELS } from './groq-client.js';
//   const groq = createGroqClient({
//     supabaseUrl: SUPABASE_URL,
//     supabaseAnonKey: SUPABASE_ANON_KEY,
//     getAccessToken: async () => (await sb.auth.getSession()).data.session?.access_token,
//   });
//   const reply = await groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] });
//   for await (const delta of groq.stream({ model: GROQ_MODELS.TEXT, messages: [...] })) { ... }

export const GROQ_MODELS = {
  // Text-only. Free tier: 30 RPM / 1K RPD / 8K TPM / 200K TPD.
  TEXT: 'openai/gpt-oss-120b',
  // Multimodal (accepts images). Free tier: 30 RPM / 1K RPD / 8K TPM / 2M TPD.
  // NOTE: verify this id in your Groq console — "qwen/qwen3.8-27b" as supplied doesn't match
  // Groq's usual model-naming pattern (likely qwen/qwen3-32b or a vision-specific id). Update
  // here and in supabase/functions/groq-proxy/index.ts's ALLOWED_MODELS together.
  MULTIMODAL: 'qwen/qwen3.8-27b',
};

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'default'];

// Dependency-injected so this module has no hard dependency on a particular supabase-js
// version or global — pass plain values/callbacks instead of the sb client object itself.
export function createGroqClient({ supabaseUrl, supabaseAnonKey, getAccessToken, fetchImpl = fetch }) {
  if (!supabaseUrl || !supabaseAnonKey || !getAccessToken) {
    throw new Error('createGroqClient: supabaseUrl, supabaseAnonKey, and getAccessToken are required');
  }
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/groq-proxy`;

  async function callProxy(payload) {
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('groq-client: no active session — sign in first');
    return fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  function buildPayload({ model, messages, temperature = 1, maxTokens = 2048, topP = 1, reasoningEffort = 'medium', stream = false }) {
    if (!model) throw new Error('groq-client: model is required');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('groq-client: messages must be a non-empty array');
    return {
      model, messages, temperature, max_completion_tokens: maxTokens,
      top_p: topP, reasoning_effort: reasoningEffort, stream,
    };
  }

  // One-shot, non-streaming call. Returns the assistant's reply text.
  async function chat(options) {
    const res = await callProxy(buildPayload({ ...options, stream: false }));
    const data = await res.json();
    if (!res.ok) throw new Error(`groq-client: ${data?.error || `HTTP ${res.status}`}`);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('groq-client: unexpected response shape');
    return text;
  }

  // Streaming call. Async-generator yielding text deltas as they arrive (parses the
  // OpenAI-style SSE stream Groq/groq-proxy sends).
  async function* stream(options) {
    const res = await callProxy(buildPayload({ ...options, stream: true }));
    if (!res.ok || !res.body) {
      let message = `HTTP ${res.status}`;
      try { message = (await res.json())?.error || message; } catch { /* body wasn't JSON */ }
      throw new Error(`groq-client: ${message}`);
    }
    yield* parseSseDeltas(res.body);
  }

  return { chat, stream };
}

// Exported separately so it can be unit-tested without a real fetch Response stream.
export async function* parseSseDeltas(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const delta = parseSseLine(line);
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return null;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  return parsed?.choices?.[0]?.delta?.content || null;
}
