-- Fixes "structure of query does not match function result type" when opening Manage Users (and
-- would hit list_warehouse_permissions() the same way, e.g. computing a maintainer's effective
-- per-warehouse role).
--
-- Root cause: auth.users.email is `character varying(255)`, not `text`. A plain SELECT silently
-- coerces varchar to text, but RETURN QUERY inside a function declared RETURNS TABLE(..., email
-- text, ...) checks the query's row type strictly against the declared output columns — varchar
-- isn't identical to text even though it's implicitly assignable, so Postgres rejects it. Both
-- list_profiles_with_email() (schema_user_management.sql) and list_warehouse_permissions()
-- (schema_maintainer_role.sql, both branches) select u.email straight from auth.users into a
-- column declared `text`; this just adds an explicit `u.email::text` cast at each site — same
-- query, same result, now actually assignable to the declared return type.
--
-- Run once in the Supabase SQL Editor, after schema_maintainer_role.sql.

create or replace function public.list_profiles_with_email()
returns table(id uuid, email text, role text, warehouse_id text)
language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, u.email::text, p.role, p.warehouse_id
    from public.profiles p
    join auth.users u on u.id = p.id
    order by u.email;
end; $$;
grant execute on function public.list_profiles_with_email to authenticated;

create or replace function public.list_warehouse_permissions()
returns table(user_id uuid, email text, warehouse_id text, role text)
language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) = 'admin' then
    return query
      select wp.user_id, u.email::text, wp.warehouse_id, wp.role
      from public.warehouse_permissions wp join auth.users u on u.id = wp.user_id;
  else
    return query
      select wp.user_id, u.email::text, wp.warehouse_id, wp.role
      from public.warehouse_permissions wp join auth.users u on u.id = wp.user_id
      where wp.user_id = auth.uid();
  end if;
end; $$;
grant execute on function public.list_warehouse_permissions to authenticated;
