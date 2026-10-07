// Everything webware needs to hand work to the VismaScrap add-on (the sibling `addonvisma` project):
// its two "modules" — NTEX (book a transport) and Visma (create a quote draft, add articles). Pure and
// dependency-injected — no DOM, no Supabase, `fetch` is passed in — same convention as the other modules.
//
// STATUS: wired in (index.html → Pack Order → 🚚 NTEX transport / 🧾 Visma quote, and Settings → 🔌
// Add-on bridge). Two ways to get a payload to the add-on, so this works today AND once the API lands:
//
//   1. PASTE (works now, no API at all): build the JSON here, copy it, paste it into the add-on's JSON box
//      (it understands `{"action":"ntex_order",…}` and `{"action":"create_quote",…}`). The add-on then
//      walks the person through it in the real NTEX/Visma page, attended.
//   2. JOBS API (`createAddonClient`): POST /v1/jobs, long-poll the job, confirm a booking. Contract:
//      addonvisma/extension/native-control-protocol.md ("Jobs API"), served as GET /v1/schema.
//
//      CAVEAT, by the add-on's own design: its localhost host sends NO CORS headers and rejects any
//      request carrying a browser `Origin` header ("the API intentionally rejects calls made by ordinary
//      web-page JavaScript"). A page served from GitHub Pages therefore cannot call it directly today —
//      the client reports that as `code: 'unreachable'` with an explanation instead of an opaque
//      "Failed to fetch". Using it from here needs one of: the add-on's host learning an allow-listed
//      Origin (an opt-in, off by default), or a small relay that calls it from a non-browser process.
//      Nothing in webware depends on either: the paste route is always there.
//
// The payload shapes are the add-on's own documented JSON (snake_case keys, metres, `postal_code`…).
// Nothing here ever invents data the add-on is told never to guess: a package's HEIGHT is never filled
// in for you, a missing receiver is reported, not defaulted.

import { vismaArticleNumber } from './visma-sync.js';
// Re-exported so index.html (which only gets this one module on `window.AddonBridge`) can show each
// line's Visma article number in the quote form without a second import.
export { vismaArticleNumber };

export const JOB_TYPES = Object.freeze({ NTEX_ORDER: 'ntex_order', CREATE_QUOTE: 'create_quote', ADD_ARTICLES: 'add_articles' });
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
// The add-on's job statuses (native-control-protocol.md). A job in one of the first three is over; the
// next two are waiting for a PERSON or for our confirmation and must never be polled past silently.
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const WAITING_STATUSES = Object.freeze(['needs_attention', 'awaiting_confirmation']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const positive = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined));

// ── addresses ───────────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort split of a free-text Swedish address into street / postal code / city. The Pack Order's
 * address box is one free-text field, but NTEX wants three. Anything it can't find is '' — the review
 * form shows blanks for a person to fill, never a guess.
 *   "Storgatan 34, 139 90 Värmdö"  ->  { street: 'Storgatan 34', postalCode: '13990', city: 'Värmdö' }
 */
