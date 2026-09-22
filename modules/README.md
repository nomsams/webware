# modules/

Standalone JS building blocks for functionality discussed for the app. Most of these aren't
imported by `index.html` yet — nothing changes until a module is deliberately wired in — except
**`perspective-warp.js`**, **`groq-client.js`**, **`cors-proxy.js`**, **`web-search.js`**,
**`order-parser.js`**, **`contacts.js`**, **`email-sender.js`**, **`delivery-note-parser.js`**,
**`visma-import.js`**, **`visma-sync.js`**, **`iso-rack.js`**, **`json-extract.js`**, **`label-fit.js`**, and **`kit-relink.js`**, which are (via the
`<script type="module">` bridge near the end of `index.html`, since the rest of the app is one
classic script) — the first four back the 🤖 AI Assistant chat bubble, `order-parser.js` backs its
natural-language Pack Order action, `contacts.js` backs the Saved Recipients picker,
`email-sender.js` backs the "📧 Email Recipient" Compose Email modal — both on the Pack Order
screen — `delivery-note-parser.js` backs the "🧾 Delivery Note" scanner capture, and
`visma-import.js` backs the header's "📥 Import from Visma" button, and `iso-rack.js` draws the
isometric bin locator and the Warehouse page's dimensions preview (see the README's Features/Data
Import Workflow/Warehouse Page sections for all of these). `img-square.js` remains unwired. Each
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
  webware's own `cors-proxy` Edge Function first (once deployed), then — **only if the user has
  opted in** via Settings → "Allow public CORS proxy fallback for web search" — the known external
  chikibriki-gated proxy (`KNOWN_EXTERNAL_PROXY_URL`, on the author's other Supabase project) and
  the fully-public proxies, then finally a direct fetch. With that switch off (the default) a
  failing own proxy goes straight to the direct fetch, so a search query never reaches another
  server unasked — the shared proxy used to be tried unconditionally, which contradicted what
  Settings promised. See the `chikibriki` note below.

  The Edge Function requires a signed-in user and refuses internal targets (loopback,
  private/link-local/CGNAT ranges, cloud-metadata names, IPv6 literals, `localhost.`-style
  trailing-dot names) — and follows redirects by hand, re-checking **every hop**, since a public page
  that answers `302 → http://169.254.169.254/…` would otherwise walk straight past a check that only
  looked at the first URL. DNS rebinding to a private address isn't covered (Deno's `fetch` exposes
  no resolve hook).
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
  `lookupEnhetUnitType()` is the strict form of the same table: `null` for an unrecognized word
  instead of `'st'`, so a caller can tell a real "Styck" from "no idea" — index.html uses it (via
  `unitTypeFromText()`) in the plain Items import and in Quick Update, where an unknown unit should
  be left alone rather than overwritten with a guess.

  **Quantity** (`resolveQuantity()`): prefers the count file's physically-counted `Antal` when a row
  matches one; otherwise Visma's own `ant_i_lager` is used only when non-negative — it's unreliable
  in the wild (frequently deeply negative in the real export), so a negative reading (from either
  source) becomes `0` with a comment recording what it actually said rather than being trusted.
  Each item also carries `vismaQty`, Visma's own figure raw and untouched — deliberately *not* the
  corrected quantity above. index.html stores it as the item's sync baseline, so a later Visma Sync
  can tell whether Visma has moved since; the corrected number would claim the two already agree.

  **Location** (`parsePlatsLocation()`): the count file's own `Plats` wins when a row matches one,
  else a later export's own `location` column on the row itself (same values, same 62 Best rows) —
  either way turned into a real `LocationCode` (confirmed field-by-field against the actual
  warehouse: Zone, Depth, Level, Bin, Row — see the README's "Bin Location Codes" section). The
  notation `A 3-3 1-1` *is* webware's code, so the result is the same text, only tidied (upper-case
  zone, single spaces, no leading zeros, Row always present). ASCII zone letters only — that is all
  the database's CHECK accepts, so an `Å 1-2 3-1` is not a coordinate and stays as text. A value that
  parses is *moved*: `locationCode` is set and `inventoryLocation` is left `null`; one that doesn't
  parse keeps its raw text in `inventoryLocation`. (index.html does the same tidy-up for every other
  write path with its own `normalizeBinCode()`, which also reads the older `A3-2-02` notation.)

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
- **`iso-rack.js`** — **wired in**, as the Settings-gated "🧊 Isometric bin locator" (off by
  default) and the Warehouse page's "📏 Dimensions & 3D View" panel. Isometric drawings as plain SVG
  strings — no DOM, no Supabase, same as the other modules; index.html decides where the markup goes
  and handles the clicks (`data-depth`/`data-level`/`data-bin` on bins, `data-zone` on floor blocks).
  Three exports beyond the constants:
  - `resolveRackGeometry(zone, bounds, extra)` — turns a `warehouse_zones` row (all sizes optional,
    in cm: rack width per bay/depth/height, shelf width/depth/clear-height, bin width/depth/height,
    plus `rack_style`) and the zone's Depth/Level/Bin counts into one geometry object, whose `style`
    field is `'pallet'` or `'shelving'` (`z.rack_style === 'shelving'` picks the latter, anything
    else — including unset — is `'pallet'`, matched against real photos of this warehouse's own two
    kinds of racking rather than one generic shape for everything). Anything not recorded falls back
    to a schematic default so the picture still reads, and the result's `recorded` field says which
    values were real — that's what lets the callouts show a dashed "≈" for a guess and a solid value
    for a measurement. Junk (negative, zero, `NaN`, text, an unrecognized `rack_style`) counts as not
    recorded. A bin/Row beyond the configured size (`extra.minBin`/`minRows`) widens the picture
    instead of falling off it.
  - `buildIsoRackSVG(geom, opts)` — one rack area, drawn to match `geom.style`: **pallet racking**
    gets a thick orange beam at each level (`iso-beam-top/front/side` — no solid deck, since a pallet
    sits directly on the beams) and yellow corner guards at floor level on the nearest rack
    (`iso-foot`); **shelving** gets a solid shelf board at each level (`iso-board-top/front/side`,
    the original single style) and a diagonal X cross-brace per bay up the back (`iso-brace`).
    Uprights (`iso-post`) are a fixed rack-blue either way — real racking is painted blue regardless
    of the app's light/dark theme, unlike the rest of the drawing, which follows it through
    CSS-variable classes. All of this is semi-transparent so the located bin (`opts.highlight`) —
    one **solid blue** box with a coordinates pill, painted at its true depth in painter's order plus
    an opaque-ish overlay copy — reads through a rack standing in front of it, in both styles.
    `opts.occupied` tints bins that hold items (the Bin Locator), `opts.selected` outlines a shelf,
    `opts.interactive` adds the `data-*` hooks, `opts.showDimensions` / `opts.sampleBin` add the
    measurement callouts and a sample bin for the dimensions panel. Empty-bin outlines are dropped
    past ~2500 bins so a huge rack stays cheap; occupied/selected bins never are.
  - `buildIsoFloorSVG(zones, opts)` — the whole floor: each *placed* zone (`grid_col`/`grid_row`) as a
    translucent block at its real footprint, the located bin marked inside its own zone, `''` when no
    zone is placed at all (so the caller can say why instead of showing an empty canvas).
  - `formatLocationCode()` builds the same `Zone Depth-Level Bin-Row` text the app's own codes use
    (`A 3-2 2-1`, Row always written), so the on-picture label always matches the field.

  Tested in `tests/iso-rack.test.js` (geometry fallbacks/derivations, `rack_style` resolution
  including junk values, opacity of rack vs. bin for both styles, which classes each style actually
  draws (beam/foot-guard for pallet, board/brace for shelving — and never the other style's), label
  escaping, occupied/selected/interactive markup, dimension callouts, and "every renderer stays finite
  over odd inputs"). SQL for the sizes it reads is `supabase/schema_zone_dimensions.sql`.
- **`json-extract.js`** — **wired in**: reads JSON objects out of free-form model output. Used by
  `order-parser.js` and `delivery-note-parser.js` for their replies and, as
  `window.extractJsonObjects`, by the AI assistant to read which action a reply asks for. Replaces
  the greedy `/\{[\s\S]*\}/` those three each used, which ran from the first `{` to the LAST `}` in
  the whole reply — so a brace anywhere after the JSON ("…{see note}"), or a stray one before it,
  made the span invalid and the whole (perfectly good) reply was rejected. It scans instead: from
  each `{` it finds the matching `}` (skipping braces inside strings, honouring `\"` escapes) and
  keeps the piece only if it parses. `extractJsonObjects()` returns the top-level objects in order;
  `lastJsonObject(text, accept)` picks the last one satisfying a predicate — the final answer, when a
  model quotes a draft or thinks aloud first. Tested in `tests/json-extract.test.js`.
- **`visma-sync.js`** — **wired in**, as Settings → 🔄 Visma Sync and the "Visma stock" line on an
  item's page. Keeping webware and Visma in step through the VismaScrap add-on's own CSV files.
  Everything turns on one stored number per item, the **baseline** (`items.visma_qty`): what Visma
  held at the last sync. With W = ours and V = Visma's, `W != B and V = B` is a safe push, `W != B
  and V != B` means someone sold or received in Visma and must never be overwritten silently, and
  `W = B and V != B` is a pull. `syncStateFor()` names the four states (`in-sync` / `pending` /
  `never-synced` / `no-number` — Visma's article number lives in Item #3) and the delta a push would
  apply. `buildSyncExport()` writes rows under the add-on's *own* column names (`visma_artikelnummer`,
  `Antal`, `Produktnamn`) so its inventory importer needs no mapping by hand, plus `Antal_forvantad`,
  the baseline it should still find — blank rather than `0` when there is none, since `0` would claim
  Visma holds nothing. `planAuditImport()` reads the add-on's audit CSV: only `updated`/`created`
  rows move the baseline (never `save_unconfirmed`), and a row is held back for a person when the
  audit's `before_stock` isn't the baseline we exported, or when our own quantity changed after the
  export. `planScrapeImport()` reads a scraped article list or a plain Visma export and applies a
  pull only when webware has nothing to lose; both sides having moved yields a `suggestion` of
  `V + (W - B)` and never an automatic write. Both return the same `{apply, review, ignored, counts}`
  shape, so index.html renders one review table for either. Field-level rule throughout: fill a
  blank, never overwrite a difference. Tested in `tests/visma-sync.test.js` (all four states, the
  export's exact column names and blank baseline, every audit status, drift on both sides, the merge
  suggestion, the column-name fallbacks, and that nothing is ever dropped silently).
- **`kit-relink.js`** — **wired in**, in the Visma import. `relinkKitLines(lines, items)` puts kit recipe
  lines back on items that were deleted and created again under new BTK numbers. Needed because
  `kit_items.btk` is `ON DELETE CASCADE`: wiping Best's items empties every kit in it, and a BTK is a
  label that is never reused for "the same" item afterwards. A line is matched by what the item IS — its
  item numbers, most stable first (#3 = Visma's article number, then #1, #2), each number looked up in
  any of the three slots, case-insensitively. If several new items share the number the manufacturer may
  settle it; if not (or if there is no match) the line is returned in `unmatched` with the reason
  (`none` / `ambiguous`) — never guessed. The synthetic `444…` filler numbers are never used as identity
  (`isRealItemNumber`). Lines that reach the same item in the same kit have their quantities added up.
  index.html's `snapshotKitLines()` saves the lines (with the item numbers) before the wipe — and stops
  the whole import, deleting nothing, if they can't be read — and `restoreKitLines()` writes the result
  back; the completion message says how many went back. Tested in `tests/kit-relink.test.js`.
- **`label-fit.js`** — **wired in**, as the text layout of the printed/exported QR labels (item and
  warehouse). `fitLabelText(blocks, {width, height, measure, maxScale})` lays a label's fields
  (`nums` / `name` / `mfr` / `btk`, each with a base size, a floor, a weight and letter-spacing that
  mirror the `.l-*` label CSS) into the box beside the QR code and returns, per field, the size in pt
  and the lines. Pure and dependency-injected — the caller supplies the box (px) and a
  `measure(text, {px, weight, letterSpacing})` ruler (index.html uses a canvas set to the label's own
  font), so it is tested with a fake one. Words wrap on spaces (`balancedWrap`: the narrowest width
  that needs no more lines than a greedy fill, so lines come out even rather than a long line plus a
  stub); item numbers wrap *between* the numbers via `parts` + `joiner`; the BTK line never wraps.
  Sizes step down from `maxScale` (the user's Text-size slider — a ceiling, never exceeded) in 2%
  steps and the largest that fits wins. Only when everything is at its floor is an over-wide token
  broken (`breakToken`: after `- / _ . , : ;` if that leaves a reasonably full line, else between
  characters, no hyphen inserted — these are identifiers), and only then are trailing name lines
  dropped with `…` (`truncated: true`); nothing else is ever lost. It measures with 3% slack because
  the canvas ruler and the browser/print layout can differ slightly. Tested in
  `tests/label-fit.test.js` (wrapping on spaces, balance, the ceiling, monotonic shrink, separators,
  truncation, and a 300-round randomized check that a non-truncated result always fits and keeps every
  word in order).
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
directly, no webware credentials involved. That second one is a useful fallback for "webware's own
function isn't deployed / is down," at the cost of that other project's own logs seeing the
URL/query in the clear whenever it's actually used — so it is **opt-in**, on the same switch as the
public proxies (`allowPublicFallback`, Settings → "Allow public CORS proxy fallback for web
search"), and off by default. `useKnownExternalProxy` on a `corsFetch()` call overrides just this
one either way.

## Not ported as a separate module

- **timeline's DuckDuckGo search** — already covered by `web-search.js` (that's literally where
  the search logic was ported from).
- **contactview's Google Calendar "sync"** — see above; it's a deep link / `.ics` download, not
  an API integration worth its own module.
