// Run: node --test modules/tests/addon-bridge.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAddress, mmToMetres, buildNtexOrder, ntexOrderProblems, buildVismaQuote, quoteProblems, buildAddArticles,
  toPasteJson, makeRequestId, createAddonClient, AddonBridgeError, describeJob, JOB_TYPES,
} from '../addon-bridge.js';

// ── addresses ──────────────────────────────────────────────────────────────────────────────────
test('parseAddress: one comma-separated line', () => {
  assert.deepEqual(parseAddress('Storgatan 34, 139 90 Värmdö'), { street: 'Storgatan 34', postalCode: '13990', city: 'Värmdö' });
});

test('parseAddress: several lines with a name line first', () => {
  assert.deepEqual(parseAddress('Exempel Bygg AB\nStorgatan 34\n139 90 Värmdö\nSverige'), { street: 'Storgatan 34', postalCode: '13990', city: 'Värmdö' });
});

test('parseAddress: everything on one line without commas, and a postal code without the space', () => {
  assert.deepEqual(parseAddress('Ågatan 5 212 25 Malmö'), { street: 'Ågatan 5', postalCode: '21225', city: 'Malmö' });
  assert.deepEqual(parseAddress('Ågatan 5, 21225 Malmö'), { street: 'Ågatan 5', postalCode: '21225', city: 'Malmö' });
});

test('parseAddress: city on the line after the postal code; the country is never the city', () => {
  assert.deepEqual(parseAddress('Ågatan 5\n212 25\nMalmö'), { street: 'Ågatan 5', postalCode: '21225', city: 'Malmö' });
  assert.equal(parseAddress('Ågatan 5\n212 25\nSverige').city, '');
});

test('parseAddress: no postal code gives only a guessed street; blanks give blanks', () => {
  assert.deepEqual(parseAddress('Storgatan 34, Värmdö'), { street: 'Storgatan 34', postalCode: '', city: '' });
  assert.deepEqual(parseAddress(''), { street: '', postalCode: '', city: '' });
  assert.deepEqual(parseAddress(null), { street: '', postalCode: '', city: '' });
});

test('parseAddress: a 6-digit run is not mistaken for a postal code', () => {
  assert.equal(parseAddress('Box 123456, Malmö').postalCode, '');
});

// ── NTEX ───────────────────────────────────────────────────────────────────────────────────────
const fullParty = (name) => ({ name, street: 'Storgatan 34', postalCode: '139 90', city: 'Värmdö', phone: '+46700000002', contactPerson: 'Anna' });

test('mmToMetres converts and rejects junk', () => {
  assert.equal(mmToMetres(300), 0.3);
  assert.equal(mmToMetres('1200'), 1.2);
  for (const v of ['', null, 0, -5, 'abc']) assert.equal(mmToMetres(v), null, String(v));
});

test('buildNtexOrder writes the add-on\'s own snake_case keys and drops empties', () => {
  const o = buildNtexOrder({
    from: fullParty('Betongakuten'), to: fullParty('Exempel Bygg AB'), loadDate: '2026-10-07', deliveryDate: '',
    invoiceReference: 'ORD000017',
    packages: [{ quantity: 2, type: 'kolli', goods: 'Delar', weightKg: '12,5', lengthM: 0.3, widthM: 0.2, heightM: 0.15 }],
  });
  assert.equal(o.action, 'ntex_order');
  assert.deepEqual(o.to, { name: 'Exempel Bygg AB', street: 'Storgatan 34', postal_code: '13990', city: 'Värmdö', phone: '+46700000002', contact_person: 'Anna' });
  assert.equal(o.load_date, '2026-10-07');
  assert.equal('delivery_date' in o, false);
  assert.deepEqual(o.packages, [{ quantity: 2, type: 'kolli', goods: 'Delar', weight_kg: 12.5, length_m: 0.3, width_m: 0.2, height_m: 0.15 }]);
});

test('buildNtexOrder tolerates nothing at all', () => {
  assert.deepEqual(buildNtexOrder(), { action: 'ntex_order', from: {}, to: {}, packages: [] });
});

test('ntexOrderProblems lists exactly what NTEX refuses without', () => {
  const { required, recommended } = ntexOrderProblems(buildNtexOrder({ packages: [{ type: 'kolli' }] }));
  for (const r of ['Sender name', 'Receiver postal code', 'Invoice reference', 'Weight', 'Height', 'Length', 'Width']) assert.ok(required.includes(r), r);
  assert.ok(recommended.includes('Receiver phone'));
  assert.ok(recommended.includes('Load date'));
});

test('ntexOrderProblems: a pallet needs no length/width (the add-on assumes them) but always a height', () => {
  const { required } = ntexOrderProblems(buildNtexOrder({ from: fullParty('A'), to: fullParty('B'), invoiceReference: 'x', packages: [{ type: 'pall', weightKg: 100 }] }));
  assert.deepEqual(required, ['Height']);
});

