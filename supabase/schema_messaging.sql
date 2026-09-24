-- Lightweight direct messages between users — one flat `messages` table, no `conversations` table.
-- A "conversation" between two people is just every row where they're sender or recipient; the
-- client buckets those by the other party client-side. Same philosophy as orders.items being a
-- jsonb snapshot instead of a join table (schema_orders.sql): the simplest shape that answers what's
-- actually needed today. Revisit if this grows into group threads or attachments.
--
-- Who can message whom: restricted to "colleagues" — two people who share a warehouse, either via
-- their home warehouse (profiles.warehouse_id) or a warehouse_permissions grant, in either
-- direction — mirroring how the rest of this app scopes visibility to warehouse membership rather
-- than opening things up to every signed-in account. An admin may message, or be messaged by,
-- anyone (same admin special-case list_profiles_with_email()/list_warehouse_permissions() already
-- use), since an admin has no particular warehouse in common with everyone else but should still be
-- reachable. shares_warehouse_with() backs both the insert policy and the recipient-picker RPC
-- below, so this rule lives in exactly one place.
--
-- Run once in the Supabase SQL Editor, after schema_maintainer_role.sql (needs warehouse_permissions)
-- and schema_display_names.sql (reuses get_display_name()).

create or replace function public.shares_warehouse_with(p_user_a uuid, p_user_b uuid)
returns boolean language sql security definer set search_path = public, pg_temp stable as $$
  select exists (
    select 1 from (
      select coalesce(warehouse_id, '') as wid from public.profiles where id = p_user_a
      union
      select warehouse_id from public.warehouse_permissions where user_id = p_user_a
    ) a
    join (
      select coalesce(warehouse_id, '') as wid from public.profiles where id = p_user_b
      union
      select warehouse_id from public.warehouse_permissions where user_id = p_user_b
    ) b on a.wid = b.wid and a.wid <> ''
  );
$$;
grant execute on function public.shares_warehouse_with to authenticated;

create table public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index messages_recipient_idx on public.messages(recipient_id, created_at desc);
create index messages_sender_idx on public.messages(sender_id, created_at desc);

alter table public.messages enable row level security;

create policy p_messages_select on public.messages for select to authenticated using (
  sender_id = auth.uid() or recipient_id = auth.uid()
);
create policy p_messages_insert on public.messages for insert to authenticated with check (
  sender_id = auth.uid()
  and recipient_id <> auth.uid()
  and (
    (select role from public.profiles where id = auth.uid()) = 'admin'
    or (select role from public.profiles where id = recipient_id) = 'admin'
    or public.shares_warehouse_with(auth.uid(), recipient_id)
  )
);
-- Only the recipient may touch a row, and the column-scoped grant below (not a table-wide UPDATE
-- grant) restricts that to read_at alone — same technique profiles.display_name's self-update grant
-- uses in schema_display_names.sql — so this can never be used to rewrite someone else's message.
create policy p_messages_update_read on public.messages for update to authenticated using (
  recipient_id = auth.uid()
) with check (
  recipient_id = auth.uid()
);

grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

-- Recipient picker for "new message" — every colleague (or everyone, if the caller is admin), never
-- admin-gated the way list_profiles_with_email() is, since any signed-in user should be able to see
-- who they can message. Reuses get_display_name()'s own name-resolution precedence (their chosen
-- display name, else their email's username) rather than re-deriving it here.
create or replace function public.list_colleagues()
returns table(id uuid, name text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) = 'admin' then
    return query
      select p.id, public.get_display_name(p.id)
      from public.profiles p
      where p.id <> auth.uid()
      order by 2;
  else
    return query
      select p.id, public.get_display_name(p.id)
      from public.profiles p
      where p.id <> auth.uid()
        and (p.role = 'admin' or public.shares_warehouse_with(auth.uid(), p.id))
      order by 2;
  end if;
end; $$;
grant execute on function public.list_colleagues to authenticated;
