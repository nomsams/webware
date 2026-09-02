-- What Numberofitems is counted IN — "5" alone is ambiguous (5 what?); "5 st" (Swedish "styck",
-- i.e. each/piece — the default) or "25 liter" isn't. No CHECK constraint on purpose: the app's UI
-- only ever offers a fixed dropdown (st/kg/liter/pallet/box/bag — see UNIT_TYPES in index.html),
-- but leaving the column itself unconstrained means adding another unit later is a client-only
-- change, not another migration.
--
-- Run once in the Supabase SQL Editor.

alter table public.items add column if not exists unit_type text not null default 'st';
