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
- **Roles**: `viewer` (read-only), `editor` (can update existing items + images), `admin` (can also insert/delete). Role lives in the `profiles` table and is enforced by RLS, not just hidden in the UI — a viewer's write attempt is rejected server-side even via devtools.
- **Data**: Items live in the `items` table (schema in the Supabase SQL editor history), keyed by BTK number. No kits table — kit/BOM functionality was intentionally dropped for Supabase-mode warehouses.
- **Images**: Uploaded via the app (single image in item view, or batch via filename-BTK matching in the list view). Images are resized client-side (Canvas API, full + thumbnail) and downloaded as files/zip — there's no server storage, so an admin still has to drop the files into `assets/` and commit them, same as the encrypted-export workflow for static warehouses.
- **Keep-alive**: `.github/workflows/supabase-keepalive.yml` pings the database twice a week so the free-tier project doesn't pause after 7 days of inactivity. Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` repo secrets (Settings → Secrets and variables → Actions) — the service role key must **never** be committed or used client-side.
- **Other warehouses** (`2`, `3`, ...) are unaffected and keep using the offline-capable passphrase/envelope-encryption flow described above.

## Security Notes

- Passphrases never leave the browser
- Encrypted vaults stored in `localStorage` (`webware_vault`, `webware_keys`)
- Draft data stored separately (`webware_draft`)
- Clear Session button wipes all local data