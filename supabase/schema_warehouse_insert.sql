-- warehouses has only ever had a public-read policy (from the original setup) plus an admin-only
-- update policy (schema_warehouse_layout.sql) — nothing has ever let the app INSERT a new
-- warehouse row. Needed for self-service "+ Add Warehouse" (admin only) so new Supabase-backed
-- warehouses can be created from the app instead of by hand in the SQL Editor.
--
-- No new RLS is needed anywhere else for a new warehouse to start working: every items/kits/
-- warehouse_zones/etc. policy already compares against whatever warehouse_id a row actually has
-- (via profiles.warehouse_id or warehouse_permissions), rather than hardcoding warehouse '1' — so
-- a freshly inserted warehouse is covered by the existing policies immediately.
--
-- Run once in the Supabase SQL Editor.

create policy p_warehouses_insert on public.warehouses for insert to authenticated
  with check ((select role from public.profiles where id = auth.uid()) = 'admin');
grant insert on public.warehouses to authenticated;
