# modules/

Standalone JS building blocks for functionality discussed for the app. Most of these aren't
imported by `index.html` yet — nothing changes until a module is deliberately wired in — except
**`perspective-warp.js`**, **`groq-client.js`**, **`cors-proxy.js`**, **`web-search.js`**,
**`order-parser.js`**, **`contacts.js`**, and **`email-sender.js`**, which are (via the
`<script type="module">` bridge near the end of `index.html`, since the rest of the app is one
classic script) — the first four back the 🤖 AI Assistant chat bubble, `order-parser.js` backs its
natural-language Pack Order action, `contacts.js` backs the Saved Recipients picker, and
`email-sender.js` backs the "📧 Email Recipient" Compose Email modal — both on the Pack Order
screen (see the README's Features list for all of these). `img-square.js` remains unwired. Each
file has a `STATUS:` header comment saying which. Run all tests with:

```bash
node --test modules/tests/*.test.js
```

## What's here

- **`groq-client.js`** + **`../supabase/functions/groq-proxy/index.ts`** — chat with Groq-hosted
  models (model + reasoning-effort selectable, streaming supported) and Whisper audio
  transcription. `createGroqClient()` supports two modes:
  - **Proxy mode** (`{supabaseUrl, supabaseAnonKey, getAccessToken}`): the API key is held
    server-side — not in the browser, and not even in the Edge Function's own secrets, but in the
    `llm_api_keys` table (`supabase/schema_llm_assistant.sql`), shared across every app user with
    optional backup keys the function falls through to on a rate limit. RLS has no `select` policy
    on that table at all, so no client can ever read a key back. Requires `groq-proxy` deployed
    (`supabase functions deploy groq-proxy` — no secrets to set).
  - **Direct mode** (`{apiKey}`): calls `api.groq.com` straight from the browser with that key —
    confirmed against the live API that both `/chat/completions` and `/audio/transcriptions` send
    the CORS headers a cross-origin browser request needs, so this needs no Edge Function at all.
    Meant for a personal, free-tier key one person brings for their own use (it's as visible as any
    client-embedded key), not a shared one.

  index.html's `aiGetGroqClient()` picks direct mode when a personal key is set in Settings
  (`localStorage`, per-device) and proxy mode otherwise — see the README's AI Assistant section.
  Backs the 🤖 AI Assistant chat bubble's classification/reply calls and voice transcription either way.
- **`cors-proxy.js`** + **`../supabase/functions/cors-proxy/index.ts`** — CORS-proxy fetch client,
  used by `web-search.js`. Configured once from the module bridge in `index.html`, so it calls
  webware's own `cors-proxy` Edge Function first (once deployed), then the known external
  chikibriki-gated proxy (`KNOWN_EXTERNAL_PROXY_URL` — always tried, no opt-in needed, so web
  search works even before webware's own function is deployed), then — only if the user has opted
  into it in Settings — fully-public proxies, then finally a direct fetch. See the `chikibriki`
  note below.
- **`web-search.js`** — DuckDuckGo search + page-text extraction, ported from
  `github.com/nomsams/timeline` (the search) with a cleanup approach mirroring
  `github.com/nomsams/crawly` (the text extraction). Depends on `cors-proxy.js`. Backs the AI
  Assistant's web-search action, as `window.duckySearch`/`window.crawly` — bounded to one search
  page and one page fetch each, no pagination or recursive crawling.
- **`order-parser.js`** — **wired in**, as the AI Assistant's `pack_order` action (alongside
  `pack_kit`, for a single named kit): "pack 2 bolts and 1 gasket for Anna Andersson, look up her
  address" turns into a structured `{ items, recipient, from }` pack-order draft via
  `groq-client.js`. Each item reference is resolved to a real BTK + quantity in order: an exact
  match against the currently loaded item list, a bare BTK number used as-is, or (in index.html)
  `aiFuzzyFindItem()` — the same fuzzy matcher `search_item`/`pack_kit` use — as
  `searchItemCandidates`, scored by `bestCandidateMatch()` to find the closest hit. This works
  offline too, since it's scored against the already-loaded catalog rather than a live query.
  Recipient address lookup is wired to `web-search.js` (`window.duckySearch`/`window.crawly`) —
  the same DuckDuckGo path the assistant's own `web_search` action uses — so a named recipient
  with no address gets one searched for automatically. `fromAddress` is the current warehouse's
  own name/address (via `getWarehouseMeta()`), not inferred from the text.

  **Multi-warehouse handling**: orders are already single-warehouse (`orders.warehouse_id`) and,
  per the user, pack orders are only ever sent from one warehouse at a time — so item resolution
  deliberately never crosses warehouses; index.html's `searchItemCandidates` only ever looks at
  `globalInventory` for the currently open warehouse. The module also accepts an optional
  `searchOtherWarehouses(text)` callback (querying `.neq('warehouse_id', currentWarehouseId)`) that
  would attach a non-blocking `elsewhere: { btk, name, warehouseId, quantity }` note to an
  otherwise-unresolved item — e.g. "not here, but 12 in Warehouse 2" — for a human to act on, never
  an automatic substitution; **not currently wired from index.html** (would need a live
  cross-warehouse Supabase query, which the static/offline warehouses can't do anyway), so an
  unresolved item today just stays unresolved for the user to fix by hand. No schema change is
  needed to add it later: items already carry `manufacturer` + `itemnumber` (the manufacturer's own
  part number), which is what actually identifies "the same product" across warehouses if you want
  to match on that instead of by name.
- **`img-square.js`** — pads an image to a square, filling the new space with a solid color or a
  color sampled from the image's own edges. Ported from `github.com/nomsams/imgsquare`. Intended
  to slot into the existing item-photo/manufacturer-logo canvas editor as an extra step.
- **`contacts.js`** — **wired in**, as the Saved Recipients picker on the Pack Order screen: minimal
  hand-rolled vCard (`.vcf`) parse/export, same approach as `github.com/nomsams/contactview`.
  `window.parseVCardFile`/`window.generateVCard` import a phone-exported `.vcf` (adding/updating
  recipients by name) and export one saved recipient back out; the saved list itself is plain
  `{name, address}` objects in `localStorage` (`webware-saved-recipients`, per-device, never
  synced), not vCard text, so the picker doesn't need to reparse on every open. contactview's
  autosave (plain `localStorage`) and "Google Calendar sync" (turned out to be a
  `calendar.google.com` deep link / `.ics` download, not a real API integration) weren't ported —
  neither is more than a few lines to add directly wherever this ends up wired in, if wanted.
- **`email-sender.js`** + **`../supabase/functions/send-email/index.ts`** — **wired in**, as the
  "📧 Email Recipient" Compose Email modal on the Pack Order screen (a template dropdown prefills
  subject/body via `buildPackOrderEmailTemplate()`, both stay fully editable either way). Sends
  email via SMTP (Gmail/Outlook/one.com presets, or a custom host for your own server), credentials
  held as Supabase secrets, same pattern as `GROQ_API_KEY` — **requires `send-email` deployed and
  those secrets set** (`supabase functions deploy send-email`, then the `supabase secrets set ...`
  calls in the function's own doc comment) before "📧 Send Email" will work; until then it fails
  with a clear "SMTP is not configured" message rather than a silent/opaque error. The function
  requires editor/maintainer/admin (checked server-side against `profiles.role`, not just "signed
  in" — sending mail as the org's own SMTP identity to an arbitrary recipient is sensitive enough to
  need the same bar the rest of the app uses for writes) and validates `to`/`subject` (a real email
  shape, no `\r\n`) before handing anything to the SMTP client, as defense in depth against header
  injection. "✉️ Mail App" (`buildMailtoLink()`) is the zero-backend alternative next to it — always
  available, no deployment needed, just opens the user's own mail client with everything prefilled;
  nothing is sent until they hit send there themselves. **Not exercised against a live SMTP server**
  (no Deno runtime available in this environment) — the `denomailer` usage follows its documented
  API but verify it end-to-end once deployed. See the function's doc comment for the Gmail
  app-password requirement and the Outlook basic-auth caveat (Microsoft has disabled it for most
  tenants since 2022–2023 — confirm yours still allows it before relying on that preset).

  **On the recipient's email address and GDPR**: index.html deliberately never adds it to the
  `orders` table (which is already synced/backed-up/admin-visible across the org) — it only ever
  lives in the Compose Email modal's own field for that one send, and, only if the user explicitly
  chooses to, in the local-only Saved Recipients list (`localStorage`, per-device, never synced —
  see the README's Saved Recipients entry) with its own per-entry Delete and a "Clear All" for an
  easy right-to-erasure request. That design keeps the blast radius small, but storing a browser's
  worth of contact data doesn't *by itself* decide GDPR compliance for a given deployment — that's
  a call for whoever runs this app to make (lawful basis, retention, telling recipients their data
  is held, etc.), not something a code comment can certify.

- **`perspective-warp.js`** — **wired in** (see above), unlike everything else on this list. Straightens
  a rack/aisle photo taken at an angle into a flat top-down rectangle — mark the 4 corners of the
  rack face, and `solveHomography()` (a standard 4-point-correspondence DLT solve via Gaussian
  elimination) + `warpImageToRect()` (inverse-mapped, bilinearly-sampled pixel warp, pure Canvas
  2D — no WebGL, since a one-time still-image correction doesn't need GPU shaders) do the rest,
  the same linear-algebra approach document-scanner apps use. Also includes an optional
  measurement-calibration path (`distanceBetweenPoints`/`computeScale`/`pixelsToReal`): click two
  points on the straightened photo and say what real-world distance they span, to convert other
  pixel distances in that same photo into real units later.

## Security note: API keys in a static, client-only site

`index.html` is served as-is from GitHub Pages — anything written into it, including an API key,
is visible to anyone who views page source. That's why none of `groq-client.js`, `cors-proxy.js`,
or `email-sender.js` hold a real credential themselves: each calls a Supabase Edge Function that
holds the actual secret server-side and only accepts requests from signed-in app users. `groq-proxy`
reads its key(s) from the `llm_api_keys` table via the function's service-role credentials (see
above) rather than a function secret; `send-email` still uses a function secret (`SMTP_PASSWORD`,
etc.) — either shape keeps the credential off the client, which is the part that actually matters.
Prefer one of these over a client-embedded key for any future proxy this app adds.

`cors-proxy.js`'s `chikibriki` default is a different case, worth understanding separately: crawly
and timeline (two of the reference repos this was ported from — same author as webware) hardcode a
fallback proxy key, `"chikibriki"`, in cleartext in their own public source, against a CORS-proxy
Edge Function on Supabase project `onbkfqayveownervyktu` — that project's, not webware's own. That
value was never actually secret — it's a conventional gate value, the same way an API's public
client ID isn't secret, and (being a shared public-utility function across that author's own
projects) doesn't require a signed-in user of *that* project. `modules/cors-proxy.js` sends
`chikibriki` two places: as its own default `x-proxy-key` to **webware's own** `cors-proxy` Edge
Function (that function's real protection is requiring a signed-in Supabase user, same as
`groq-proxy` — `CORS_PROXY_KEY` is an optional extra secret-side check on top, but auth is what
actually gates it), and to `KNOWN_EXTERNAL_PROXY_URL` — the *other* project's cors-proxy, called
directly, no webware credentials involved. That second one is a genuinely useful fallback for
"webware's own function isn't deployed yet," at the cost of that other project's own logs seeing
the URL/query in the clear whenever it's actually used — pass `useKnownExternalProxy: false` to
`corsFetch()` (or wherever that's threaded through) if that trade-off isn't wanted for a given call.

## Not ported as a separate module

- **timeline's DuckDuckGo search** — already covered by `web-search.js` (that's literally where
  the search logic was ported from).
- **contactview's Google Calendar "sync"** — see above; it's a deep link / `.ics` download, not
  an API integration worth its own module.
