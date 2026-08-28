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
| `LocationCode` | No | Bin/picking location, `Zone-Aisle-Rack-Level-Bin` (e.g. `A-03-2-4-07`) — see [Bin Location Codes](#bin-location-codes) |
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
A  -  03  -  2  -  4  -  07
Zone  Aisle  Rack  Level  Bin
```

- **Zone** (1–2 letters) — broad area or building section (e.g. `A`, `B`). Assigned per your facility's layout; no inherent order beyond alphabetical convenience.
- **Aisle** (2 digits, zero-padded) — the walking/forklift lane between racks. **Aisle `01` is the one nearest the exit/loading dock**, increasing as you move further in.
- **Rack / Bay** (1–2 digits) — the upright section within that aisle. Numbered from the same end as Aisle `01`, for consistency — Rack `1` nearest the exit end of its aisle.
- **Level / Shelf** (1–2 digits) — vertical tier. **Level `1` is the one closest to the ground**, counting upward.
- **Bin / Slot** (2 digits, zero-padded) — the exact spot on that shelf. Numbered left-to-right when standing in the aisle facing the rack, with `01` nearest the main aisle/Aisle-`01` end.

In short: **lower numbers are always closer to the ground or the exit.** That's a convention, not something the app enforces physically — pick a consistent direction for your building, mark it on the racking if it isn't obvious, and stay consistent. The app does enforce the *format* (`Zone-Aisle-Rack-Level-Bin`, e.g. `A-03-2-4-07`) via a regex on both the client and a Postgres `CHECK` constraint in Supabase mode; an item list can also be sorted by **Sort: Bin Location**, which walks items in this exact order (zone, then aisle, rack, level, bin) — items with no code sort last, since there's nowhere sensible to place them in a physical walk order.

This is a separate field from `Inventorylocation` (older, free text — e.g. a shelf nickname) and `MapPosition` (the coarse 6×6 visual locator grid) — neither was removed, since both are already relied on. If you're standardizing going forward, `LocationCode` is the one built for actually walking the warehouse.

**Same product, multiple bins or multiple warehouses:** the data model doesn't require a single item to live in one place. A duplicate `LocationCode`-bearing row (its own BTK, same `Manufacturer`/`itemnumber`, different bin and quantity) represents an overflow bin for a product already stocked elsewhere in the same warehouse — the existing BTK-collision duplicate check only fires on an actual repeated BTK, so two legitimately different bins for the same product don't trip it. The same reasoning extends across warehouses: a saved order still belongs to exactly one warehouse (pack orders are only ever sent from one at a time), so item lookup for an order never crosses warehouses — but if the same product exists elsewhere too, that's surfaced as an informational note rather than silently substituted (see `modules/order-parser.js`'s `elsewhere` field).

**Bin Location Map** (item detail, below the existing Warehouse Locator Map): an Aisle × Rack grid for the item's zone, highlighting its own cell — a zone switcher appears if more than one zone is in use. The grid is sized by `warehouse_zones.max_aisle`/`max_rack` when a row exists for that zone, otherwise auto-detected from the highest aisle/rack seen in `items.location_code` across the warehouse — so it works immediately with zero setup, and `warehouse_zones` only needs a row when you want to show room that isn't stocked yet (or to label a zone). Level and Bin aren't separate grid axes — a 2D grid can't show all four components at once, and they're already in the parsed "Zone A · Aisle 3 · Rack 2 · Level 4 · Bin 7" text next to the raw code in the field list above.

**Planned next**: a photo per rack (taken along its aisle, not always available for every rack) with a grid overlaid on it, mapping image regions to Level/Bin — `warehouse_rack_images` and the `rack-images` Storage bucket already exist for this (see the table reference above), but nothing reads or writes them yet; the overlay mechanism itself hasn't been designed.

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
- **Roles**: `viewer` (read-only), `editor` (can update existing items/images), `admin` (can also insert/delete and manage other users' roles). Role lives in `profiles.role` and is enforced by RLS, not just hidden in the UI — a viewer's write attempt is rejected server-side even via devtools. Admins change roles via Settings → Manage Users, never by hand-editing SQL.
- **Display names**: Each account can set its own display name (Settings → "Your Display Name"). Left blank, "Last updated by" on an item falls back to the part of your email before `@` — nobody has to type a name for attribution to work.
- **Data**: Items keyed by BTK number. Kits are normalized `kits`/`kit_items` tables (not the static-mode wide CSV-A matrix) but drive the same kit-browsing UI. Manufacturers are a real entity, not a free-text field — logo, description, contact, email, and a dedicated page listing that manufacturer's items in the current warehouse. Typing a manufacturer name on an item resolves against existing manufacturers first (folding known transliterations like `HÄNY`/`haeny` to the same match) before creating a new one, so spelling variants don't fork into duplicates.
- **Warehouse details**: name/address/phone/contact email are DB-driven (the `warehouses` table), editable by admins via "✏️ Edit Warehouse" in the header bar — not something you need to redeploy the app to change.
- **Images**: One photo per item + one logo per manufacturer, in Supabase Storage (`item-images` / `manufacturer-logos` buckets, public-read, editor/admin write) — not the local `assets/` convention static warehouses use. Uploaded via an in-browser editor (rotate, 1:1-default crop, solid-colour pen) before being compressed; the thumbnail is what's shown in lists/galleries, full-res on click. Re-uploading replaces the existing image in place (upsert) rather than accumulating old versions. Combined usage against 90% of the Supabase free-tier 1GB quota is shown in Settings and checked before every upload.
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
| 10 | `schema_warehouse_layout.sql` | `warehouses.phone`/`contact_email` + update policy, `warehouse_zones`, `warehouse_rack_images` (unused — future), `rack-images` bucket |

`seed_items.sql` / `seed_kits.sql` are one-time data loads for the original Häny catalog, not schema — skip them for a fresh dataset.

**Table reference:**

- **`warehouses`** — `l` (text, PK, matches the app's warehouse ID e.g. `"1"`), `name`, `address`, `phone`, `contact_email`. Public-read to any authenticated user; update restricted to admins (Settings → the header bar's "✏️ Edit Warehouse", admin + Supabase mode only). For warehouse 1, this table — not the hardcoded `WAREHOUSES` array in `index.html` — is the source of truth for these four fields once a session has loaded it; static warehouses 2/3 still use the hardcoded array (there's no `warehouses` table row for them, and nothing tries to read one).
- **`warehouse_zones`** — optional, usually empty. `id` (bigint identity, PK), `warehouse_id` (FK), `zone` (text, e.g. `"A"` — matches a `location_code`'s Zone component), `label` (optional human-friendly name), `max_aisle`/`max_rack`/`max_level`/`max_bin` (smallint, all nullable). Explicitly bounds a zone for the Bin Location Map grid (see [Bin Location Codes](#bin-location-codes)) when you want it bigger than what's currently stocked, or want a zone labeled; with no row for a zone, the app auto-detects the same bounds from the highest aisle/rack it finds in `items.location_code`. Admin-write, readable to the zone's own warehouse (or admin).
- **`warehouse_rack_images`** — **not read or written by the app yet.** `id` (bigint identity, PK), `warehouse_id` (FK), `zone`, `aisle`, `rack` (smallint, composite-unique with `warehouse_id`+`zone`), `image_url`, `grid_overlay` (jsonb, undefined shape — reserved for whatever calibration data a future image-to-grid overlay feature needs), `created_at`. Exists now so the schema doesn't need to change later: the plan is a photo per rack (taken along its aisle, not always available) with a grid overlaid on it mapping image regions to Level/Bin. Backed by the `rack-images` Storage bucket (public-read, editor/admin write — same shape as `item-images`).
- **`profiles`** — one row per auth account. `id` (uuid, PK = `auth.users.id`), `role` (`viewer`/`editor`/`admin`), `warehouse_id` (FK → `warehouses.l`), `display_name` (text, optional, self-settable only), `created_at`. A user may read their own row and update only its `display_name` (column-scoped grant — they can never touch their own `role`).
- **`items`** — `btk` (text, PK), `warehouse_id` (FK), `manufacturer` (text, denormalized display copy kept in sync with `manufacturer_id`), `manufacturer_id` (FK → `manufacturers.id`, nullable), `itemnumber`, `itemname_en`, `itemname_sv`, `itemnumber2`, `itemnumber3`, `numberofitems` (int), `inventorylocation`, `map_position` (text, `A1`–`F6`), `location_code` (text, `Zone-Aisle-Rack-Level-Bin`, CHECK-constrained format — see [Bin Location Codes](#bin-location-codes)), `comments`, `images` (legacy, unused for Supabase-mode items), `image_full_url`, `image_thumb_url`, `updated_at`/`updated_by` (set by a trigger on every write).
- **`kits`** — `id` (bigint identity, PK), `kitnumber` (text, nullable — several kits can legitimately share `null`, so the app never treats it alone as a unique key), `name`, `warehouse_id` (FK).
- **`kit_items`** — `kit_id` (FK → `kits.id`), `btk` (FK → `items.btk`), `quantity` (int); composite PK `(kit_id, btk)`.
- **`manufacturers`** — `id` (bigint identity, PK), `name` (text, unique), `description`, `contact_name`, `email`, `logo_url`, `created_at`. Global, not warehouse-scoped — the same supplier can ship to multiple warehouses.
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