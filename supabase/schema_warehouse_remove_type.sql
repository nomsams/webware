-- Two additions to public.warehouses, both admin-writable via the existing p_warehouses_update
-- policy (schema_warehouse_layout.sql) -- no new RLS needed, this is just new columns.
--
-- `active` backs "Remove Warehouse": a soft remove, not a real delete. Removing a warehouse must
-- NOT touch its items (items.warehouse_id references warehouses(l), and nothing about that should
-- change) -- so "removed" just means active=false, hiding it from the switcher and the Manage
-- Warehouses list, while every items/kits/etc. row that belongs to it is completely untouched and
-- the warehouse can be restored later (flip active back to true) with nothing to recover.
--
-- `type` records how a warehouse is meant to be reached, defaulting to 'database' since that's the
-- only kind "+ Add Warehouse" can create today (static warehouses 2/3 are hardcoded client-side,
-- offline encrypted vaults -- there's no self-service flow that creates one of those, so 'static'
-- exists in the check constraint for completeness/future use but nothing writes it yet).
--
-- Run once in the Supabase SQL Editor, after schema_warehouse_insert.sql.

alter table public.warehouses add column if not exists active boolean not null default true;
alter table public.warehouses add column if not exists type text not null default 'database';
alter table public.warehouses drop constraint if exists warehouses_type_check;
alter table public.warehouses add constraint warehouses_type_check check (type in ('database', 'static'));
