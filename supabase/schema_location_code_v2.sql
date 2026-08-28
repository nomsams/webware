-- Simplifies the bin location code from 5 components (Zone-Aisle-Rack-Level-Bin) down to 4:
-- Zone+Depth-Level-Bin, e.g. "A1-4-07" — zone A, the front rack (depth 1; 2 would be the back
-- rack in a back-to-back pair), Level 4, Bin 7. "Aisle" is dropped as a per-item concept: a
-- rack area's width (warehouse_zones.max_aisle, still used by the Layout Designer's drawing) was
-- never really a property of an individual item, only of the rack area as a whole, and "Rack" is
-- renamed to "Depth" to match what it always actually meant here — which physical rack of a
-- back-to-back pair, not a location along the row.
--
-- Old format example -> new: 'A-03-2-4-07' (zone A, aisle 03, rack 2, level 4, bin 07)
--                          -> 'A2-4-07'      (zone A, depth 2, level 4, bin 07) — aisle is dropped.
--
-- Run once in the Supabase SQL Editor, after schema_bin_location.sql. Safe to run even if
-- location_code is still empty on every row (the UPDATE below is a no-op then).

alter table public.items drop constraint if exists items_location_code_format;

-- Transform any existing old-format values before the new, stricter constraint would reject them.
update public.items
set location_code = (regexp_match(location_code, '^([A-Z]{1,2})-\d{1,2}-(\d{1,2})-(\d{1,2})-(\d{2})$'))[1]
                     || (regexp_match(location_code, '^([A-Z]{1,2})-\d{1,2}-(\d{1,2})-(\d{1,2})-(\d{2})$'))[2]
                     || '-' || (regexp_match(location_code, '^([A-Z]{1,2})-\d{1,2}-(\d{1,2})-(\d{1,2})-(\d{2})$'))[3]
                     || '-' || (regexp_match(location_code, '^([A-Z]{1,2})-\d{1,2}-(\d{1,2})-(\d{1,2})-(\d{2})$'))[4]
where location_code ~ '^[A-Z]{1,2}-\d{1,2}-\d{1,2}-\d{1,2}-\d{2}$';

alter table public.items add constraint items_location_code_format
  check (location_code is null or location_code ~ '^[A-Z]{1,2}[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}$');
