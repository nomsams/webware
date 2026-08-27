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
| `Inventorylocation` | No | Location within warehouse |
| `MapPosition` | No | Warehouse locator grid cell, `A1`–`F6` (column letter + row number) |
| `Comments` | No | Free text notes |
| `images` | No | Semicolon-separated filenames in `assets/` |

### CSV A — Kit Matrix
| Column | Required | Description |
|--------|----------|-------------|
| `Spare-part-kit name` | Yes | Kit display name |
| `kitnumber` | No | Optional kit number |
| `BTK000001`... | No | Quantity of each BTK in this kit (empty = not included) |

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
├── assets/             # Place item images here (referenced by CSV B `images` column)
└── README.md           # This file
```

## Supabase Mode (Warehouse 1)

Warehouse `1` runs on Supabase instead of the static encrypted-envelope flow (`mode: 'supabase'` in the `WAREHOUSES` array). This trades the "fully static, zero dependency" property for real server-enforced viewer/editor/admin permissions via Postgres Row Level Security.

- **Auth**: Email/password sign-in (Supabase Auth), not the passphrase flow. No public sign-ups — accounts are created manually in the Supabase dashboard.
- **Roles**: `viewer` (read-only), `editor` (can update existing items/images), `admin` (can also insert/delete and manage other users' roles). Role lives in `profiles.role` and is enforced by RLS, not just hidden in the UI — a viewer's write attempt is rejected server-side even via devtools. Admins change roles via Settings → Manage Users, never by hand-editing SQL.
- **Display names**: Each account can set its own display name (Settings → "Your Display Name"). Left blank, "Last updated by" on an item falls back to the part of your email before `@` — nobody has to type a name for attribution to work.
- **Data**: Items keyed by BTK number. Kits are normalized `kits`/`kit_items` tables (not the static-mode wide CSV-A matrix) but drive the same kit-browsing UI. Manufacturers are a real entity, not a free-text field — logo, description, contact, email, and a dedicated page listing that manufacturer's items in the current warehouse. Typing a manufacturer name on an item resolves against existing manufacturers first (folding known transliterations like `HÄNY`/`haeny` to the same match) before creating a new one, so spelling variants don't fork into duplicates.
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

`seed_items.sql` / `seed_kits.sql` are one-time data loads for the original Häny catalog, not schema — skip them for a fresh dataset.

**Table reference:**

- **`warehouses`** — `l` (text, PK, matches the app's warehouse ID e.g. `"1"`), `name`, `address`. Public-read to any authenticated user.
- **`profiles`** — one row per auth account. `id` (uuid, PK = `auth.users.id`), `role` (`viewer`/`editor`/`admin`), `warehouse_id` (FK → `warehouses.l`), `display_name` (text, optional, self-settable only), `created_at`. A user may read their own row and update only its `display_name` (column-scoped grant — they can never touch their own `role`).
- **`items`** — `btk` (text, PK), `warehouse_id` (FK), `manufacturer` (text, denormalized display copy kept in sync with `manufacturer_id`), `manufacturer_id` (FK → `manufacturers.id`, nullable), `itemnumber`, `itemname_en`, `itemname_sv`, `itemnumber2`, `itemnumber3`, `numberofitems` (int), `inventorylocation`, `map_position` (text, `A1`–`F6`), `comments`, `images` (legacy, unused for Supabase-mode items), `image_full_url`, `image_thumb_url`, `updated_at`/`updated_by` (set by a trigger on every write).
- **`kits`** — `id` (bigint identity, PK), `kitnumber` (text, nullable — several kits can legitimately share `null`, so the app never treats it alone as a unique key), `name`, `warehouse_id` (FK).
- **`kit_items`** — `kit_id` (FK → `kits.id`), `btk` (FK → `items.btk`), `quantity` (int); composite PK `(kit_id, btk)`.
- **`manufacturers`** — `id` (bigint identity, PK), `name` (text, unique), `description`, `contact_name`, `email`, `logo_url`, `created_at`. Global, not warehouse-scoped — the same supplier can ship to multiple warehouses.

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