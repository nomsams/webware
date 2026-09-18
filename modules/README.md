# modules/

Standalone JS building blocks for functionality discussed for the app. Most of these aren't
imported by `index.html` yet — nothing changes until a module is deliberately wired in — except
**`perspective-warp.js`**, **`groq-client.js`**, **`cors-proxy.js`**, **`web-search.js`**,
**`order-parser.js`**, **`contacts.js`**, **`email-sender.js`**, **`delivery-note-parser.js`**, and
**`visma-import.js`**, which are (via the
`<script type="module">` bridge near the end of `index.html`, since the rest of the app is one
classic script) — the first four back the 🤖 AI Assistant chat bubble, `order-parser.js` backs its
natural-language Pack Order action, `contacts.js` backs the Saved Recipients picker,
`email-sender.js` backs the "📧 Email Recipient" Compose Email modal — both on the Pack Order
screen — `delivery-note-parser.js` backs the "🧾 Delivery Note" scanner capture, and
`visma-import.js` backs the header's "📥 Import from Visma" button (see the README's Features/Data
Import Workflow sections for all of these). `img-square.js` remains unwired. Each
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
  Recipient info lookup is wired to `web-search.js` (`window.duckySearch`/`window.crawly`) — the
  same DuckDuckGo path the assistant's own `web_search` action uses — so a named recipient with no
  address gets one searched for automatically (`recipient.address`); the same lookup also tries to
  pick out an organization/registration number (`recipient.orgNumber`, e.g. Swedish
  `556677-8899` — `guessOrgNumber()`, preferring a labeled line like "Org.nr:"/"VAT" over a bare
  number-shaped match so a stray invoice/phone number isn't mistaken for one) across up to 3
  search results, since an address and an org number often live on different pages of the same
  site. index.html threads `recipient.orgNumber` through to the confirm card, the applied pack
  order's recipient fields (alongside name/address), and — since neither the `orders` table nor
  vCard has a slot for it — only into `buildPackOrderEmailTemplate()`'s optional "Org. no:" line
  and the local-only Saved Recipients entry, same treatment as the recipient's email address.
  `fromAddress` is the current warehouse's own name/address (via `getWarehouseMeta()`), not
  inferred from the text.

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
- **`delivery-note-parser.js`** — **wired in**, as the scanner modal's "🧾 Delivery Note" button:
  reads a photographed delivery note/packing slip ("följsedel") via a *multimodal* Groq model
  (`GROQ_MODELS.MULTIMODAL`, sent as an `image_url` content part alongside the extraction prompt —
  see `parseDeliveryNoteImage()`) rather than Tesseract OCR + text cleanup the way the "📝 Scan
  Text" button works — a vision model keeps the note's own layout/context (which column is qty vs.
  item number, which address block is the ship-to vs. the supplier's own letterhead) that flattened
  OCR text alone loses. `parseDeliveryNoteReply()` is the pure JSON-extraction half (same
  code-fence/prose-tolerant approach as `order-parser.js`'s `parseJsonReply`), returning
  `{ manufacturer, warehouseAddress, items: [{ name, itemNumber, quantity }] }`.
  `resolveDeliveryNoteItems()` is the pure matching half — dependency-injected `findByPartNumber`/
  `findByName` callbacks (index.html supplies its own `buildPartNumberIndex`/
  `findItemByAnyPartNumber` — the same offline part-number index CSV import uses — for the first,
  and `aiFuzzyFindItem()` gated to a *confident* match only, never a "did you mean?" guess, for the
  second) split each line into `matched` (existing item + computed `newQty`) or `unmatched`, so both
  halves are fully testable without a live inventory, a DOM, or a real vision call.

  index.html's `aiHandleDeliveryNoteScan()` wires the capture (a downscaled JPEG data URL — legible
  well below full camera resolution, and keeping the vision-call payload small actually matters here
  unlike local OCR) into a **two-step review before anything is written**, exactly as requested:
  Step 1 shows every matched line with an editable delivered-quantity and applies those via the same
  concurrency-safe `adjust_item_stock` RPC the item page's own stock stepper uses (never a raw
  overwrite); only once that's done does Step 2 show whatever didn't match as editable new-item
  proposals (name/manufacturer/item number/quantity, each skippable, or redirectable to an existing
  BTK typed in by hand) for `generateUniqueBTK()` + `resolveManufacturer()` to actually create.
  Both steps' writes share one `activity_log` `batch_id`, so the whole note — quantity updates and
  new items together — undoes as one action via the existing `undoImportBatch()`, the same mechanism
  a CSV import uses; nothing new was added to the schema for this. Requires Supabase mode (activity
  log/undo needs a real backend) and editor/maintainer/admin, same bar CSV import and manual stock
  edits already use.
