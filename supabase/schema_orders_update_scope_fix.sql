-- p_orders_update (schema_orders.sql) only checked the caller's role, unlike p_orders_select and
-- p_orders_insert, which both also require warehouse_id to be the caller's own warehouse (or the
-- caller to be admin). That gap let ANY editor — from any warehouse, not just their own — update
-- any other warehouse's saved orders, including recipient_name/recipient_address (real people's
-- shipping details) and the item lines. This brings update in line with select/insert.
--
-- Run once in the Supabase SQL Editor, after schema_orders.sql.

drop policy if exists p_orders_update on public.orders;
create policy p_orders_update on public.orders for update to authenticated using (
  (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  and (
    warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
    or (select role from public.profiles where id = auth.uid()) = 'admin'
  )
);