export function parseAddress(text) {
  const out = { street: '', postalCode: '', city: '' };
  // Lines and commas both separate parts of an address.
  const parts = str(text).split(/[\n\r;,]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;
  const postalRe = /(^|\D)(\d{3})\s?(\d{2})(?!\d)/;
  const i = parts.findIndex((p) => postalRe.test(p));
  if (i < 0) {
    // No postal code at all: only a street can be guessed, from the first part that carries a number.
    out.street = parts.find((p) => /\d/.test(p)) || '';
    return out;
  }
  const m = parts[i].match(postalRe);
  const start = m.index + m[1].length;
  out.postalCode = m[2] + m[3];
  const before = parts[i].slice(0, start).replace(/[\s-]+$/, '');
  const after = parts[i].slice(m.index + m[0].length).replace(/^[\s-]+/, '');
  const next = parts[i + 1];
  out.city = after || (next && !/^(sverige|sweden|se|swe)$/i.test(next) ? next : '');
  // The street is whatever precedes the postal code on its own line, else the nearest earlier part
  // that carries a house number (a name line like "Exempel Bygg AB" has none).
  out.street = before || [...parts.slice(0, i)].reverse().find((p) => /\d/.test(p)) || '';
  return out;
}

// ── NTEX ────────────────────────────────────────────────────────────────────────────────────────

const PALLET_TYPES = new Set(['pall', 'pallet', 'halvpall', 'sjöpall']);

function party(p) {
  const x = p || {};
  return compact({
    name: str(x.name),
    street: str(x.street),
    postal_code: str(x.postalCode ?? x.postal_code).replace(/\s+/g, ''),
    city: str(x.city),
    phone: str(x.phone),
    contact_person: str(x.contactPerson ?? x.contact_person),
  });
}

function pkg(p) {
  const x = p || {};
  return compact({
    quantity: positive(x.quantity) || 1,
    type: str(x.type),
    goods: str(x.goods),
    weight_kg: positive(x.weightKg ?? x.weight_kg),
    length_m: positive(x.lengthM ?? x.length_m),
    width_m: positive(x.widthM ?? x.width_m),
    height_m: positive(x.heightM ?? x.height_m),
  });
}

/** millimetres -> metres (the add-on takes metres), '' / junk -> null. */
export function mmToMetres(mm) { const n = positive(mm); return n === null ? null : Math.round(n) / 1000; }

/**
 * The add-on's `ntex_order` JSON (README → "NTEX transport orders from JSON"). Input is camelCase, output
 * the add-on's own snake_case; every empty value is left OUT, because the add-on reports what is missing
 * rather than being handed blanks.
 */
export function buildNtexOrder({ from, to, loadDate, deliveryDate, invoiceReference, deliveryInstruction, packages } = {}) {
  return compact({
    action: JOB_TYPES.NTEX_ORDER,
    from: party(from),
    to: party(to),
    load_date: str(loadDate),
    delivery_date: str(deliveryDate),
    invoice_reference: str(invoiceReference),
    delivery_instruction: str(deliveryInstruction),
    packages: (Array.isArray(packages) ? packages : []).map(pkg),
  });
}

/**
 * What NTEX will refuse to book without (`required`) and what only produces a warning (`recommended`),
 * as people-readable labels — the rules the add-on documents ("NTEX refuses the order without: sender and
 * receiver name/street/postal code/city, the invoice reference, and each package's weight and
 * dimensions"). A pallet's length/width are assumed by the add-on (1.2 × 0.8 m); its height never is.
 */
export function ntexOrderProblems(order) {
  const o = order || {};
  const required = [];
  const recommended = [];
  for (const side of ['from', 'to']) {
    const p = o[side] || {};
    const who = side === 'from' ? 'Sender' : 'Receiver';
    for (const [key, label] of [['name', 'name'], ['street', 'street'], ['postal_code', 'postal code'], ['city', 'city']]) {
      if (!str(p[key])) required.push(`${who} ${label}`);
    }
    if (!str(p.phone)) recommended.push(`${who} phone`);
    if (!str(p.contact_person)) recommended.push(`${who} contact person`);
  }
  if (!str(o.invoice_reference)) required.push('Invoice reference');
  if (!str(o.load_date)) recommended.push('Load date');
  if (!str(o.delivery_date)) recommended.push('Latest delivery date');
  const packages = Array.isArray(o.packages) ? o.packages : [];
  if (!packages.length) required.push('At least one package');
  packages.forEach((p, i) => {
    const n = packages.length > 1 ? ` (package ${i + 1})` : '';
    if (!positive(p.weight_kg)) required.push(`Weight${n}`);
    if (!positive(p.height_m)) required.push(`Height${n}`);
    if (!PALLET_TYPES.has(str(p.type).toLowerCase())) {
      if (!positive(p.length_m)) required.push(`Length${n}`);
      if (!positive(p.width_m)) required.push(`Width${n}`);
    }
    if (!str(p.type)) recommended.push(`Package type${n}`);
    if (!str(p.goods)) recommended.push(`Goods description${n}`);
  });
  return { required, recommended };
}

// ── Visma ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The add-on's `create_quote` JSON (a quote saved as a DRAFT — a person always presses Save in Visma).
 * `lines` are `{ item, quantity, price? }` with `item` the app's own item object; the Visma article
 * number is the item's Item #3 (see visma-sync.js). A line without one can't be matched exactly, so it
 * falls back to the item's name (the add-on searches by "part of the article name" and asks the person
 * when that is ambiguous) and is reported in `warnings` so the review can show it.
 */