test('ntexOrderProblems: a complete order has nothing required; no packages is required', () => {
  const ok = buildNtexOrder({
    from: fullParty('A'), to: fullParty('B'), loadDate: '2026-10-07', deliveryDate: '2026-10-08', invoiceReference: 'x',
    packages: [{ type: 'kolli', goods: 'g', weightKg: 1, lengthM: 1, widthM: 1, heightM: 1 }],
  });
  assert.deepEqual(ntexOrderProblems(ok), { required: [], recommended: [] });
  assert.ok(ntexOrderProblems({}).required.includes('At least one package'));
});

test('ntexOrderProblems numbers the packages when there are several', () => {
  const { required } = ntexOrderProblems(buildNtexOrder({ packages: [{ type: 'kolli', weightKg: 1, lengthM: 1, widthM: 1, heightM: 1 }, { type: 'kolli' }] }));
  assert.ok(required.includes('Weight (package 2)'));
  assert.ok(!required.includes('Weight (package 1)'));
});

// ── Visma ──────────────────────────────────────────────────────────────────────────────────────
test('buildVismaQuote uses Item #3 as the article number and warns about lines without one', () => {
  const { quote, warnings } = buildVismaQuote({
    customer: 'Hercules Grundläggning AB',
    lines: [
      { item: { itemnumber3: '216643MB', 'itemname(english)': 'Seal' }, quantity: 2, price: 9500 },
      { item: { itemnumber3: 'None', 'itemname(english)': 'Flushing shaft' }, quantity: 1 },
      { item: { itemnumber3: '1' }, quantity: 0 },
    ],
  });
  assert.equal(quote.action, 'create_quote');
  assert.deepEqual(quote.items, [{ article: '216643MB', quantity: 2, price: 9500 }, { article: 'Flushing shaft', quantity: 1 }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Flushing shaft/);
});

test('buildVismaQuote leaves freight_text out unless given (the add-on defaults it), and keeps an explicit empty one', () => {
  assert.equal('freight_text' in buildVismaQuote({ customer: 'x', lines: [] }).quote, false);
  assert.equal(buildVismaQuote({ customer: 'x', lines: [], freightText: '' }).quote.freight_text, '');
  assert.equal(buildVismaQuote({ customer: 'x', lines: [], freightText: null }).quote.freight_text, null);
});

test('quoteProblems needs a customer and at least one line', () => {
  assert.deepEqual(quoteProblems({}), ['Customer', 'At least one line']);
  assert.deepEqual(quoteProblems({ customer: 'x', items: [{ article: 'a', quantity: 1 }] }), []);
});

test('buildAddArticles keeps only rows with a number and a name', () => {
  const r = buildAddArticles([
    { articleNumber: '221175MB', articleName: 'EMDE SHAFT', purchasePriceSek: 11325.6, salesPriceSek: 13930.49, stockBalance: 0 },
    { articleNumber: '', articleName: 'no number' },
  ]);
  assert.equal(r.action, 'add_articles');
  assert.deepEqual(r.articles, [{ article_number: '221175MB', article_name: 'EMDE SHAFT', price_sek: 11325.6, outprice_sek: 13930.49, stock_balance: 0 }]);
});

test('toPasteJson round-trips', () => {
  const o = buildNtexOrder({ invoiceReference: 'x' });
  assert.deepEqual(JSON.parse(toPasteJson(o)), o);
});

// ── client ─────────────────────────────────────────────────────────────────────────────────────
test('makeRequestId is 16–128 chars of the allowed alphabet, and different each time', () => {
  const a = makeRequestId('ntex_order'), b = makeRequestId('ntex_order');
  for (const id of [a, b]) { assert.ok(id.length >= 16 && id.length <= 128); assert.match(id, /^[A-Za-z0-9._:-]+$/); }
  assert.notEqual(a, b);
  assert.match(makeRequestId('we ird/prefix!'), /^[A-Za-z0-9._:-]+$/);
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = await handler(url, init, calls.length);
    return { ok: r.status < 400, status: r.status, json: async () => { if (r.notJson) throw new Error('not json'); return r.body; } };
  };
  fn.calls = calls;
  return fn;
}

test('submitJob posts the documented envelope with the bearer token', async () => {
  const f = fakeFetch(() => ({ status: 202, body: { ok: true, job: { id: 'j1', status: 'queued', seq: 1 } } }));
  const c = createAddonClient({ token: 'T', fetchImpl: f });
  const job = await c.submitJob({ type: JOB_TYPES.NTEX_ORDER, data: { a: 1 }, confirm: 'api', options: { max_price_sek: 900 } });
  assert.equal(job.id, 'j1');
  const call = f.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:8765/v1/jobs');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer T');
  assert.equal(call.body.type, 'ntex_order');
  assert.equal(call.body.confirm, 'api');
  assert.deepEqual(call.body.options, { max_price_sek: 900 });
  assert.match(call.body.requestId, /^[A-Za-z0-9._:-]{16,128}$/);
});

