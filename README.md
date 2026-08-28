# Webware Inventory

A self-contained, single-file inventory management web app with encrypted storage, QR code labels, and kit management.

## Quick Start

1. **Open the app** — Serve `index.html` over HTTPS or `localhost` (required for WebCrypto).
2. **Unlock the demo** — Enter passphrase `varuhuset` for Warehouse 1, or scan a setup link like `#1/KEY/varuhuset`.
3. **Start scanning** — Scan item QR codes (format: `#<ID>/<WAREHOUSE>`) to open items directly.

## Data Import Workflow

### 1. Import Warehouses (CSV C)
- Prepare a CSV with columns: `l` (warehouse ID), `name`, `address`
- Click **📥 Warehouses CSV** in the header
- Select your warehouse CSV file

### 2. Import Items (CSV B)
- Prepare a CSV with columns: `Manufacturer`, `BTKnumber`, `itemnumber`, `itemname(english)`, `itemname(swedish)`, `itemnumber2`, `itemnumber3`, `Numberofitems`, `Inventorylocation`, `Comments`, `images`
- Click **📥 Items CSV** in the header
- Select your items CSV file

### 3. Import Kits (CSV A)
- Prepare a kit matrix CSV: first column `Spare-part-kit name`, second `kitnumber`, remaining columns are BTK numbers with quantities
- Click **📥 Kits CSV** in the header
- Select your kits CSV file

### 4. Export Encrypted Database
- Click **💾 Export** to download an encrypted `warehouse-<ID>-db.json`
- This file contains all items and kits, encrypted with your passphrase
- Share this file + passphrase with other devices to sync data

## CSV Formats

### CSV C — Warehouses
| Column | Required | Description |
|--------|----------|-------------|
| `l` / `id` / `warehouse_id` | Yes | Warehouse ID (e.g., `1`, `2`, `3`) |
| `name` / `warehouse_name` | Yes | Display name |
| `address` / `location` | No | Physical address |

