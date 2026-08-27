// Run: node --test modules/tests/email-sender.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailClient, buildMailtoLink, buildPackOrderEmailTemplate } from '../email-sender.js';

test('buildMailtoLink builds a mailto: URL with subject and body, leaving `to` unencoded', () => {
  const link = buildMailtoLink({ to: 'a@example.com,b@example.com', subject: 'Hi there', body: 'Line one\nLine two' });
  assert.equal(link, 'mailto:a@example.com,b@example.com?subject=Hi+there&body=Line+one%0ALine+two');
});

test('buildMailtoLink omits the query string entirely when subject and body are both empty', () => {
  assert.equal(buildMailtoLink({ to: 'a@example.com' }), 'mailto:a@example.com');
});

test('buildMailtoLink requires a recipient', () => {
  assert.throws(() => buildMailtoLink({}), /to is required/);
});

test('buildPackOrderEmailTemplate lists items with quantity, BTK, and name', () => {
  const { subject, text } = buildPackOrderEmailTemplate({
    orderNumber: 'ORD000123',
    recipientName: 'Jane',
    fromName: 'Warehouse 1',
    items: [
      { quantity: 2, btk: 'BTK000001', matchedName: 'Widget A' },
      { quantity: 1, btk: 'BTK000002', matchedName: null },
    ],
  });

  assert.equal(subject, 'Pack order ORD000123');
  assert.match(text, /^Hi Jane,/);
  assert.match(text, /- 2x BTK000001 \(Widget A\)/);
  assert.match(text, /- 1x BTK000002$/m);
  assert.match(text, /From: Warehouse 1/);
});

test('buildPackOrderEmailTemplate falls back to a generic subject and greeting when unknowns are omitted', () => {
  const { subject, text } = buildPackOrderEmailTemplate({ items: [] });
  assert.equal(subject, 'New pack order');
  assert.match(text, /^Hi,/);
  assert.doesNotMatch(text, /From:/);
});

test('sendEmail() posts to the send-email function with auth headers and returns the response', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ sent: true }) };
  };
  const email = createEmailClient({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'test-token',
    fetchImpl,
  });

  const result = await email.sendEmail({ to: 'jane@example.com', subject: 'Hi', text: 'Body' });

  assert.deepEqual(result, { sent: true });
  assert.equal(captured.url, 'https://example.supabase.co/functions/v1/send-email');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(captured.init.body), { to: 'jane@example.com', subject: 'Hi', text: 'Body' });
});

test('sendEmail() throws the server error message on failure', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'send failed: bad auth' }) });
  const email = createEmailClient({
    supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'test-token', fetchImpl,
  });

  await assert.rejects(email.sendEmail({ to: 'jane@example.com' }), /send failed: bad auth/);
});

test('sendEmail() requires a recipient and does not call fetch without one', async () => {
  let fetchCalled = false;
  const email = createEmailClient({
    supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon-key',
    getAccessToken: async () => 'test-token', fetchImpl: async () => { fetchCalled = true; },
  });

  await assert.rejects(email.sendEmail({}), /to is required/);
  assert.equal(fetchCalled, false);
});

test('createEmailClient requires its config', () => {
  assert.throws(() => createEmailClient({}), /required/);
});
