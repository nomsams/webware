// Browser-side client for chatting with Groq-hosted models, in either of two modes:
//
//   - Proxy mode (pass supabaseUrl/supabaseAnonKey/getAccessToken): calls the groq-proxy Supabase
//     Edge Function (supabase/functions/groq-proxy), which holds a shared key server-side (the
//     llm_api_keys table) — no key of any kind reaches the browser. Requires groq-proxy deployed.
//   - Direct mode (pass apiKey instead): calls api.groq.com straight from the browser with that
//     key. Groq's API sends permissive CORS headers for this (confirmed against the real API —
//     both /chat/completions and /audio/transcriptions respond to a cross-origin browser fetch
//     rather than blocking it), so no server-side proxy is needed at all. The trade-off is the
//     usual one for any client-embedded key: it's visible to anyone who inspects this browser's
//     network traffic or storage — appropriate for a personal, free-tier key one person brings
//     for their own use, not for a key anyone would mind being exposed. index.html stores a
//     personal key in localStorage (per-device, never sent anywhere but straight to Groq) and
//     prefers direct mode over proxy mode whenever one is set — see aiGetGroqClient().
//
// STATUS: wired into index.html (bridged via the <script type="module"> block near the end of the
// page — see the AI ASSISTANT section of the classic script, which builds a proxy-mode client as
// window.aiGroq at load and a direct-mode one on demand via window.createGroqClient({apiKey}) when
// a personal key is set).
//
// Usage:
//   import { createGroqClient, GROQ_MODELS } from './groq-client.js';
//   // proxy mode:
//   const groq = createGroqClient({
//     supabaseUrl: SUPABASE_URL,
//     supabaseAnonKey: SUPABASE_ANON_KEY,
//     getAccessToken: async () => (await sb.auth.getSession()).data.session?.access_token,
//   });
//   // direct mode:
//   const groq = createGroqClient({ apiKey: 'gsk_...' });
//   const reply = await groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] });
//   for await (const delta of groq.stream({ model: GROQ_MODELS.TEXT, messages: [...] })) { ... }
//   const text = await groq.transcribe(audioBlob);

export const GROQ_MODELS = {
  // Text-only. Free tier: 30 RPM / 1K RPD / 8K TPM / 200K TPD.
  TEXT: 'openai/gpt-oss-120b',
  // Multimodal (accepts images). Free tier: 30 RPM / 1K RPD / 8K TPM / 2M TPD.
  MULTIMODAL: 'qwen/qwen3.8-27b',
};

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'default'];

export const GROQ_DIRECT_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DIRECT_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Each model's own recommended call defaults — not universal, the multimodal model's differ from
// the text model's (lower temperature, higher top_p, "default" reasoning effort rather than
// "medium"). A caller's own explicit option always overrides these; a model not in this table
// (shouldn't happen given groq-proxy's own ALLOWED_MODELS check, but just in case) falls back to
// the text model's defaults rather than throwing.
const MODEL_DEFAULTS = {
  [GROQ_MODELS.TEXT]: { temperature: 1, topP: 1, reasoningEffort: 'medium' },
  [GROQ_MODELS.MULTIMODAL]: { temperature: 0.6, topP: 0.95, reasoningEffort: 'default' },
};
const FALLBACK_MODEL_DEFAULTS = MODEL_DEFAULTS[GROQ_MODELS.TEXT];

// Dependency-injected so this module has no hard dependency on a particular supabase-js
// version or global — pass plain values/callbacks instead of the sb client object itself.
export function createGroqClient({ supabaseUrl, supabaseAnonKey, getAccessToken, fetchImpl = fetch, apiKey } = {}) {
  const direct = !!apiKey;
  if (!direct && (!supabaseUrl || !supabaseAnonKey || !getAccessToken)) {
    throw new Error('createGroqClient: supabaseUrl, supabaseAnonKey, and getAccessToken are required (or pass apiKey to call Groq directly, bypassing groq-proxy)');
  }
  const proxyEndpoint = direct ? null : `${supabaseUrl.replace(/\/$/, '')}/functions/v1/groq-proxy`;

  async function callChat(payload) {
    if (direct) {
      return fetchImpl(GROQ_DIRECT_CHAT_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('groq-client: no active session — sign in first');
    return fetchImpl(proxyEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  async function callTranscribe(form) {
    if (direct) {
      return fetchImpl(GROQ_DIRECT_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: form,
      });
    }
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('groq-client: no active session — sign in first');
    return fetchImpl(proxyEndpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': supabaseAnonKey },
      body: form,
    });
  }

  function buildPayload({ model, messages, temperature, maxTokens = 2048, topP, reasoningEffort, stream = false }) {
    if (!model) throw new Error('groq-client: model is required');
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('groq-client: messages must be a non-empty array');
    const defaults = MODEL_DEFAULTS[model] || FALLBACK_MODEL_DEFAULTS;
    return {
      model, messages,
      temperature: temperature ?? defaults.temperature,
      max_completion_tokens: maxTokens,
      top_p: topP ?? defaults.topP,
      reasoning_effort: reasoningEffort ?? defaults.reasoningEffort,
      stream,
    };
  }

  // One-shot, non-streaming call. Returns the assistant's reply text.
  async function chat(options) {
    const res = await callChat(buildPayload({ ...options, stream: false }));
    const data = await res.json();
    if (!res.ok) throw new Error(`groq-client: ${data?.error?.message || data?.error || `HTTP ${res.status}`}`);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('groq-client: unexpected response shape');
    return text;
  }

  // Streaming call. Async-generator yielding text deltas as they arrive (parses the
  // OpenAI-style SSE stream Groq/groq-proxy sends).
  async function* stream(options) {
    const res = await callChat(buildPayload({ ...options, stream: true }));
    if (!res.ok || !res.body) {
      let message = `HTTP ${res.status}`;
      try { const data = await res.json(); message = data?.error?.message || data?.error || message; } catch { /* body wasn't JSON */ }
      throw new Error(`groq-client: ${message}`);
    }
    yield* parseSseDeltas(res.body);
  }

  // Whisper transcription. Returns the transcribed text (empty string if Groq returned none).
  async function transcribe(blob, { model = 'whisper-large-v3-turbo', fileName = 'speech.webm' } = {}) {
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('model', model);
    const res = await callTranscribe(form);
    const data = await res.json();
    if (!res.ok) throw new Error(`groq-client: ${data?.error?.message || data?.error || `HTTP ${res.status}`}`);
    return data.text || '';
  }

  return { chat, stream, transcribe };
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
