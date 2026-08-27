-- Lets an admin manage roles from within the app instead of hand-editing the profiles table via
-- SQL Editor. Both functions are security definer so they can join auth.users (not directly
-- queryable by clients) and write profiles, but each checks the caller is an admin itself before
-- doing anything — the RLS-equivalent check lives inside the function body.
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

-- Fix (re-run safe via create or replace): the original version wrote "select role from
-- profiles ..." inside a function whose RETURNS TABLE also declares an output column named
-- "role" — plpgsql resolves bare "role" against that output column first, so it collided with
-- profiles.role and Postgres rejected the query as ambiguous. Every profiles column reference is
-- now qualified with the "p" alias to rule that out for good, not just patched at this one spot.
create or replace function public.list_profiles_with_email()
returns table(id uuid, email text, role text, warehouse_id text)
language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, u.email, p.role, p.warehouse_id
    from public.profiles p
    join auth.users u on u.id = p.id
    order by u.email;
end; $$;
grant execute on function public.list_profiles_with_email to authenticated;

create or replace function public.update_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception 'invalid role: %', p_role;
  end if;
  update public.profiles set role = p_role where id = p_user_id;
end; $$;
grant execute on function public.update_user_role to authenticated;