test('submitJob refuses an unknown type before any request is made', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(createAddonClient({ token: 'T', fetchImpl: f }).submitJob({ type: 'drop_tables' }), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('a missing token is reported without touching the network', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  await assert.rejects(createAddonClient({ fetchImpl: f }).health(), (e) => e.code === 'no_token');
  assert.equal(f.calls.length, 0);
});

test('a thrown fetch (CORS / not running) becomes "unreachable" with an explanation', async () => {
  const f = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(createAddonClient({ token: 'T', fetchImpl: f }).health(), (e) => {
    assert.ok(e instanceof AddonBridgeError);
    assert.equal(e.code, 'unreachable');
    assert.match(e.message, /paste/i);
    return true;
  });
});

test('HTTP statuses map to codes, and a non-JSON body still gives a usable error', async () => {
  const cases = [[401, 'unauthorized'], [503, 'not_connected'], [409, 'conflict'], [422, 'refused'], [429, 'rate_limited'], [400, 'bad_request'], [500, 'http']];
  for (const [status, code] of cases) {
    const c = createAddonClient({ token: 'T', fetchImpl: fakeFetch(() => ({ status, body: { ok: false, error: 'nope' } })) });
    await assert.rejects(c.health(), (e) => e.code === code && e.status === status, `${status}`);
  }
  const c = createAddonClient({ token: 'T', fetchImpl: fakeFetch(() => ({ status: 502, notJson: true })) });
  await assert.rejects(c.health(), (e) => e.code === 'http' && /502/.test(e.message));
});

test('getJob builds the long-poll query and clamps wait to the add-on\'s 55 s maximum', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { job: { id: 'a b', seq: 3 } } }));
  const c = createAddonClient({ token: 'T', fetchImpl: f });
  await c.getJob('a b', { wait: 120, since: 2 });
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8765/v1/jobs/a%20b?wait=55&since=2');
});

test('waitForJob follows seq and stops when a person or confirmation is needed', async () => {
  const seen = [];
  const f = fakeFetch((url, init, n) => {
    const statuses = ['queued', 'filling', 'awaiting_confirmation'];
    return { status: 200, body: { job: { id: 'j', seq: n, status: statuses[n - 1] } } };
  });
  const c = createAddonClient({ token: 'T', fetchImpl: f });
  const j = await c.waitForJob('j', { onUpdate: (x) => seen.push(x.status) });
  assert.equal(j.status, 'awaiting_confirmation');
  assert.deepEqual(seen, ['queued', 'filling', 'awaiting_confirmation']);
  assert.match(f.calls[1].url, /since=1/);
  assert.match(f.calls[2].url, /since=2/);
});

test('waitForJob gives up after maxPolls instead of polling forever', async () => {
  const f = fakeFetch((u, i, n) => ({ status: 200, body: { job: { id: 'j', seq: n, status: 'running' } } }));
  await assert.rejects(createAddonClient({ token: 'T', fetchImpl: f }).waitForJob('j', { maxPolls: 3 }), (e) => e.code === 'timeout');
  assert.equal(f.calls.length, 3);
});

test('waitForJob stops when aborted', async () => {
  const ac = new AbortController(); ac.abort();
  const f = fakeFetch(() => ({ status: 200, body: { job: {} } }));
  await assert.rejects(createAddonClient({ token: 'T', fetchImpl: f }).waitForJob('j', { signal: ac.signal }), (e) => e.code === 'aborted');
  assert.equal(f.calls.length, 0);
});

test('confirmJob needs a decision and the preview hash you were shown', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { job: { id: 'j', status: 'booking' } } }));
  const c = createAddonClient({ token: 'T', fetchImpl: f });
  await assert.rejects(c.confirmJob('j', { decision: 'book' }), (e) => e.code === 'bad_request');
  await assert.rejects(c.confirmJob('j', { decision: 'maybe', previewHash: 'h' }), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
  await c.confirmJob('j', { decision: 'book', previewHash: 'abc' });
  assert.equal(f.calls[0].body.preview_hash, 'abc');
  assert.equal(f.calls[0].body.decision, 'book');
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8765/v1/jobs/j/confirm');
});

test('a custom base URL has its trailing slash trimmed', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  await createAddonClient({ token: 'T', baseUrl: 'https://10.0.0.4:8766//', fetchImpl: f }).health();
  assert.equal(f.calls[0].url, 'https://10.0.0.4:8766/v1/health');
});

test('describeJob: plain wording, with the price when waiting for confirmation', () => {
  assert.match(describeJob({ status: 'awaiting_confirmation', preview: { price: { text: '1 234 kr' } } }), /1 234 kr/);
  assert.match(describeJob({ status: 'needs_attention', message: 'Missing phone' }), /Missing phone/);
  assert.equal(describeJob({ status: 'completed' }), 'Done.');
  assert.equal(describeJob(null), '');
});
