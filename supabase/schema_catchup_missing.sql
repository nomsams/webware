-- Combined catch-up for whatever schema_audit.sql showed as MISSING on this project (as of the
-- audit run that found #13, #14, #18 not applied). Safe to run as one paste — each block is the
-- exact content of its own file below, run in order; nothing here depends on anything not already
-- present per the rest of the audit showing "applied". Re-running this file is safe (every
-- statement is idempotent: `add column if not exists`, `drop policy if exists` before `create`).
--
-- Source files, for reference: supabase/schema_inventering_history.sql,
-- supabase/schema_admin_cross_warehouse_items.sql, supabase/schema_warehouse_remove_type.sql.

-- ═══ #13 — schema_inventering_history.sql ═══
-- Records when an item was last counted during Stocktaking: when, by whom, and at what bin
-- location at the time (a snapshot, not a live reference).
alter table public.items add column if not exists last_inventoried_at timestamptz;
alter table public.items add column if not exists last_inventoried_by uuid references auth.users(id);
alter table public.items add column if not exists last_inventoried_location text;

-- ═══ #14 — schema_admin_cross_warehouse_items.sql ═══
-- Lets admins read items from every warehouse, not just their own — needed for "Present in other
-- warehouses" on the item page. Additive (Postgres ORs permissive policies together), so this is
-- safe regardless of whatever the original SELECT policy already allows.
drop policy if exists p_items_admin_read_all on public.items;
create policy p_items_admin_read_all on public.items for select to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);

-- ═══ #18 — schema_warehouse_remove_type.sql ═══
-- `active` backs "Remove Warehouse" (soft remove — items/kits/etc. untouched, restorable).
-- `type` records how a warehouse is meant to be reached, default 'database'.
alter table public.warehouses add column if not exists active boolean not null default true;
alter table public.warehouses add column if not exists type text not null default 'database';
alter table public.warehouses drop constraint if exists warehouses_type_check;
alter table public.warehouses add constraint warehouses_type_check check (type in ('database', 'static'));
