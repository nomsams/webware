-- Whether a rack area is drawn turned 90° on the Layout Designer's own 2D floor-plan grid (and the
-- Warehouse-floor isometric overview, modules/iso-rack.js's buildIsoFloorSVG) — purely which way the
-- SAME rack is installed on the floor. Deliberately separate from max_aisle (Bays) / max_rack
-- (Depth), which stay the rack's own real physical spec regardless: a rack that's 3 bays long and 1
-- deep is still 3 bays long and 1 deep whichever way it's turned, so rotating it must never swap
-- those two numbers (that would silently reshape the rack itself — different bay count per level,
-- different real Depth on every item's bin code — just because it was spun around on the map).
--
-- Nullable, and null/false both mean "drawn normally" (width = Bays, height = Depth) — the common
-- case and what every zone already is before anyone rotates one. true means the block's drawn
-- width/height (and the floor overview's footprint) swap to (Depth, Bays) instead, with max_aisle/
-- max_rack themselves completely untouched.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.

begin;

alter table public.warehouse_zones add column if not exists grid_rotated boolean;

comment on column public.warehouse_zones.grid_rotated is
  'Whether this rack area is drawn turned 90° on the 2D floor-plan grid / floor overview. Purely a floor-plan orientation flag — never changes max_aisle/max_rack (Bays/Depth) themselves, which stay the rack''s real physical spec either way.';

commit;
