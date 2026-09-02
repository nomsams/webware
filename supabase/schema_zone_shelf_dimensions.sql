-- Optional physical shelf dimensions per rack area (zone) — different zones can hold different
-- sizes of stock (e.g. a pallet zone's shelves are much bigger than a small-parts zone's), and
-- there was previously nowhere to record that. Nullable and unconstrained (no positive-only check)
-- on purpose: "not recorded yet" has to be distinguishable from "zero", and the app's own inputs
-- already enforce min="0".
--
-- Run once in the Supabase SQL Editor, after schema_warehouse_layout.sql.

alter table public.warehouse_zones add column if not exists shelf_width_cm numeric;
alter table public.warehouse_zones add column if not exists shelf_height_cm numeric;