export function buildVismaQuote({ customer, lines, freightText } = {}) {
  const warnings = [];
  const items = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const quantity = positive(line && line.quantity);
    if (!quantity) continue;
    const item = (line && line.item) || {};
    const number = vismaArticleNumber(item);
    const name = str(item['itemname(english)'] || item['itemname(swedish)'] || line.name);
    const article = number || name;
    if (!article) continue;
    if (!number) warnings.push(`"${name}" has no Visma article number (Item #3) — it will be searched by name.`);
    items.push(compact({ article, quantity, price: positive(line.price) }));
  }
  const quote = compact({
    action: JOB_TYPES.CREATE_QUOTE,
    customer: str(customer),
    items,
  });
  // Left out entirely when not given, so the add-on's own default ("Frakt tillkommer.") applies; an
  // explicit null or '' is passed through untouched because the add-on reads it as "no freight row".
  if (freightText !== undefined) quote.freight_text = freightText;
  return { quote, warnings };
}

export function quoteProblems(quote) {
  const q = quote || {};
  const problems = [];
  if (!str(q.customer)) problems.push('Customer');
  if (!Array.isArray(q.items) || !q.items.length) problems.push('At least one line');
  return problems;
}

/** `add_articles` for items that don't exist in Visma yet (the article number is what Visma keys on). */
export function buildAddArticles(articles) {
  const rows = (Array.isArray(articles) ? articles : []).map((a) => compact({
    article_number: str(a.articleNumber ?? a.article_number),
    article_name: str(a.articleName ?? a.article_name),
    price_sek: positive(a.purchasePriceSek ?? a.price_sek),
    outprice_sek: positive(a.salesPriceSek ?? a.outprice_sek),
    stock_balance: Number.isFinite(Number(a.stockBalance)) && a.stockBalance !== '' && a.stockBalance !== null ? Number(a.stockBalance) : undefined,
  })).filter((r) => r.article_number && r.article_name);
  return { action: JOB_TYPES.ADD_ARTICLES, articles: rows };
}

/** The text for the paste route — what goes on the clipboard. */
export function toPasteJson(payload) { return JSON.stringify(payload, null, 2); }

// ── jobs API client ─────────────────────────────────────────────────────────────────────────────

export class AddonBridgeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'AddonBridgeError'; this.code = code; Object.assign(this, extra); }
}

/** 16–128 chars of [A-Za-z0-9._:-] — what the add-on demands of a write's requestId. */
export function makeRequestId(prefix = 'webware', now = Date.now, random = Math.random) {
  const clean = String(prefix).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 40);
  let id = `${clean}-${now().toString(36)}-${random().toString(36).slice(2, 10)}${random().toString(36).slice(2, 10)}`;
  while (id.length < 16) id += random().toString(36).slice(2);
  return id.slice(0, 128);
}

const UNREACHABLE_HINT = "Couldn't reach the add-on's local API. Either the add-on isn't running with its application API switched on, "
  + 'or the browser blocked the call — the add-on deliberately refuses requests that come from a web page '
  + "(no CORS). Until it gains an allowed-origin option, copy the JSON and paste it into the add-on's own box instead.";

/**
 * @param {{baseUrl?: string, token: string, fetchImpl?: typeof fetch, timeoutMs?: number}} cfg
 *   `token` is the add-on's generated bearer token (extension/native/vismascrap-native-config.json) —
 *   treat it like a password; the caller decides where it lives.
 */
