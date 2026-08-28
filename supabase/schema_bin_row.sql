-- Adds an optional Bin Row component to the Bin Location Code, for a shelf spot that's several
-- bins deep front-to-back (a bin sitting behind another isn't visible until the front one is
-- moved). Row is a bin's own front-to-back position on the shelf, distinct from rack Depth (which
-- is about racks, not individual bins) — see index.html's parseLocationCode()/
-- describeLocationCode() for the client-side counterpart.
--
-- The suffix is optional and left off entirely when Row is 1 (the front-most, default bin), so
-- every code written before this migration still matches the new constraint unchanged — no
-- backfill needed.
--
-- Example: 'A1-4-07' (unchanged, front-most/only bin) vs 'A1-4-07-2' (same spot, one bin back).
--
-- Run once in the Supabase SQL Editor, after schema_location_code_v2.sql.

alter table public.items drop constraint if exists items_location_code_format;
alter table public.items add constraint items_location_code_format
  check (location_code is null or location_code ~ '^[A-Z]{1,2}[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}(-[0-9]{1,2})?$');
