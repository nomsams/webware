-- Records when an item was last counted during an Inventering (stocktaking) session: when, by
-- whom, and at what bin location at the time (a snapshot, not a live reference — if the item's
-- location_code changes later, this still shows where it actually was when it was counted).
-- Only "last" is tracked (three columns on items), not a full history log — matches what was
-- asked for. A separate log table would be the natural next step if a full audit trail is wanted.
--
-- Run once in the Supabase SQL Editor, after schema_location_code_v2.sql.

alter table public.items add column if not exists last_inventoried_at timestamptz;
alter table public.items add column if not exists last_inventoried_by uuid references auth.users(id);
alter table public.items add column if not exists last_inventoried_location text;

-- Marking an item "Done" during Inventering only touches these three columns — narrower than the
-- general item-edit permission a viewer already lacks, but still requires being able to write to
-- the item at all, so this reuses the existing editor/admin update grant on items rather than
-- adding a new one.
