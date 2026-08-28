-- Adds a granular bin/picking location per item, on top of the existing coarse `map_position`
-- locator grid (A1-F6) and free-text `inventorylocation` — this is the third, most detailed of
-- the three, meant for actual stocktaking ("inventering") and pick walks rather than a quick
-- visual reference. See the "Bin Location Codes" section in README.md for the full numbering
-- convention (what Zone/Aisle/Rack/Level/Bin mean, and which end each count starts from).
--
-- Format: <Zone>-<Aisle>-<Rack>-<Level>-<Bin>, e.g. 'A-03-2-4-07'. Zone is 1-2 letters; Aisle and
-- Bin are always zero-padded to 2 digits; Rack and Level are 1-2 digits, unpadded. Stored as a
-- single text field (like map_position) rather than five separate columns — simplest option
-- given there's no per-component querying need today; the CHECK constraint below still keeps
-- entries honest, and the app parses it client-side for display and for "Sort: Bin Location".
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

alter table public.items add column if not exists location_code text;

alter table public.items add constraint items_location_code_format
  check (location_code is null or location_code ~ '^[A-Z]{1,2}-[0-9]{2}-[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}$');

create index if not exists idx_items_location_code on public.items (warehouse_id, location_code);
