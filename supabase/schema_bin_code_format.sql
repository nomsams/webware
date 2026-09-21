-- Bin location codes now use the warehouse's own paper/Visma notation, written exactly the same way:
--
--     "Zone Depth-Level Bin-Row"      e.g.  A 3-3 1-1
--
-- (Zone A, Depth 3, Level 3, Bin 1, Row 1). Before this the code was "A3-3-01" (Bin zero-padded to two
-- digits, Row left off when it was 1). Two things follow from using the notation as it is written on
-- the shelves and in the Visma count file:
--   * Row is always present, also when it is 1;
--   * a coordinate that an import left in the free-text Inventory Location column is already a valid
--     bin code, so it can simply be MOVED into Bin Location - step 3 below does that.
--
-- 1. Converts anything already stored in the previous notation (items.location_code and the
--    last_inventoried_location snapshot) - a no-op when no code was ever set.
-- 2. Replaces the CHECK constraint on items.location_code.
-- 3. Moves a bin coordinate from inventorylocation to location_code, for every item that has no bin code
--    yet, and drops an inventorylocation that only repeats the item's own bin code. Reads the same
--    spellings the app does (any case/spacing, Row optional). Nothing else in inventorylocation is touched:
--    a note like "by the door", or a different coordinate, stays as it is.
--
-- The client mirrors all of this (normalizeBinCode / parseLocationCode / sanitizeLocationCodeForRow in
-- index.html), so a value that is typed or imported in any of those spellings ends up as the same code.
--
-- Safe to run more than once. Run once in the Supabase SQL Editor, after schema_bin_row.sql.

begin;

alter table public.items drop constraint if exists items_location_code_format;

-- 1. previous notation -> new notation ---------------------------------------------------------------------
update public.items i
   set location_code = s.m[1] || ' ' || (s.m[2]::int)::text || '-' || (s.m[3]::int)::text || ' '
                       || (s.m[4]::int)::text || '-' || coalesce((s.m[5]::int)::text, '1')
  from (select btk, regexp_match(location_code, '^([A-Z]{1,2})([0-9]{1,2})-([0-9]{1,2})-([0-9]{2})(?:-([0-9]{1,2}))?$') as m
          from public.items where location_code is not null) s
 where i.btk = s.btk and s.m is not null;

-- last_inventoried_location only exists once schema_inventering_history.sql has been run.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'items' and column_name = 'last_inventoried_location') then
    update public.items i
       set last_inventoried_location = s.m[1] || ' ' || (s.m[2]::int)::text || '-' || (s.m[3]::int)::text || ' '
                                       || (s.m[4]::int)::text || '-' || coalesce((s.m[5]::int)::text, '1')
      from (select btk, regexp_match(last_inventoried_location, '^([A-Z]{1,2})([0-9]{1,2})-([0-9]{1,2})-([0-9]{2})(?:-([0-9]{1,2}))?$') as m
              from public.items where last_inventoried_location is not null) s
     where i.btk = s.btk and s.m is not null;
  end if;
end $$;

-- 2. the constraint ------------------------------------------------------------------------------------------
alter table public.items add constraint items_location_code_format
  check (location_code is null or location_code ~ '^[A-Z]{1,2} [0-9]{1,2}-[0-9]{1,2} [0-9]{1,2}-[0-9]{1,2}$');

-- 3. a coordinate in inventorylocation belongs in location_code ----------------------------------------------
-- (a) no bin code yet: it becomes the code and leaves inventorylocation
update public.items i
   set location_code = upper(s.m[1]) || ' ' || (s.m[2]::int)::text || '-' || (s.m[3]::int)::text || ' '
                       || (s.m[4]::int)::text || '-' || coalesce((s.m[5]::int)::text, '1'),
       inventorylocation = null
  from (select btk, regexp_match(inventorylocation, '^\s*([A-Za-z]{1,2})\s*([0-9]{1,2})\s*-\s*([0-9]{1,2})\s+([0-9]{1,2})(?:\s*-\s*([0-9]{1,2}))?\s*$') as m
          from public.items where location_code is null and inventorylocation is not null) s
 where i.btk = s.btk and s.m is not null;

-- (b) already has a bin code: an inventorylocation that is just the same coordinate again is dropped
update public.items i
   set inventorylocation = null
  from (select btk, regexp_match(inventorylocation, '^\s*([A-Za-z]{1,2})\s*([0-9]{1,2})\s*-\s*([0-9]{1,2})\s+([0-9]{1,2})(?:\s*-\s*([0-9]{1,2}))?\s*$') as m
          from public.items where location_code is not null and inventorylocation is not null) s
 where i.btk = s.btk and s.m is not null
   and i.location_code = upper(s.m[1]) || ' ' || (s.m[2]::int)::text || '-' || (s.m[3]::int)::text || ' '
                         || (s.m[4]::int)::text || '-' || coalesce((s.m[5]::int)::text, '1');

commit;
