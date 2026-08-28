-- Adds the two columns the Layout Designer (Warehouse page → 🖊️ Draw / ⌨️ Manual) needs to
-- redraw a saved layout in the same place every time: where a zone's block sits on the drawing
-- grid. Width/height in cells reuse the existing max_aisle/max_rack columns from
-- schema_warehouse_layout.sql (a zone drawn 5 cells wide really does mean "5 aisles") rather than
-- adding separate span columns — one less thing that could drift out of sync.
--
-- Run once in the Supabase SQL Editor, after schema_warehouse_layout.sql.

alter table public.warehouse_zones add column if not exists grid_col smallint;
alter table public.warehouse_zones add column if not exists grid_row smallint;
