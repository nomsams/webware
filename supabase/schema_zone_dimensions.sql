-- Rack / shelf / bin dimensions per rack area (zone), in centimetres, so the Warehouse page can draw
-- the rack to scale in isometric 3D and the bin locator can show where a bin really sits.
--
-- shelf_width_cm and shelf_height_cm already exist (schema_zone_shelf_dimensions.sql) and are reused
-- as the shelf's width and its CLEAR height (top of a shelf board to the underside of the next
-- level) — this adds the rest: a rack (the whole frame) has a width per bay, a depth and a height;
-- a shelf (one level) also has a depth; a bin (one box on a shelf) has width, depth and height.
--
-- All nullable and unconstrained on purpose, same as the shelf columns: "not recorded yet" must stay
-- distinguishable from zero, and the app's own inputs already reject anything below 0.
--
-- Safe to run more than once. Until it's run, Save Layout still works — it just can't store these
-- sizes, and says so.
--
-- Run once in the Supabase SQL Editor, after schema_zone_shelf_dimensions.sql.

alter table public.warehouse_zones add column if not exists rack_width_cm numeric;
alter table public.warehouse_zones add column if not exists rack_depth_cm numeric;
alter table public.warehouse_zones add column if not exists rack_height_cm numeric;
alter table public.warehouse_zones add column if not exists shelf_depth_cm numeric;
alter table public.warehouse_zones add column if not exists bin_width_cm numeric;
alter table public.warehouse_zones add column if not exists bin_depth_cm numeric;
alter table public.warehouse_zones add column if not exists bin_height_cm numeric;
