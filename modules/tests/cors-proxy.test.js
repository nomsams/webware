// Run: node --test modules/tests/cors-proxy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsFetch, configureCorsProxy, supabaseCorsProxy, _resetCorsProxy } from '../cors-proxy.js';

test.beforeEach(() => _resetCorsProxy());

test('corsFetch falls through public proxies in order until one succeeds', async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    if (url.startsWith('https://api.allorigins.win/')) {
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 502 };
  };

  const res = await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(calledUrls.length, 2); // corsproxy.io failed, allorigins succeeded
  assert.match(calledUrls[0], /^https:\/\/corsproxy\.io\//);
  assert.match(calledUrls[1], /^https:\/\/api\.allorigins\.win\//);
});

test('corsFetch tries the configured primary proxy first, with its headers', async () => {
  configureCorsProxy(supabaseCorsProxy('https://myproject.supabase.co', 'my-key'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options?.headers });
    return { ok: true, status: 200 };
  };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://myproject.supabase.co/functions/v1/cors-proxy?url=https%3A%2F%2Fexample.com%2Fpage');
  assert.equal(calls[0].headers['x-proxy-key'], 'my-key');
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

test('configureCorsProxy() with no args clears the primary proxy', async () => {
  configureCorsProxy(supabaseCorsProxy('https://myproject.supabase.co', 'my-key'));
  configureCorsProxy();
  const calledUrls = [];
  const fetchImpl = async (url) => { calledUrls.push(url); return { ok: true, status: 200 }; };

  await corsFetch('https://example.com/page', {}, { fetchImpl });

  assert.match(calledUrls[0], /^https:\/\/corsproxy\.io\//); // no supabase URL called
});
