-- Lets admins read items from every warehouse, not just their own — needed for the item-detail
-- "present in other warehouses too" panel (admin-only), which looks up the same product
-- (matched by manufacturer + itemnumber) across every Supabase warehouse.
--
-- This is an ADDITIONAL policy, not a replacement for whatever the original items SELECT policy
-- already allows (from the initial setup, before this migration history) — Postgres ORs multiple
-- permissive policies together for the same table/action, so this is safe to add regardless of
-- whether admins could already read cross-warehouse or not; it can't narrow anything.
--
-- Run once in the Supabase SQL Editor.

create policy p_items_admin_read_all on public.items for select to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);
