-- "Last updated by" attribution for items. profiles has no name/email column and clients can't
-- query auth.users directly, so get_display_name() is a security-definer function that resolves
-- a user id to: their own chosen display_name if set, otherwise the part of their email before
-- "@". Callable by any authenticated user (not just admin) since anyone viewing an item should be
-- able to see who last touched it — it only ever returns a name string, never the raw email.
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

alter table public.profiles add column if not exists display_name text;

-- Users may update ONLY their own display_name — RLS restricts the row, the column-scoped GRANT
-- (not a table-wide one) restricts which column, so this can never be used to self-promote role.
create policy p_profile_update_self on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant update (display_name) on public.profiles to authenticated;

create or replace function public.get_display_name(p_user_id uuid)
returns text language plpgsql security definer as $$
declare
  v_display_name text;
  v_email text;
begin
  select display_name into v_display_name from public.profiles where id = p_user_id;
  if v_display_name is not null and v_display_name <> '' then
    return v_display_name;
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then return null; end if;
  return split_part(v_email, '@', 1);
end; $$;
grant execute on function public.get_display_name to authenticated;