export function createAddonClient({ baseUrl = DEFAULT_BASE_URL, token, fetchImpl, timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function call(method, path, body, { timeout = timeoutMs, signal } = {}) {
    if (!doFetch) throw new AddonBridgeError('unreachable', 'No fetch available in this environment.');
    if (!str(token)) throw new AddonBridgeError('no_token', 'No add-on token set — add it under Settings → Add-on bridge.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    if (signal && controller) signal.addEventListener('abort', () => controller.abort(), { once: true });
    let res;
    try {
      res = await doFetch(root + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new AddonBridgeError('timeout', 'The add-on did not answer in time.');
      throw new AddonBridgeError('unreachable', UNREACHABLE_HINT, { cause: e });
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* body is not JSON — reported below */ }
    if (res.ok) return data || {};
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const code = res.status === 401 ? 'unauthorized' : res.status === 503 ? 'not_connected' : res.status === 409 ? 'conflict'
      : res.status === 422 ? 'refused' : res.status === 429 ? 'rate_limited' : res.status === 400 ? 'bad_request' : 'http';
    throw new AddonBridgeError(code, code === 'unauthorized' ? 'The add-on rejected the token (it is rotated every time the host is re-registered).' : msg, { status: res.status, data });
  }

  const job = (data) => (data && data.job) || data;

  return {
    health: () => call('GET', '/v1/health'),
    schema: () => call('GET', '/v1/schema'),
    /** Submits a job; resolves with the queued job. `confirm`: 'human' (default) | 'api' | 'auto'. */
    async submitJob({ type, data, confirm = 'human', options, requestId } = {}) {
      if (!Object.values(JOB_TYPES).includes(type)) throw new AddonBridgeError('bad_request', `Unknown job type "${type}".`);
      const body = { requestId: requestId || makeRequestId(type), type, data, confirm };
      if (options) body.options = options;
      return job(await call('POST', '/v1/jobs', body));
    },
    async getJob(id, { wait = 0, since, signal } = {}) {
      const q = new URLSearchParams();
      if (wait) q.set('wait', String(Math.min(55, Math.max(1, Math.round(wait)))));
      if (since !== undefined && since !== null) q.set('since', String(since));
      const qs = q.toString();
      return job(await call('GET', `/v1/jobs/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, null, { timeout: wait * 1000 + 10000, signal }));
    },
    listJobs: async () => (await call('GET', '/v1/jobs')).jobs || [],
    /** `decision`: 'book' | 'cancel'. `previewHash` must be the one from the job you were shown. */
    async confirmJob(id, { decision, previewHash, requestId } = {}) {
      if (decision !== 'book' && decision !== 'cancel') throw new AddonBridgeError('bad_request', 'decision must be "book" or "cancel".');
      if (!str(previewHash)) throw new AddonBridgeError('bad_request', 'A preview hash is required — you can only confirm what you were shown.');
      return job(await call('POST', `/v1/jobs/${encodeURIComponent(id)}/confirm`, { requestId: requestId || makeRequestId('confirm'), decision, preview_hash: previewHash }));
    },
    cancelJob: async (id, { requestId } = {}) => job(await call('POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`, { requestId: requestId || makeRequestId('cancel') })),
    /**
     * Long-polls until the job finishes OR needs a person/our confirmation (`stopWhen` overrides),
     * calling onUpdate for each change. Resolves with the last job seen. Bounded: it gives up with
     * code 'timeout' after `maxPolls` rounds rather than polling forever.
     */
    async waitForJob(id, { onUpdate, stopWhen, signal, waitSeconds = 30, maxPolls = 200 } = {}) {
      const done = stopWhen || ((j) => TERMINAL_STATUSES.includes(j.status) || WAITING_STATUSES.includes(j.status));
      let since;
      for (let i = 0; i < maxPolls; i++) {
        if (signal && signal.aborted) throw new AddonBridgeError('aborted', 'Stopped waiting for the add-on.');
        const j = await this.getJob(id, { wait: waitSeconds, since, signal });
        if (j && j.seq !== undefined) since = j.seq;
        if (onUpdate) onUpdate(j);
        if (j && done(j)) return j;
      }
      throw new AddonBridgeError('timeout', 'The job is still running — check the add-on in the browser.');
    },
  };
}

/** One plain-language line for a job, for a status label (the add-on's own `message` wins when it has one). */
export function describeJob(j) {
  if (!j) return '';
  const price = j.preview && j.preview.price && j.preview.price.text ? ` Price: ${j.preview.price.text}.` : '';
  const text = {
    queued: 'Waiting for the add-on to pick it up…',
    awaiting_login: 'Waiting for NTEX login in the browser…',
    running: 'The add-on is working in the browser tab…',
    filling: 'Filling in the form…',
    needs_attention: 'Needs you — finish or cancel it in the browser tab.',
    awaiting_confirmation: `Ready to book — check the preview, then confirm.${price}`,
    booking: 'Booking…',
    completed: 'Done.',
    failed: 'Failed.',
    cancelled: 'Cancelled.',
  }[j.status] || String(j.status || '');
  return j.message && ['needs_attention', 'failed'].includes(j.status) ? `${text} ${j.message}` : text;
}
