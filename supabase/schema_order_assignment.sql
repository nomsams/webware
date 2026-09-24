-- Lets a Pack Order be routed to a specific colleague, instead of only ever sitting unassigned for
-- "whoever in this warehouse gets to it". assigned_to is purely informational/UX routing, not an
-- access-control gate: schema_grant_aware_policies.sql already lets anyone with ANY
-- warehouse_permissions grant for orders.warehouse_id see/update that row regardless of who created
-- or is assigned it, and orders' own grants (schema_orders.sql) are table-level, not column-scoped —
-- so no RLS or grant change is needed here at all. "Send to a warehouse" is simply leaving
-- assigned_to null (everyone with warehouse access already sees it); "send to a person" is just
-- setting the column. This also means assignment is advisory, not a claim/lock — nothing stops
-- someone else from picking up the same open order, consistent with how order visibility already
-- works.
--
-- Run once in the Supabase SQL Editor, after schema_orders.sql, schema_maintainer_role.sql, and
-- schema_display_names.sql (reuses get_display_name()).

alter table public.orders add column if not exists assigned_to uuid references auth.users(id);

-- Assignee picker for the Pack Order "Assign to" dropdown and the Incoming Orders queue's assignee
-- filter — the inverse of userWarehouseIds() in index.html (which goes profile -> warehouses this
-- person works in); this goes warehouse -> everyone who works in it. Gated so only a caller who
-- themselves has access to p_warehouse_id (admin, home warehouse, or a grant) can enumerate its
-- members, same shape as list_warehouse_permissions()'s own admin-vs-self split.
create or replace function public.list_warehouse_members(p_warehouse_id text)
returns table(id uuid, name text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (
    (select p.role from public.profiles p where p.id = auth.uid()) = 'admin'
    or exists (select 1 from public.profiles where id = auth.uid() and warehouse_id = p_warehouse_id)
    or exists (select 1 from public.warehouse_permissions where user_id = auth.uid() and warehouse_id = p_warehouse_id)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select p.id, public.get_display_name(p.id)
    from public.profiles p
    where p.warehouse_id = p_warehouse_id
       or p.id in (select user_id from public.warehouse_permissions where warehouse_id = p_warehouse_id)
    order by 2;
end; $$;
grant execute on function public.list_warehouse_members to authenticated;