- **`visma-import.js`** — **wired in**, as the header's "📥 Import from Visma" button (admin only —
  see below): turns a raw Visma article export plus an optional physical inventory-count file into
  per-destination-warehouse item drafts, pure/dependency-injected/unit-tested like
  `order-parser.js`/`delivery-note-parser.js`, no Supabase/DOM access at all.
  `classifySuffix()`/`KNOWN_ARTICLE_SUFFIXES` route each row by its article number's trailing
  company/city code (`MB`→Best, `BBD`/`GN`/`GJ`/`SN`→their own new warehouse, anything else — no
  suffix, or an unrecognized one — into one shared `UNRECOGNIZED_SUFFIX` bucket, confirmed against
  the real export rather than guessed).

  **Manufacturer** (`inferManufacturer()`): the count file's own `Företag` column first, then a
  later ("v3") export's own `manufacturers` column when the row has one, then `KNOWN_BRAND_PREFIXES`
  (brand names actually seen in this catalog, kept to ones frequent *and* distinctive enough to be
  a safe prefix check — a generic word like "Superior" or "Flex", also seen in the data at 1-2 rows
  each, is deliberately excluded), then a whitelisted model-code prefix (`CODE_PREFIX_MANUFACTURER`
  — see below) for a row missing the brand word itself, then `extractHanyStyleCode()`'s three regex
  shapes (HÄNY's own internal numbering turns up in names with or without the word "HÄNY" itself, so
  a shape match alone is treated as HÄNY specifically — the one case worth inferring from a code
  shape alone).

  **Item numbers** (`extractItemNumberCandidates()`, `firstTwoDistinctCodes()`): `artikelnr`
  (Visma's own code) is always Item #3 ("internal"). Item #1/#2 come from pooling every source that
  might have one and taking the first two genuinely distinct values, in priority order: the count
  file's own manually-verified `Artikelnummer` (wins outright), a still-later ("v6") export's own
  `article_code_1`/`article_code_2` columns (already extracted by whatever produced that file —
  covering shapes this module's own regex whitelist doesn't, like `TE3549R25WS`/`CF2016PF`, for
  roughly a third of rows), then up to two *distinct* codes pulled from the raw name itself for
  whatever a higher source didn't already cover — a dotted code (`794.035`, optional trailing
  letter), a letter-dash-digits code (`D-2728`), a digits-dash-letters-dash-digits code
  (`2261-CS-11`), a bare 6-8 digit part number (`1012785`), and a whitelisted "model-code prefix +
  digits" shape (`REP 990`/`EXM 731` for Weber, `TE 726` for TEI, `IC 311`/`ZMP 725`/`MF 80` for
  HÄNY). That last one is deliberately a curated whitelist rather than "any 2-5 letters" — checked
  against the full real export, a generic version of it matches plenty of ordinary descriptive words
  followed by a measurement or weight ("RING 142" from "O-RING 142,5 X...", "VIT 25" = "white, 25
  kg", cement grade "LL 42", etc.), which would have been a wrong item number every time. A name
  carrying two different shapes at once (common for HÄNY, e.g. `"793.539 HÄNY LUFTFILTER HPU6
  H-5075"`) yields both, same as before — the v6 columns are additive, not a replacement for rows
  that don't have them (roughly two-thirds of the real export still relies on this regex fallback).

  **Display name**: the same "v6" export's own `clean_name` column (the product description with
  the brand and any part numbers already stripped, e.g. `"KOMPLETT RESERVDELSLÅDA"` for a raw name
  of `"TEI TE 726 KOMPLETT RESERVDELSLÅDA"`) is used as the item's name when a row has one, falling
  back to the raw `artikelnamn` otherwise. Manufacturer inference and the regex item-number fallback
  above always run against the RAW name regardless — `clean_name` has the brand word deliberately
  removed, which is exactly the signal `inferManufacturer()`/`findBrandPrefix()` need, and running
  extraction against an already-stripped name would find less, not more.

  **Units** (`mapEnhetToUnitType()`): Visma's `enhet` column (Swedish unit words) is mapped onto
  webware's own `UNIT_TYPES` (index.html) rather than used verbatim, so the app's Add/Edit-item
  dropdown and this import agree on one canonical value — falls back to `'st'` for anything
  unrecognized, same as `itemToSupabaseRow()` already does for any `UnitType` outside `UNIT_TYPES`.

  **Quantity** (`resolveQuantity()`): prefers the count file's physically-counted `Antal` when a row
  matches one; otherwise Visma's own `ant_i_lager` is used only when non-negative — it's unreliable
  in the wild (frequently deeply negative in the real export), so a negative reading (from either
  source) becomes `0` with a comment recording what it actually said rather than being trusted.

  **Location** (`parsePlatsLocation()`): the count file's own `Plats` wins when a row matches one,
  else a later export's own `location` column on the row itself (same values, same 62 Best rows) —
  either way turned into a real `LocationCode` (confirmed field-by-field against the actual
  warehouse: Zone, Depth, Level, Bin, Row — see the README's "Bin Location Codes" section).

  `buildVismaImportDraft()` ties all of this together, joining the (optional) count file by article
  number and grouping the result by destination warehouse.

  index.html's own code (no separate module, since it's all Supabase/DOM work) does the actual
  writing, reusing the same `generateUniqueBTK()`/`logActivity()` every other write path uses —
  both take an optional `{existingItems, warehouseId}` / `{warehouseId, userId}` argument (instead
  of always assuming "whichever warehouse is currently open") specifically so one import run can
  create and populate several warehouses without needing its own duplicate copies of either
  function. A review table (every field editable, grouped by destination, new-warehouse names
  editable or skippable) sits between parsing and any write; choosing to import into Best requires
  typing a confirmation phrase, since it deletes every current Best item — photos included, via
  `storagePathFromPublicUrl()` same as `deleteItemPhotoRow()` — before adding the reviewed set.
  Every write from the whole run (Best's deletions and every warehouse's new items) shares one
  `activity_log` batch, reverting as a single `undoImportBatch()` call, unchanged from how a CSV
  import already uses it.
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
- **`email-sender.js`** + **`../supabase/functions/send-email/index.ts`** — **wired in and deployed**,
  as the "📧 Email Recipient" Compose Email modal on the Pack Order screen (a template dropdown
  prefills subject/body via `buildPackOrderEmailTemplate()` — including an optional "Ship to: …" /
  "Org. no: …" block when the recipient's address/org number are known, e.g. from
  `order-parser.js`'s web-search lookup or a Saved Recipient — both stay fully editable either way).
  Sends email via SMTP (Gmail, personal Outlook.com/Hotmail (`outlook` preset), a Microsoft
  365/Exchange Online work mailbox (`office365` preset — a genuinely different host/auth story than
  personal Outlook, see the function's own doc comment), one.com, or a custom host), credentials
  held as Supabase secrets, same pattern as `GROQ_API_KEY` — **still needs those secrets actually
  set** (`supabase secrets set SMTP_PROVIDER=... SMTP_USER=... SMTP_PASSWORD=...`, see the function's
  own doc comment for the full list and per-provider notes) before "📧 Send Email" will work; until
  then it fails with a clear "SMTP is not configured" message rather than a silent/opaque error. A
  failed send past that point gets an actionable hint appended for the two most common real-world
  failures — Microsoft's tenant-wide SMTP AUTH block (`office365` specifically) and a wrong-password
  mixup (a real sign-in password instead of an app password) — rather than just the SMTP server's
  own cryptic rejection text. The function requires editor/maintainer/admin (checked server-side
  against `profiles.role`, not just "signed in" — sending mail as the org's own SMTP identity to an
  arbitrary recipient is sensitive enough to need the same bar the rest of the app uses for writes)
  and validates `to`/`subject` (a real email shape, no `\r\n`) before handing anything to the SMTP
  client, as defense in depth against header injection. "✉️ Mail App" (`buildMailtoLink()`) is the
  zero-backend alternative next to it — always available, no deployment needed, just opens the
  user's own mail client with everything prefilled; nothing is sent until they hit send there
  themselves. **Not exercised against a live SMTP server** (no Deno runtime available in this
  environment) — the `denomailer` usage follows its documented API (confirmed against its own
  README: `tls: true` is full TLS, `tls: false` is STARTTLS, which is what both Outlook presets rely
  on at port 587) but verify it end-to-end once real SMTP secrets are set, especially for a
  mailbox/tenant this hasn't been tried against yet.

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