### CSV B — Items
| Column | Required | Description |
|--------|----------|-------------|
| `Manufacturer` | No | Manufacturer name |
| `BTKnumber` | Yes | System ID (e.g., `BTK000024`) |
| `itemnumber` | No | Primary item number |
| `itemname(english)` | Yes | English name |
| `itemname(swedish)` | No | Swedish name |
| `itemnumber2` | No | Secondary item number |
| `itemnumber3` | No | Internal/third item number |
| `Numberofitems` | No | Stock quantity |
| `Inventorylocation` | No | Location within warehouse (free text) |
| `MapPosition` | No | Warehouse locator grid cell, `A1`–`F6` (column letter + row number) |
| `LocationCode` | No | Bin/picking location, `ZoneDepth-Level-Bin` plus optional `-Row` (e.g. `A1-4-07` or `A1-4-07-2`) — see [Bin Location Codes](#bin-location-codes) |
| `Comments` | No | Free text notes |
| `images` | No | Semicolon-separated filenames in `assets/` |

### CSV A — Kit Matrix
| Column | Required | Description |
|--------|----------|-------------|
| `Spare-part-kit name` | Yes | Kit display name |
| `kitnumber` | No | Optional kit number |
| `BTK000001`... | No | Quantity of each BTK in this kit (empty = not included) |

## Bin Location Codes

A `LocationCode` (also settable via quick-edit or the Add/Edit modal — "Bin Location Code") pins an item to one physical slot for stocktaking ("inventering") and pick walks, more granular than `MapPosition`'s coarse locator grid:

```
A     1      -  4  -  07  - 2
Zone  Depth     Level  Bin  Row
```

- **Zone** (1–2 letters) — a rack area: one run of racking (e.g. `A`, `B`). In the [Layout Designer](#warehouse-page--layout-designer) this is what you actually draw. Assigned per your facility's layout; no inherent order beyond alphabetical convenience.
- **Depth** (1–2 digits, directly after the zone letters, no separator) — which physical rack you mean when a rack area is more than one row deep. `1` is the front rack; `2` (if the area is drawn 2 deep) is the back one, standing back-to-back with it and sharing a wall — a common space-saving layout. A single-row rack area only ever has Depth `1`.
- **Level / Shelf** (1–2 digits) — vertical tier. **Level `1` is the one closest to the ground**, counting upward.
- **Bin / Slot** (2 digits, zero-padded) — the exact spot on that shelf, left-to-right facing the rack, `01` at whichever end you've picked to start counting from.
- **Row** (1–2 digits, optional) — a bin's own front-to-back position, for a shelf spot that's several bins deep instead of just one sitting right at the front edge. `1` is the front-most (or only) bin and is **left off the code entirely** — so a normal, one-bin-deep shelf never needs it; `2` means it's one bin further back, hidden behind bin `07` until that one's moved out of the way, `3` another bin behind that, and so on. This is about an individual bin's own depth on the shelf, not to be confused with rack **Depth** above (which is about racks, not bins).

There's deliberately no "Aisle" component — a rack area's *width* (how many bays long it runs) is a property of the area itself, drawn once in the Layout Designer, not of any individual item in it, so it isn't part of the code. In short: **lower numbers are always closer to the ground, and Depth 1 is always the front rack.** The app enforces the *format* (`Zone` + `Depth` + `-Level-Bin` + optional `-Row`, e.g. `A1-4-07` or `A1-4-07-2`) via a regex on both the client and a Postgres `CHECK` constraint in Supabase mode; an item list can also be sorted by **Sort: Bin Location**, which walks items in this exact order (zone, then depth, level, bin, row) — items with no code sort last, since there's nowhere sensible to place them in a physical walk order.

This is a separate field from `Inventorylocation` (older, free text — e.g. a shelf nickname) and `MapPosition` (the coarse 6×6 visual locator grid) — neither was removed, since both are already relied on. If you're standardizing going forward, `LocationCode` is the one built for actually walking the warehouse.

**Same product, multiple bins or multiple warehouses:** the data model doesn't require a single item to live in one place. A duplicate `LocationCode`-bearing row (its own BTK, same `Manufacturer`/`itemnumber`, different bin and quantity) represents an overflow bin for a product already stocked elsewhere in the same warehouse — the existing BTK-collision duplicate check only fires on an actual repeated BTK, so two legitimately different bins for the same product don't trip it. The same reasoning extends across warehouses: a saved order still belongs to exactly one warehouse (pack orders are only ever sent from one at a time), so item lookup for an order never crosses warehouses — but if the same product exists elsewhere too, that's surfaced as an informational note rather than silently substituted (see `modules/order-parser.js`'s `elsewhere` field).

**Bin Location Map** (item detail, below the existing Warehouse Locator Map): a Depth × Level grid for the item's zone, highlighting its own cell — a zone switcher appears if more than one zone is in use. The grid is sized by `warehouse_zones.max_rack` (max depth) / `max_level` when a row exists for that zone, otherwise auto-detected from the highest depth/level seen in `items.location_code` across the warehouse — so it works immediately with zero setup, and `warehouse_zones` only needs a row when you want to show room that isn't stocked yet (or to label a zone). Bin isn't a grid axis — a 2D grid only has two, and Depth/Level are the pair that actually place you at a rack and shelf; Bin is already in the parsed "Zone A · Rack 2 (back) · Level 4 · Bin 7" text next to the raw code in the field list above.

**Changed format, if you set any codes before this**: `LocationCode` used to be 5 parts (`Zone-Aisle-Rack-Level-Bin`, e.g. `A-03-2-4-07`); it's now 4, plus an optional 5th (`ZoneDepth-Level-Bin(-Row)`, e.g. `A2-4-07` or `A2-4-07-2`) — Aisle is gone, the old "Rack" number is now "Depth" directly appended to the zone letters, and Row was added later for multi-deep shelves (optional, so every pre-existing code is still valid unchanged). `supabase/schema_location_code_v2.sql` migrates any already-saved 5-part values automatically (old Aisle is simply dropped, Rack becomes Depth, Level and Bin carry over unchanged); `supabase/schema_bin_row.sql` (run after it) only loosens the `CHECK` constraint to also accept the optional `-Row` suffix — nothing to backfill for that one.

**Setting a code** (quick-edit or the Add/Edit modal): pick Zone/Depth/Level from dropdowns — built from the warehouse's actual rack areas, via the same `getAvailableZones()`/`getZoneBounds()` the Bin Location Map uses — or tap a cell directly on the clickable Depth × Level grid shown right below them, and type just the Bin number (and Row, only if that shelf spot is more than one bin deep) — or ignore all of that and type the whole code by hand in the text field underneath. All of these stay loosely in sync: a complete picker selection or grid tap writes the composed code into the text field, and typing a recognizable code into the text field updates the dropdowns/grid to match (a half-typed code is left alone rather than fighting you). The ℹ️ button next to the field label explains the format with worked examples. If the warehouse has no rack areas defined yet, the dropdowns and grid are empty and a hint points you at the Warehouse page's Layout Designer — typing by hand still works regardless.

**Update**: a rack photo can now be perspective-corrected (straightened) and optionally scale-calibrated — see **📐 Straighten** under [Warehouse Page & Layout Designer](#warehouse-page--layout-designer). **Still planned next**: actually mapping specific Level/Bin cells onto the straightened photo (e.g. clicking a cell in the Bin Location Map jumps to/highlights the matching region of the rack photo) — the straightening and measurement groundwork is there, but that mapping itself isn't built yet.

## Warehouse Page & Layout Designer

Click the warehouse name in the header bar (Supabase mode) to open its full page: contact details (with "✏️ Edit Details"), the **Layout Designer**, and aisle/rack photos.

The Layout Designer edits `warehouse_zones` — admin-only to draw or save, visible read-only to everyone else — in two interchangeable modes over the same underlying data, so switching modes never loses an edit. What you're drawing is a **rack area**: a physical run of racking, not a whole building section. Width (`max_aisle`) is how many bays long it runs — purely a drawing property, shown so the shape looks right on the grid, never part of an item's own code. Height (`max_rack`) is how many racks stand deep at that spot, and *does* map directly onto items: 1 is a single row (every item in it is Depth `1`); 2 is two rows back-to-back sharing a wall — a common space-saving layout — with items split between Depth `1` (front) and Depth `2` (back). See [Bin Location Codes](#bin-location-codes) for how Depth shows up in an item's own `LocationCode`.

- **🖊️ Draw** (default): drag empty space to draw a new rack area. It's labeled automatically in sequence — `A`, then `B`, `C`, and so on — sized to however many cells you dragged across. **Drag its body** to move it; **drag an edge** to resize it from that side (the opposite edge stays put — dragging the left edge grows/shrinks the area while the right edge doesn't move, and likewise top/bottom); **double-click** it to open an inspector for its label and Level/Bin counts (not drawable — they're shelf depth, not floor space) or to delete it. A plain click with no movement does none of these, on purpose — it's what lets drag-to-move, drag-an-edge-to-resize, and double-click-to-edit all coexist without one accidentally triggering another. Once selected (via double-click, or after drawing/moving it), **arrow keys** nudge it one cell at a time, and **Delete**/**Backspace** removes it (with the same confirmation as the 🗑️ button) — both skip if focus happens to be in a text field, so they don't interfere with normal typing there.
- **⌨️ Manual**: the same rack areas as a plain editable table — type a letter, label, and bay/depth/level/bin counts directly, or "+ Add Zone" for a new row (also auto-lettered, but freely editable). Useful when you already know the numbers and don't want to drag rectangles, or need one placed nowhere in particular yet.

**↶ Undo / ↷ Redo** (buttons above the grid, or **Ctrl+Z** / **Ctrl+Shift+Z**) cover every layout edit — drawing, moving, deleting, and field edits in either mode — for the current page visit; opening the Warehouse page again starts a fresh history from whatever's currently saved. Typing (a label, a count) collapses into one undo step per pause rather than one per keystroke. The shortcut only acts while the Layout Designer is open and focus isn't in a text field, so the browser's own undo still works normally while you're mid-edit in one.

**💾 Save Layout** validates zone letters are non-empty and unique, then replaces the warehouse's `warehouse_zones` rows wholesale (delete + re-insert) — simplest correct option for a small, infrequently-changed, admin-only table. Saved zones immediately size and position the Bin Location Map on any item in that zone (see [Bin Location Codes](#bin-location-codes)).

**Aisle/Rack Photos**: pick a zone (from either a drawn/manual zone or one only seen in an item's `location_code`), enter an aisle and rack number, and upload — editor or admin, same role as item photo uploads. Each (zone, aisle, rack) holds one photo; re-uploading replaces it.

**📐 Straighten** (the button on each photo, editor/admin): perspective-correct a photo taken at an angle — drag 4 handles onto the corners of the rack face, hit **✅ Straighten**, and it's rectified into a flat rectangle via `modules/perspective-warp.js` (a homography solved from those 4 points, the same linear-algebra approach document-scanner apps use — see that module's header for the math). **✏️ Adjust Corners** goes back to move them again before **💾 Save**, which uploads the rectified image alongside the original (the original is kept — re-editing corners needs the unwarped source) and stores the corner points in `warehouse_rack_images.grid_overlay`. Optionally, **📏 Set Measurement**: click two points on the straightened photo and enter the real-world distance they span (e.g. a shelf's height), to convert other pixel distances in that photo into real units later — also saved in `grid_overlay`. All of this runs client-side in Canvas 2D; nothing is uploaded anywhere to be processed.

## QR Code System

- **Item QR**: `#<COMPRESSED_ID>/<WAREHOUSE>` — e.g., `#24/1` (opens item directly)
- **Warehouse Setup QR**: `#<WAREHOUSE>/KEY/<PASSPHRASE>` — e.g., `#1/KEY/varuhuset` (unlocks + saves key)
- **Warehouse Key QR**: Generated via **🏬 Warehouse QRs** button — contains the key for that warehouse

## Label Printing

1. Select items using the circular checkboxes
2. Click **🏷️ Create Label** (single) or use FAB for multiple
3. In preview, click **🖨️ Print** to print directly, or **💾 HTML Export** to save
4. Labels are formatted for Brother QL 29mm × 90mm — set printer margins to **None**

## Features

- **End-to-end encryption** — AES-256-GCM envelope encryption with PBKDF2-wrapped keys
- **Multi-warehouse** — Separate encrypted vaults per warehouse, single passphrase unlocks all
- **Kit system** — Define kits with quantities, navigate items sequentially within a kit
- **Pack Order** — A session-local pick list ("grocery cart"): select items from the item list, a kit's items, or a manufacturer's items, tap the green 📦 Pack button, then check items off as "Packed" while fulfilling an order. Selecting an item in a kit shows an inline +/− stepper to set how many of it to pack (defaults to the kit's own quantity); the pack order itself shows that quantity as a large number before each item, and you can click the number directly to change it — reducing it asks whether the difference should be recorded as a backorder (shown as a badge, included when printed) or just treated as the new total. Tap an item to open its detail page (location included) — "← Back" returns to the order. "✏️ Edit Order" makes quantities editable in bulk; below the item list you can set the package's dimensions (custom mm or a preset box size) and weight; "🖨️ Print" opens an A4-formatted list — including package info and any backorders — for printing or saving as PDF via the browser's print dialog. By default it's a working list for the current session only — refreshing clears it — *unless* you fill in a recipient name/address and hit "💾 Save Order" (Supabase mode, editor/admin), which persists it to the `orders` table under a unique `ORDxxxxxx` number (same shape as BTK numbers). Reachable anytime via the 📦 icon in the header once it has items.
- **Stocktaking** (Inventering internally, 📋 icon in the header) — a dedicated counting-session mode, separate from Pack Order. Setup: pick a Rack Area (or "All areas") or a Kit to seed a checklist, then fine-tune with checkboxes ("Select All"/"Select None" or uncheck individual items) before hitting "▶️ Start Stocktaking". The session itself is a plain done/not-done list, sorted by bin location (same order as **Sort: Bin Location** — walk the floor once, front-to-back) — each row shows the same info density as the main item list: the system's recorded stock number, item name, item number(s), manufacturer, BTK number, bin location, and a "✅ Done"/"⬜ Not Done" toggle you can flip either way. The stock number is clickable (editor/admin/maintainer only) to correct it right from the list, without opening the item; tapping the rest of a row opens that item's full detail page; "← Back" returns to the session. It's session-local like Pack Order — not saved anywhere, and re-clicking the 📋 icon resumes an in-progress session instead of restarting the setup wizard; "🗑️ Clear Session" ends it and goes back to setup. Marking an item **Done** (not un-marking it) does write one thing: `items.last_inventoried_at`/`_by`/`_location` (a snapshot of `location_code` at the time, not a live reference), shown on the item's own page as "📋 Last inventoried: …" and as a small date under its row in the next session. Only the *last* count is kept, not a full history log.
- **Draft autosave** — Edits saved locally until encrypted export
- **Dark mode** — Persisted theme preference
- **Offline-first** — Runs entirely in browser, no backend required

## Browser Requirements

- HTTPS or `localhost` (WebCrypto requirement)
- Modern browser with `crypto.subtle` support
- Pop-ups allowed for label printing

## Project Structure

```
webware/
├── index.html          # Complete application (HTML + CSS + JS)
├── assets/              # Place item images here (referenced by CSV B `images` column)
├── supabase/            # SQL migrations (run once each, see Database Schema below) + edge functions
├── modules/             # Standalone JS for future functionality — not wired into index.html yet, see modules/README.md
└── README.md            # This file
```

## Supabase Mode (Warehouse 1)

Warehouse `1` runs on Supabase instead of the static encrypted-envelope flow (`mode: 'supabase'` in the `WAREHOUSES` array). This trades the "fully static, zero dependency" property for real server-enforced viewer/editor/admin permissions via Postgres Row Level Security.

- **Auth**: Email/password sign-in (Supabase Auth), not the passphrase flow. No public sign-ups — accounts are created manually in the Supabase dashboard.
- **Roles**: `viewer` (read-only), `editor` (can update existing items/images), `maintainer`, `admin` (can also insert/delete, manage other users' roles and permissions, and see storage/database usage stats — the only role that can). Enforced by RLS, not just hidden in the UI — a viewer's write attempt is rejected server-side even via devtools.

  A user's **global role** (`profiles.role`, set via Settings → Manage Users) applies in their **home warehouse** (`profiles.warehouse_id`, set at account creation) exactly as it always has. **`maintainer`** is different: rather than one fixed capability set everywhere, its permissions are granted **per warehouse** via the `warehouse_permissions` table — e.g. someone can be an `editor` normally but also hold a `maintainer` grant in a second warehouse, without their global role or home warehouse changing. (The same per-warehouse grant mechanism works for any role, not just maintainer — you could just as easily grant someone `viewer`-in-one-specific-warehouse.) By default a `maintainer` grant behaves like `editor` in that warehouse — adjust stock, add new items, edit item details — everywhere the app already gates on "not a viewer" now also passes for a maintainer grant; it isn't currently restricted to *only* stock adjustments (that would need column-level grants, a further step if you want it enforced server-side rather than by what the UI exposes). Admins manage both the global role and any per-warehouse grants from Settings → Manage Users; grants only currently affect `items` access, not orders/kits/manufacturers/warehouse_zones/rack photos.
- **Display names**: Each account can set its own display name (Settings → "Your Display Name"). Left blank, "Last updated by" on an item falls back to the part of your email before `@` — nobody has to type a name for attribution to work.
- **Data**: Items keyed by BTK number. Kits are normalized `kits`/`kit_items` tables (not the static-mode wide CSV-A matrix) but drive the same kit-browsing UI. Manufacturers are a real entity, not a free-text field — logo, description, contact, email, and a dedicated page listing that manufacturer's items in the current warehouse. Typing a manufacturer name on an item resolves against existing manufacturers first (folding known transliterations like `HÄNY`/`haeny` to the same match) before creating a new one, so spelling variants don't fork into duplicates.
- **Warehouse details**: name/address/phone/contact email are DB-driven (the `warehouses` table), editable by admins via "✏️ Edit Warehouse" — not something you need to redeploy the app to change. Click the warehouse name in the header bar for the full [Warehouse Page](#warehouse-page--layout-designer): contact details, the zone Layout Designer, and aisle/rack photos.
- **Images**: One photo per item + one logo per manufacturer, in Supabase Storage (`item-images` / `manufacturer-logos` buckets, public-read, editor/admin write) — not the local `assets/` convention static warehouses use. Uploaded via an in-browser editor (rotate, 1:1-default crop, solid-colour pen) before being compressed; the thumbnail is what's shown in lists/galleries, full-res on click. Re-uploading replaces the existing image in place (upsert) rather than accumulating old versions. Combined usage against 90% of the Supabase free-tier 1GB quota is shown in Settings and checked before every upload. The photo is shown *last* on an item's page, after everything else — a broken/inaccessible image now shows a visible red-bordered placeholder and logs the failed URL to the console, rather than silently disappearing (a `<img>` load failure used to just hide the element outright, which looked indistinguishable from "no photo").
- **Present in other warehouses** (admin only, item detail): if the same product (matched by manufacturer + itemnumber) also has a row in another Supabase warehouse, Stock gains a "Total (calculated, N warehouses): …" figure and a per-warehouse breakdown appears under Inventory Location (`WarehouseName: Qst`). Only ever shows for a product actually found in more than one warehouse — with just one Supabase warehouse in use today it stays invisible for everyone, but needs no further changes to start working once/if more warehouses join Supabase. Static warehouses 2/3 can never appear here — they're client-side encrypted vaults, not queryable from a Supabase session at all.
- **Low-stock indicator**: Off by default — opt in via Settings, with a configurable threshold. Flags items in the list and item view.
- **CSV export**: A plain (unencrypted) snapshot of the current warehouse's items, for reporting — the database is the source of truth in Supabase mode, so this isn't a backup mechanism.
- **Keep-alive**: `.github/workflows/supabase-keepalive.yml` pings the database twice a week so the free-tier project doesn't pause after 7 days of inactivity.
- **Other warehouses** (`2`, `3`, ...) are unaffected and keep using the offline-capable passphrase/envelope-encryption flow described above, including the static wide-CSV-A kit matrix and free-text manufacturer field.

### Database Schema

Everything lives in the `public` schema with RLS enabled. Set up a fresh project by running the files in `supabase/` through the SQL Editor **in this order** (each is idempotent-ish — safe to re-run except where a file's own header comment says otherwise):

| # | File | Adds |
|---|------|------|
| 1 | *(initial setup — see project history)* | `warehouses`, `profiles`, `items` (base columns), auth/RLS policies |
| 2 | `schema_kits.sql` | `kits`, `kit_items` |
| 3 | `schema_image_storage.sql` | `items.image_full_url`, `items.image_thumb_url`, `item-images` bucket |
| 4 | `schema_map_position.sql` | `items.map_position` |
| 5 | `schema_manufacturers.sql` | `manufacturers`, `items.manufacturer_id`, `manufacturer-logos` bucket, backfill from existing `items.manufacturer` text |
| 6 | `schema_user_management.sql` | `list_profiles_with_email()`, `update_user_role()` |
| 7 | `schema_display_names.sql` | `profiles.display_name`, `get_display_name()`, self-update policy |
| 8 | `schema_orders.sql` | `orders`, `orders_number_seq` |
| 9 | `schema_bin_location.sql` | `items.location_code` |
| 10 | `schema_warehouse_layout.sql` | `warehouses.phone`/`contact_email` + update policy, `warehouse_zones`, `warehouse_rack_images`, `rack-images` bucket |
| 11 | `schema_warehouse_zone_position.sql` | `warehouse_zones.grid_col`, `warehouse_zones.grid_row` |
| 12 | `schema_location_code_v2.sql` | migrates `items.location_code` values to the new `ZoneDepth-Level-Bin` shape, tightens the `CHECK` constraint |
| 13 | `schema_inventering_history.sql` | `items.last_inventoried_at`, `items.last_inventoried_by`, `items.last_inventoried_location` |
| 14 | `schema_admin_cross_warehouse_items.sql` | additional admin-read-all `items` SELECT policy |
| 15 | `schema_maintainer_role.sql` | allows `profiles.role = 'maintainer'`, `warehouse_permissions`, `set_warehouse_permission()`, `revoke_warehouse_permission()`, `list_warehouse_permissions()`, additional per-warehouse-grant `items` policies |
| 16 | `schema_bin_row.sql` | loosens the `items.location_code` `CHECK` constraint to also accept an optional `-Row` suffix (multi-deep shelves) |

`seed_items.sql` / `seed_kits.sql` are one-time data loads for the original Häny catalog, not schema — skip them for a fresh dataset.

**Table reference:**

- **`warehouses`** — `l` (text, PK, matches the app's warehouse ID e.g. `"1"`), `name`, `address`, `phone`, `contact_email`. Public-read to any authenticated user; update restricted to admins (Settings → the header bar's "✏️ Edit Warehouse", admin + Supabase mode only). For warehouse 1, this table — not the hardcoded `WAREHOUSES` array in `index.html` — is the source of truth for these four fields once a session has loaded it; static warehouses 2/3 still use the hardcoded array (there's no `warehouses` table row for them, and nothing tries to read one).
- **`warehouse_zones`** — optional, usually empty until you use the Layout Designer (see [Warehouse Page & Layout Designer](#warehouse-page--layout-designer)). `id` (bigint identity, PK), `warehouse_id` (FK), `zone` (text, e.g. `"A"` — matches a `location_code`'s Zone component), `label` (optional human-friendly name), `max_aisle`/`max_rack`/`max_level`/`max_bin` (smallint — `max_aisle` is the drawn block's width in grid cells, a drawing-only property; `max_rack`/`max_level` double as max Depth/Level for the item-detail Bin Location Map), `grid_col`/`grid_row` (smallint, the block's position on the designer's drawing grid). Explicitly bounds a zone for both the Layout Designer and the Bin Location Map grid (see [Bin Location Codes](#bin-location-codes)) when you want it bigger than what's currently stocked, or want a zone labeled/positioned; with no row for a zone, the Bin Location Map auto-detects Depth/Level bounds from `items.location_code` (it just can't be drawn on the designer's grid without a row, since auto-detection has no position to place it at). Admin-write, readable to the zone's own warehouse (or admin).
- **`warehouse_rack_images`** — one row per photographed rack. `id` (bigint identity, PK), `warehouse_id` (FK), `zone`, `aisle`, `rack` (smallint, composite-unique with `warehouse_id`+`zone`), `image_url` (the original, as-uploaded photo), `grid_overlay` (jsonb — set by the **📐 Straighten** perspective-correction tool: `{ corners, rectifiedWidth, rectifiedHeight, rectifiedImageUrl, calibration }`, see [Warehouse Page & Layout Designer](#warehouse-page--layout-designer) — `null` until a photo has been straightened), `created_at`. Uploaded from the Warehouse page (editor/admin); each (zone, aisle, rack) has at most one photo — re-uploading replaces it (upsert). Backed by the `rack-images` Storage bucket (public-read, editor/admin write — same shape as `item-images`).
- **`profiles`** — one row per auth account. `id` (uuid, PK = `auth.users.id`), `role` (`viewer`/`editor`/`admin`), `warehouse_id` (FK → `warehouses.l`), `display_name` (text, optional, self-settable only), `created_at`. A user may read their own row and update only its `display_name` (column-scoped grant — they can never touch their own `role`).
- **`items`** — `btk` (text, PK), `warehouse_id` (FK), `manufacturer` (text, denormalized display copy kept in sync with `manufacturer_id`), `manufacturer_id` (FK → `manufacturers.id`, nullable), `itemnumber`, `itemname_en`, `itemname_sv`, `itemnumber2`, `itemnumber3`, `numberofitems` (int), `inventorylocation`, `map_position` (text, `A1`–`F6`), `location_code` (text, `ZoneDepth-Level-Bin` plus optional `-Row` e.g. `A1-4-07` or `A1-4-07-2`, CHECK-constrained format — see [Bin Location Codes](#bin-location-codes)), `comments`, `images` (legacy, unused for Supabase-mode items), `image_full_url`, `image_thumb_url`, `updated_at`/`updated_by` (set by a trigger on every write), `last_inventoried_at`/`_by`/`_location` (set client-side when a stocktake marks the item Done — a snapshot of `location_code` at that moment, not a live reference — see [Stocktaking](#features) — `_location`/`_at`/`_by` all stay `null` until the item's first count).
- **`kits`** — `id` (bigint identity, PK), `kitnumber` (text, nullable — several kits can legitimately share `null`, so the app never treats it alone as a unique key), `name`, `warehouse_id` (FK).
- **`kit_items`** — `kit_id` (FK → `kits.id`), `btk` (FK → `items.btk`), `quantity` (int); composite PK `(kit_id, btk)`.
- **`manufacturers`** — `id` (bigint identity, PK), `name` (text, unique), `description`, `contact_name`, `email`, `logo_url`, `created_at`. Global, not warehouse-scoped — the same supplier can ship to multiple warehouses.
- **`warehouse_permissions`** — an additional, optional role grant for one user in one specific warehouse, on top of their global `profiles.role`. `id` (bigint identity, PK), `user_id` (FK → `auth.users.id`), `warehouse_id` (FK), `role` (`viewer`/`editor`/`maintainer`/`admin`), `created_at`; unique on `(user_id, warehouse_id)` — one grant per person per warehouse, upserted by `set_warehouse_permission()` rather than accumulating duplicates. Admin-write only (via `set_warehouse_permission()`/`revoke_warehouse_permission()`, both admin-gated `security definer` RPCs); readable by the grant's own user or an admin. `list_warehouse_permissions()` is what the client actually calls to read grants — it returns every grant to an admin, but only the caller's own to anyone else, so a non-admin user can compute their own effective role without leaking every other user's grants.
- **`orders`** — a saved Pack Order. `id` (bigint identity, PK), `order_number` (text, unique, auto-generated as `ORDxxxxxx` by a sequence-backed column default — same shape as BTK numbers), `warehouse_id` (FK), `recipient_name`, `recipient_address`, `box_length`/`box_width`/`box_height` (numeric, mm), `box_weight` (numeric, kg), `items` (jsonb snapshot of the pack order's lines: `[{btk, qty, packed, backorder}]` — not a separate join table, since there's no reporting/query need across orders today), `created_at`, `created_by` (FK → `auth.users.id`).

### Connecting Your Own Supabase Project (or a Similar Backend)

This app is a single static HTML file with no build step, so it can't read environment variables at runtime. The connection details live in two *different* places, in two different formats — mixing them up either breaks the app or leaks a key that should never be public:

**1. The client itself, in `index.html`** — near the top of the `<script>` block:
```js
const SUPABASE_URL = 'https://<your-project-ref>.supabase.co';
const SUPABASE_ANON_KEY = '<your-anon-key>';
```
Find both under **Project Settings → Data API** in your Supabase dashboard. The anon key is *meant* to be public — that's the whole point of Row Level Security — and looks like either a long JWT starting `eyJ...` (older projects) or the newer `sb_publishable_...` format. Either works identically; paste whichever your project shows.

**2. The GitHub Actions keep-alive workflow — repo secrets**, not client-side constants, since that job runs server-side in CI and needs privileged access RLS would otherwise block:
- **Settings → Secrets and variables → Actions → New repository secret** on the GitHub repo.
- `SUPABASE_URL` — same value as above.
- `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** key (same Data API page, *not* the anon key). Also a JWT starting `eyJ...` (older) or the newer `sb_secret_...` format. This key bypasses Row Level Security entirely — it must **only** ever live in this GitHub secret, never in `index.html`, never committed, never logged.

Pointing this at a different Postgres-compatible backend follows the same shape: a public-safe, RLS-scoped key goes in the client; a privileged key that can bypass access control goes only in CI secrets. You'd also need to adapt the `supabase/*.sql` files for whatever SQL dialect differences your provider has.

## Security Notes

- Passphrases never leave the browser
- Encrypted vaults stored in `localStorage` (`webware_vault`, `webware_keys`)
- Draft data stored separately (`webware_draft`)
- Clear Session button wipes all local data