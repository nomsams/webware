# modules/

Standalone JS building blocks for functionality discussed for the app. Most of these aren't
imported by `index.html` yet — nothing changes until a module is deliberately wired in — except
**`perspective-warp.js`**, **`groq-client.js`**, **`cors-proxy.js`**, and **`web-search.js`**,
which are (via the `<script type="module">` bridge near the end of `index.html`, since the rest of
the app is one classic script) — they back the 🤖 AI Assistant chat bubble (see the README's
Features list). `order-parser.js`, `img-square.js`, `contacts.js`, and `email-sender.js` remain
unwired. Each file has a `STATUS:` header comment saying which. Run all tests with:

```bash
node --test modules/tests/*.test.js
```

## What's here

- **`groq-client.js`** + **`../supabase/functions/groq-proxy/index.ts`** — chat with Groq-hosted
  models (model + reasoning-effort selectable, streaming supported) and Whisper audio
  transcription, with the API key held server-side — not in the browser, and not even in the Edge
  Function's own secrets, but in the `llm_api_keys` table (`supabase/schema_llm_assistant.sql`),
  shared across every app user with optional backup keys the function falls through to on a rate
  limit. RLS has no `select` policy on that table at all, so no client can ever read a key back.
  Deploy the function (`supabase functions deploy groq-proxy` — no secrets to set) and add at least
  one key from Settings → AI Assistant before this does anything real. Backs the 🤖 AI Assistant
  chat bubble's classification/reply calls and voice transcription.
- **`cors-proxy.js`** + **`../supabase/functions/cors-proxy/index.ts`** — CORS-proxy fetch client,
  used by `web-search.js`. Configured once from the module bridge in `index.html`, so it calls
  webware's own `cors-proxy` Edge Function first, falling back to public proxies and finally a
  direct fetch. See the `chikibriki` note below.
- **`web-search.js`** — DuckDuckGo search + page-text extraction, ported from
  `github.com/nomsams/timeline` (the search) with a cleanup approach mirroring
  `github.com/nomsams/crawly` (the text extraction). Depends on `cors-proxy.js`. Backs the AI
  Assistant's web-search action, as `window.duckySearch`/`window.crawly` — bounded to one search
  page and one page fetch each, no pagination or recursive crawling.
- **`order-parser.js`** — the actual feature behind "a box where we can write or paste something
  like 'plocka item 1 and item 2...'": turns free text into a structured
  `{ items, recipient, from }` pack-order draft via `groq-client.js`. Each item reference is
  resolved to a real BTK + quantity in order: an exact match against a pre-loaded item list, a
  bare BTK number used as-is, or a live database search via a caller-supplied
  `searchItemCandidates(text)` function (scoped to the current warehouse), scored by
  `bestCandidateMatch()` to find the closest hit. Optionally uses `web-search.js` to look up a
  recipient's address when the text names them but doesn't give one. `fromAddress` is passed
  straight through (it's the app's own known data — the warehouse's address — not something to
  infer from free text).

  **Multi-warehouse handling**: orders are already single-warehouse (`orders.warehouse_id`) and,
  per the user, pack orders are only ever sent from one warehouse at a time — so item resolution
  deliberately never crosses warehouses; `searchItemCandidates` should always filter
  `.eq('warehouse_id', currentWarehouseId)`. The same physical product existing as a separate row
  in another warehouse is still visible, though: an optional `searchOtherWarehouses(text)`
  callback (querying `.neq('warehouse_id', currentWarehouseId)`) attaches a non-blocking
  `elsewhere: { btk, name, warehouseId, quantity }` note to an otherwise-unresolved item — e.g.
  "not here, but 12 in Warehouse 2" — for a human to act on, never an automatic substitution. No
  schema change was needed for this: items already carry `manufacturer` + `itemnumber` (the
  manufacturer's own part number), which is what actually identifies "the same product" across
  warehouses if you want to match on that instead of by name.
- **`img-square.js`** — pads an image to a square, filling the new space with a solid color or a
  color sampled from the image's own edges. Ported from `github.com/nomsams/imgsquare`. Intended
  to slot into the existing item-photo/manufacturer-logo canvas editor as an extra step.
- **`contacts.js`** — minimal hand-rolled vCard (`.vcf`) parse/export, same approach as
  `github.com/nomsams/contactview`. Intended for a future "saved recipients" picker on Pack
  Order — import contacts from a phone's exported `.vcf`, pick one to fill the recipient fields.
  contactview's autosave (plain `localStorage`) and "Google Calendar sync" (turned out to be a
  `calendar.google.com` deep link / `.ics` download, not a real API integration) weren't ported —
  neither is more than a few lines to add directly wherever this ends up wired in, if wanted.
- **`email-sender.js`** + **`../supabase/functions/send-email/index.ts`** — sends email via SMTP
  (Gmail/Outlook/one.com presets, or a custom host for your own server), credentials held as
  Supabase secrets, same pattern as `GROQ_API_KEY`. Also exports `buildMailtoLink()`, a
  zero-backend fallback that just opens the user's own mail client with everything prefilled, and
  `buildPackOrderEmailTemplate()`, which turns an `order-parser.js`-shaped draft into a ready
  subject/body. **Not exercised against a live SMTP server** (no Deno runtime available in this
  environment) — the `denomailer` usage follows its documented API but verify it end-to-end once
  deployed. See the function's doc comment for the Gmail app-password requirement and the Outlook
  basic-auth caveat (Microsoft has disabled it for most tenants since 2022–2023 — confirm yours
  still allows it before relying on that preset).

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
and timeline (two of the reference repos this was ported from) hardcode a fallback proxy key,
`"chikibriki"`, in cleartext in their own public source, against a CORS-proxy Edge Function on a
Supabase project (`onbkfqayveownervyktu`) that belongs to those repos, not to webware. That value
was never actually secret — it's a conventional gate value, the same way an API's public client ID
isn't secret. `modules/cors-proxy.js` keeps `chikibriki` as its own default `x-proxy-key` (for
parity, per request), sent to **webware's own** `cors-proxy` Edge Function rather than the other
project's — that function's real protection is requiring a signed-in Supabase user, same as
`groq-proxy`. `CORS_PROXY_KEY` is an optional extra secret-side check if you want it, but the auth
requirement is what actually gates the function.

## Not ported as a separate module

- **timeline's DuckDuckGo search** — already covered by `web-search.js` (that's literally where
  the search logic was ported from).
- **contactview's Google Calendar "sync"** — see above; it's a deep link / `.ics` download, not
  an API integration worth its own module.
