// Run: node --test modules/tests/cors-proxy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsFetch, configureCorsProxy, _resetCorsProxy, DEFAULT_PROXY_KEY } from '../cors-proxy.js';

test.beforeEach(() => _resetCorsProxy());

test('unconfigured corsFetch falls through public proxies in order until one succeeds', async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://api.allorigins.win/')) return { ok: true, status: 200 };
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

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
  assert.equal(DEFAULT_PROXY_KEY, 'chikibriki');
});

test('configureCorsProxy accepts a custom proxyKey override', async () => {
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

test('own-proxy failure falls back to public proxies', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://myproject.supabase.co/')) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calledUrls.length, 2);
  assert.match(calledUrls[0], /^https:\/\/myproject\.supabase\.co\//);
  assert.match(calledUrls[1], /^https:\/\/corsproxy\.io\//);
});

test('corsFetch falls back to a direct fetch as the last resort', async () => {
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

test('configureCorsProxy() with no args clears the own proxy', async () => {
  configureCorsProxy({
    supabaseUrl: 'https://myproject.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'user-token',
  });
  configureCorsProxy();
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.match(calledUrls[0], /^https:\/\/corsproxy\.io\//);
});

test('configureCorsProxy requires anonKey and getAccessToken alongside supabaseUrl', () => {
  assert.throws(() => configureCorsProxy({ supabaseUrl: 'https://myproject.supabase.co' }), /required/);
});
