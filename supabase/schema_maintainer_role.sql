-- Adds a 4th role, "maintainer", whose permissions are granted PER WAREHOUSE (via the new
-- warehouse_permissions table) rather than being one fixed capability set everywhere. viewer/
-- editor/admin keep working exactly as before — one profiles.role, effective in the user's single
-- home warehouse (profiles.warehouse_id). A warehouse_permissions grant is additive on top of
-- that: it can hand someone a *different* role in one *specific* other warehouse without touching
-- their global role or home warehouse. This isn't limited to 'maintainer' — you can also grant
-- 'viewer', 'editor', or 'admin'-for-that-warehouse this same way, e.g. an editor who should only
-- be a viewer in one particular warehouse.
--
-- Default maintainer capabilities in a warehouse they're granted 'maintainer' in: everywhere the
-- app already gates on "not a viewer" (adjusting stock, adding items, editing item fields — see
-- canEditItems() in index.html) now also passes for a maintainer grant on that warehouse, same as
-- it already does for editor. This migration does NOT restrict maintainer to *only* quantity
-- changes — that would need column-level grants (like profiles.display_name's self-update grant
-- elsewhere in this schema), a further step if you want that narrower behavior enforced
-- server-side rather than by what the UI happens to expose.
--
-- Scope: only items.* RLS is extended to honor warehouse_permissions here. Other tables (orders,
-- kits, manufacturers, warehouse_zones, warehouse_rack_images) still use only the existing
-- profiles.role/profiles.warehouse_id model — extend those the same way later if per-warehouse
-- grants should reach them too.
--
-- Run once in the Supabase SQL Editor, after schema_admin_cross_warehouse_items.sql.

-- Allow 'maintainer' wherever the role CHECK constraint on profiles lives — its name isn't known
-- here (it predates this migration history), so find it dynamically rather than guessing.
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', con.conname);
  end loop;
end $$;
alter table public.profiles add constraint profiles_role_check check (role in ('viewer', 'editor', 'maintainer', 'admin'));

create table public.warehouse_permissions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  warehouse_id text not null references public.warehouses(l),
  role text not null check (role in ('viewer', 'editor', 'maintainer', 'admin')),
  created_at timestamptz default now(),
  unique (user_id, warehouse_id)
);

alter table public.warehouse_permissions enable row level security;

create policy p_warehouse_permissions_select on public.warehouse_permissions for select to authenticated using (
  user_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'admin'
);
create policy p_warehouse_permissions_write on public.warehouse_permissions for all to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
) with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);
grant select, insert, update, delete on public.warehouse_permissions to authenticated;

-- Additive to whatever the original items policies already allow (Postgres ORs permissive
-- policies together) — a user with no warehouse_permissions row keeps working exactly as before.
-- 'maintainer' and 'editor' grants behave the same on items (full read/write in that warehouse);
-- 'viewer' grants read-only; 'admin' grants full access.
create policy p_items_warehouse_permission_select on public.items for select to authenticated using (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id
  )
);
create policy p_items_warehouse_permission_write on public.items for all to authenticated using (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
  )
) with check (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
  )
);

-- Admin-only RPCs for the Manage Users UI to grant/revoke a per-warehouse role. security definer
-- so they can write warehouse_permissions directly; each checks the caller is an admin itself
-- first — same shape (and same "p." table alias to avoid the RETURNS TABLE column-name collision
-- that bit list_profiles_with_email() before) as update_user_role() in schema_user_management.sql.
create or replace function public.set_warehouse_permission(p_user_id uuid, p_warehouse_id text, p_role text)
returns void language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;
  if p_role not in ('viewer', 'editor', 'maintainer', 'admin') then
    raise exception 'invalid role: %', p_role;
  end if;
  insert into public.warehouse_permissions (user_id, warehouse_id, role)
  values (p_user_id, p_warehouse_id, p_role)
  on conflict (user_id, warehouse_id) do update set role = excluded.role;
end; $$;
grant execute on function public.set_warehouse_permission to authenticated;

create or replace function public.revoke_warehouse_permission(p_user_id uuid, p_warehouse_id text)
returns void language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;
  delete from public.warehouse_permissions where user_id = p_user_id and warehouse_id = p_warehouse_id;
end; $$;
grant execute on function public.revoke_warehouse_permission to authenticated;

-- Admins see every grant (for the Manage Users UI); anyone else sees only their own (to compute
-- their effective role in a warehouse client-side — see computeEffectiveRole() in index.html).
-- Without that split this would leak every user's email + every grant to every signed-in account.
create or replace function public.list_warehouse_permissions()
returns table(user_id uuid, email text, warehouse_id text, role text)
language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) = 'admin' then
    return query
      select wp.user_id, u.email, wp.warehouse_id, wp.role
      from public.warehouse_permissions wp join auth.users u on u.id = wp.user_id;
  else
    return query
      select wp.user_id, u.email, wp.warehouse_id, wp.role
      from public.warehouse_permissions wp join auth.users u on u.id = wp.user_id
      where wp.user_id = auth.uid();
  end if;
end; $$;
grant execute on function public.list_warehouse_permissions to authenticated;
