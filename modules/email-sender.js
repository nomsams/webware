// Sends an email straight from the webpage via the send-email Supabase Edge Function (SMTP
// credentials held server-side as Supabase secrets, same pattern as GROQ_API_KEY — see that
// function's doc comment for how to configure Gmail/Outlook/one.com/a custom server), plus a
// no-backend mailto: fallback that just opens the user's own mail client with everything
// prefilled instead of sending automatically.
//
// STATUS: standalone, not wired into index.html yet. Intended integration point: a "notify
// recipient" action on a saved Pack Order — buildPackOrderEmailTemplate() turns an order draft
// (the same shape order-parser.js produces) into a ready subject/body, which sendEmail() or
// buildMailtoLink() then delivers.
//
// Usage (actually sends, needs send-email deployed + configured):
//   import { createEmailClient, buildPackOrderEmailTemplate } from './email-sender.js';
//   const email = createEmailClient({
//     supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY,
//     getAccessToken: async () => (await sb.auth.getSession()).data.session?.access_token,
//   });
//   const { subject, text } = buildPackOrderEmailTemplate({ orderNumber: 'ORD000123', recipientName: 'Jane', items: [...] });
//   await email.sendEmail({ to: 'jane@example.com', subject, text });
//
// Usage (no backend needed — opens the user's own mail app instead):
//   window.open(buildMailtoLink({ to: 'jane@example.com', subject, body: text }));

export function createEmailClient({ supabaseUrl, supabaseAnonKey, getAccessToken, fetchImpl = fetch }) {
  if (!supabaseUrl || !supabaseAnonKey || !getAccessToken) {
    throw new Error('createEmailClient: supabaseUrl, supabaseAnonKey, and getAccessToken are required');
  }
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/send-email`;

  async function sendEmail({ to, subject = '', text = '' }) {
    if (!to) throw new Error('sendEmail: to is required');
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error('sendEmail: no active session — sign in first');
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, subject, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`sendEmail: ${data?.error || `HTTP ${res.status}`}`);
    return data;
  }

  return { sendEmail };
}

// No-backend fallback (or a deliberate "let the user review before sending" option): opens the
// user's own mail client with everything prefilled. Works with zero deployment/configuration.
// `to` is left unencoded so comma-separated multiple recipients still work as mailto expects.
export function buildMailtoLink({ to, subject = '', body = '' }) {
  if (!to) throw new Error('buildMailtoLink: to is required');
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const query = params.toString();
  return `mailto:${to}${query ? `?${query}` : ''}`;
}

// Builds a ready subject/body for notifying someone about a packed order — takes the same shape
// order-parser.js's draft.items / draft.recipient produce, so the two modules compose directly:
// parseOrderRequest() -> buildPackOrderEmailTemplate() -> sendEmail()/buildMailtoLink().
export function buildPackOrderEmailTemplate({ orderNumber, recipientName, items = [], fromName }) {
  const subject = orderNumber ? `Pack order ${orderNumber}` : 'New pack order';
  const lines = items.map((it) => `- ${it.quantity}x ${it.btk || it.reference}${it.matchedName ? ` (${it.matchedName})` : ''}`);
  const text = [
    `Hi${recipientName ? ` ${recipientName}` : ''},`,
    '',
    'The following items have been packed for you:',
    ...lines,
    '',
    fromName ? `From: ${fromName}` : null,
    fromName ? '' : null,
    'Best regards,',
  ].filter((line) => line !== null).join('\n');
  return { subject, text };
}
