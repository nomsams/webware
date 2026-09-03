// Run: node --test modules/tests/cors-proxy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsFetch, configureCorsProxy, setAllowPublicFallback, _resetCorsProxy, DEFAULT_PROXY_KEY, KNOWN_EXTERNAL_PROXY_URL } from '../cors-proxy.js';

test.beforeEach(() => _resetCorsProxy());

test('unconfigured corsFetch tries the known external chikibriki proxy by default (not the fully-public fallbacks)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, headers: options?.headers }); return { ok: true, status: 200 }; };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${KNOWN_EXTERNAL_PROXY_URL}?url=${encodeURIComponent('https://example.com/page')}`);
  assert.equal(calls[0].headers['x-proxy-key'], DEFAULT_PROXY_KEY);
  assert.equal(DEFAULT_PROXY_KEY, 'chikibriki');
});

test('useKnownExternalProxy: false skips it, going straight to a direct fetch (still no public fallback by default)', async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl, useKnownExternalProxy: false });

  assert.equal(res.ok, true);
  assert.deepEqual(calledUrls, ['https://example.com/page']);
});

test('with allowPublicFallback: true and the known external proxy skipped, falls through public proxies in order', async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://api.allorigins.win/')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl, allowPublicFallback: true, useKnownExternalProxy: false });

  assert.equal(res.ok, true);
  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[0], /^https:\/\/corsproxy\.io\//);
  assert.match(calledUrls[1], /^https:\/\/api\.allorigins\.win\//);
});

test('configured corsFetch calls the own cors-proxy function first, with auth + default chikibriki key', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options?.headers });
    return { ok: true, status: 200 };
  };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://myproject.supabase.co/functions/v1/cors-proxy?url=https%3A%2F%2Fexample.com%2Fpage');
  assert.equal(calls[0].headers.Authorization, 'Bearer user-token');
  assert.equal(calls[0].headers.apikey, 'anon-key');
  assert.equal(calls[0].headers['x-proxy-key'], DEFAULT_PROXY_KEY);
});

test('configureCorsProxy accepts a custom proxyKey override (own proxy only — the known external one always uses the conventional key)', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
    proxyKey: 'my-custom-key',
  });
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push(options.headers); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(calls[0]['x-proxy-key'], 'my-custom-key');
});

test('own-proxy failure falls through to the known external proxy next, before a direct fetch', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://myproject.supabase.co/')) return { ok: false, status: 500 };
    if (url.startsWith(KNOWN_EXTERNAL_PROXY_URL)) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[0], /^https:\/\/myproject\.supabase\.co\//);
  assert.match(calledUrls[1], new RegExp('^' + KNOWN_EXTERNAL_PROXY_URL.replace(/[.]/g, '\\.')));
});

test('own-proxy and known-external-proxy failure WITH allowPublicFallback falls back to public proxies', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://myproject.supabase.co/')) return { ok: false, status: 500 };
    if (url.startsWith(KNOWN_EXTERNAL_PROXY_URL)) return { ok: false, status: 500 };
    if (url.startsWith('https://corsproxy.io/')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl, allowPublicFallback: true });

  assert.equal(res.ok, true);
  assert.equal(calledUrls.length, 3);
  assert.match(calledUrls[0], /^https:\/\/myproject\.supabase\.co\//);
  assert.match(calledUrls[1], new RegExp('^' + KNOWN_EXTERNAL_PROXY_URL.replace(/[.]/g, '\\.')));
  assert.match(calledUrls[2], /^https:\/\/corsproxy\.io\//);
});

test('corsFetch falls back to a direct fetch as the very last resort', async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url === 'https://example.com/page') return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calledUrls[calledUrls.length - 1], 'https://example.com/page');
});

test('corsFetch throws when every attempt fails', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(corsFetch('https://example.com/page', {}, { fetchImpl }), /network down/);
});

test('configureCorsProxy() with no args clears the own proxy (known external proxy still tried)', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  configureCorsProxy();
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.deepEqual(calledUrls, [`${KNOWN_EXTERNAL_PROXY_URL}?url=${encodeURIComponent('https://example.com/page')}`]);
});

test('configureCorsProxy requires anonKey and getAccessToken alongside supabaseUrl', () => {
  assert.throws(() => configureCorsProxy({ supabaseUrl: 'https://myproject.supabase.co' }), /required/);
});

test('setAllowPublicFallback flips the running default without a per-call override', async () => {
  setAllowPublicFallback(true);
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://api.allorigins.win/')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  await corsFetch('https://example.com/page', {}, { fetchImpl, useKnownExternalProxy: false });

  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[0], /^https:\/\/corsproxy\.io\//);
});

test('configureCorsProxy({allowPublicFallback}) sets the same running default', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
    allowPublicFallback: true,
  });
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://myproject.supabase.co/')) return { ok: false, status: 500 };
    if (url.startsWith('https://corsproxy.io/')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  await corsFetch('https://example.com/page', {}, { fetchImpl, useKnownExternalProxy: false });

  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[1], /^https:\/\/corsproxy\.io\//);
});

test('a per-call allowPublicFallback overrides the running default in either direction', async () => {
  setAllowPublicFallback(true);
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl, allowPublicFallback: false, useKnownExternalProxy: false });

  assert.deepEqual(calledUrls, ['https://example.com/page']);
});

test('_resetCorsProxy() also resets the allowPublicFallback default', async () => {
  setAllowPublicFallback(true);
  _resetCorsProxy();
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl, useKnownExternalProxy: false });

  assert.deepEqual(calledUrls, ['https://example.com/page']);
});
