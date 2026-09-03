// Minimal tests for modules/groq-client.js. No network, no real Supabase — fetch and the
// SSE body stream are both faked.
//
// Run: node --test modules/tests/groq-client.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroqClient, parseSseLine, parseSseDeltas, GROQ_MODELS, GROQ_DIRECT_CHAT_URL, GROQ_DIRECT_TRANSCRIBE_URL } from '../groq-client.js';

function fakeGetAccessToken(token = 'test-token') {
  return async () => token;
}

test('parseSseLine extracts delta content, ignores non-data and [DONE] lines', () => {
  assert.equal(parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(parseSseLine('data: [DONE]'), null);
  assert.equal(parseSseLine(': comment'), null);
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine('data: not json'), null);
});

test('parseSseDeltas reassembles deltas split across chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n',
  ].map((s) => encoder.encode(s));
  let i = 0;
  const fakeStream = {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) return { done: false, value: chunks[i++] };
          return { done: true, value: undefined };
        },
        releaseLock() {},
      };
    },
  };
  const deltas = [];
  for await (const delta of parseSseDeltas(fakeStream)) deltas.push(delta);
  assert.deepEqual(deltas, ['Hello', ' world']);
});

test('chat() posts the expected payload and returns the reply text', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'the answer' } }] }),
    };
  };
  const groq = createGroqClient({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: fakeGetAccessToken(),
    fetchImpl,
  });

  const reply = await groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(reply, 'the answer');
  assert.equal(capturedUrl, 'https://example.supabase.co/functions/v1/groq-proxy');
  assert.equal(capturedInit.headers.Authorization, 'Bearer test-token');
  assert.equal(capturedInit.headers.apikey, 'anon-key');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, GROQ_MODELS.TEXT);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('chat() throws with the server error message on a non-ok response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'model must be one of: openai/gpt-oss-120b' }),
  });
  const groq = createGroqClient({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: fakeGetAccessToken(),
    fetchImpl,
  });

  await assert.rejects(
    groq.chat({ model: 'not-a-real-model', messages: [{ role: 'user', content: 'hi' }] }),
    /model must be one of/,
  );
});

test('chat() rejects with no access token instead of calling fetch', async () => {
  let fetchCalled = false;
  const groq = createGroqClient({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => null,
    fetchImpl: async () => { fetchCalled = true; },
  });

  await assert.rejects(
    groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] }),
    /no active session/,
  );
  assert.equal(fetchCalled, false);
});

test('createGroqClient requires its config', () => {
  assert.throws(() => createGroqClient({}), /required/);
});

test('chat() applies the text model\'s own defaults when none are given', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const groq = createGroqClient({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key', getAccessToken: fakeGetAccessToken(), fetchImpl });

  await groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(capturedBody.temperature, 1);
  assert.equal(capturedBody.top_p, 1);
  assert.equal(capturedBody.reasoning_effort, 'medium');
});

test('chat() applies the multimodal model\'s own (different) defaults when none are given', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const groq = createGroqClient({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key', getAccessToken: fakeGetAccessToken(), fetchImpl });

  await groq.chat({ model: GROQ_MODELS.MULTIMODAL, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(capturedBody.temperature, 0.6);
  assert.equal(capturedBody.top_p, 0.95);
  assert.equal(capturedBody.reasoning_effort, 'default');
});

test('chat() lets an explicit option override the model\'s own default', async () => {
  let capturedBody;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const groq = createGroqClient({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key', getAccessToken: fakeGetAccessToken(), fetchImpl });

  await groq.chat({ model: GROQ_MODELS.MULTIMODAL, messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 });

  assert.equal(capturedBody.temperature, 0.2);
  assert.equal(capturedBody.top_p, 0.95); // untouched options still use the model's own default
});

// ── Direct mode (personal key, no groq-proxy / no Supabase) ────────────────────────────────

test('createGroqClient does not require Supabase config when apiKey is given (direct mode)', () => {
  assert.doesNotThrow(() => createGroqClient({ apiKey: 'gsk_personal' }));
});

test('direct-mode chat() posts straight to api.groq.com with the personal key, no Supabase headers', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'the answer' } }] }) };
  };
  const groq = createGroqClient({ apiKey: 'gsk_personal', fetchImpl });

  const reply = await groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(reply, 'the answer');
  assert.equal(capturedUrl, GROQ_DIRECT_CHAT_URL);
  assert.equal(capturedInit.headers.Authorization, 'Bearer gsk_personal');
  assert.equal(capturedInit.headers.apikey, undefined); // no Supabase apikey header in direct mode
});

test('direct-mode chat() surfaces Groq\'s own {error:{message}} shape, not [object Object]', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }) });
  const groq = createGroqClient({ apiKey: 'gsk_bad', fetchImpl });

  await assert.rejects(
    groq.chat({ model: GROQ_MODELS.TEXT, messages: [{ role: 'user', content: 'hi' }] }),
    /Invalid API Key/,
  );
});

test('direct-mode transcribe() posts multipart form data straight to api.groq.com', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, json: async () => ({ text: 'transcribed words' }) };
  };
  const groq = createGroqClient({ apiKey: 'gsk_personal', fetchImpl });

  const text = await groq.transcribe(new Blob(['fake audio']), { fileName: 'speech.webm' });

  assert.equal(text, 'transcribed words');
  assert.equal(capturedUrl, GROQ_DIRECT_TRANSCRIBE_URL);
  assert.equal(capturedInit.headers.Authorization, 'Bearer gsk_personal');
  assert.ok(capturedInit.body instanceof FormData);
});

test('proxy-mode transcribe() posts to groq-proxy with the Supabase session, not api.groq.com', async () => {
  let capturedUrl, capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 200, json: async () => ({ text: 'transcribed words' }) };
  };
  const groq = createGroqClient({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key', getAccessToken: fakeGetAccessToken(), fetchImpl });

  const text = await groq.transcribe(new Blob(['fake audio']));

  assert.equal(text, 'transcribed words');
  assert.equal(capturedUrl, 'https://example.supabase.co/functions/v1/groq-proxy');
  assert.equal(capturedInit.headers.Authorization, 'Bearer test-token');
  assert.equal(capturedInit.headers.apikey, 'anon-key');
});
