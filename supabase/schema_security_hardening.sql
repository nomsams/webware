-- SECURITY HARDENING — run this whole file once in the Supabase SQL Editor, as soon as possible. Every statement is
-- idempotent (drop-if-exists / create-or-replace / revoke / NOT VALID constraints), so re-running it is always safe.
--
-- Found by a security sweep of the whole project (this repo is open source, so assume the code is read and the
-- public anon key in index.html is used by someone who is NOT a user of the app):
--
--  1. CRITICAL — the admin-only RPCs could be called by anyone, no account needed.
--     Each of list_profiles_with_email(), update_user_role(), set_warehouse_permission(),
--     revoke_warehouse_permission(), revert_activity_log_entry() (and list_warehouse_members()) guarded itself with
--         if (select role from profiles where id = auth.uid()) != 'admin' then raise exception ...
--     When there is no signed-in user (the anon role) or the caller has no profiles row, that subquery is NULL,
--     `NULL != 'admin'` is NULL, and `if NULL` does NOT fire — the guard is silently skipped. Postgres also grants
--     EXECUTE on every function to PUBLIC by default, and `grant execute ... to authenticated` never removed that,
--     so anyone holding the anon key (it is in index.html) could PostgREST-call /rpc/update_user_role and make any
--     user an admin, list every account's email, or revert (= delete) items. Fixed twice over: EXECUTE is revoked from
--     PUBLIC/anon on every app function, and every gate is rewritten NULL-safe through is_app_admin().
--  2. activity_log inserts were not tied to the caller: any editor could write a log row for ANY warehouse, as ANY
--     user_id, with arbitrary before/after data — and an admin pressing "revert" on such a row made the revert RPC
--     delete/overwrite whatever item the forged row named, in any warehouse. Inserts are now bound to the caller
--     (user_id = auth.uid(), their own warehouse, never the reverted_* columns or action 'revert'), and the revert RPC
--     only ever touches items of the entry's own warehouse.
--  3. kits / kit_items: insert and update policies checked only "is an editor" — not whose warehouse — so an editor in
--     one warehouse could create, rename, move or empty another warehouse's kits. Scoped to the caller's warehouse; a
--     kit may only contain items of its own warehouse.
--  4. item_images: a photo row could point at another warehouse's item (and, via the one-main-photo-per-item index,
--     block that item from ever getting a main photo). The row's warehouse must be the item's.
--  5. The "column-scoped" grants (profiles.display_name, messages.read_at) only restrict anything if the role does not
--     also hold a TABLE-wide UPDATE privilege, which Supabase's default privileges hand out. Table-wide UPDATE is now
--     revoked and only the one column re-granted; anon is stripped of every table/sequence privilege.
--  6. messages had no rate limit (an editor could script thousands of broadcasts to a whole warehouse): 20 / minute.
--  7. Input limits at the database, so a hand-written API call can't store a 100 MB comment or a javascript: link
--     (NOT VALID: applies to new and changed rows, never scans or rejects data that is already there).
--  8. The image buckets accept JPEG/PNG/WebP up to 8 MB only (no HTML/SVG served from the project's storage domain).
--
-- NOT fixable from SQL — do these in the Supabase dashboard:
--   * Authentication -> Providers -> Email: turn OFF "Allow new users to sign up" unless anyone should be able to
--     create an account (this is an invite-only warehouse tool; accounts are created by you), and turn on
--     "Confirm email" / a strong minimum password length.
--   * Authentication -> Rate limits: keep the defaults or tighten them.
--
-- After running it, re-run schema_audit.sql — rows #48-#50 check the three most important parts.

begin;

-- ── 1a. anon gets nothing ─────────────────────────────────────────────────────────────────────────────────────────
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
do $$ begin
  alter default privileges in schema public revoke all on tables from anon;
  alter default privileges in schema public revoke all on sequences from anon;
  alter default privileges in schema public revoke execute on functions from anon;
exception when others then
  raise notice 'could not change default privileges (%): new tables/functions may still be granted to anon by Supabase defaults — check them by hand', sqlerrm;
end $$;

-- ── 1b. a NULL-proof admin test, used by every gate below ──────────────────────────────────────────────────────────
-- Never returns NULL: no session, no profile row, a NULL role all give false.
create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null
     and coalesce((select p.role from public.profiles p where p.id = auth.uid()), '') = 'admin';
$$;

-- ── 1c. the gated functions, rewritten NULL-safe (and pinned to search_path — create or replace resets it) ──────────
create or replace function public.list_profiles_with_email()
returns table(id uuid, email text, role text, warehouse_id text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;
  return query
    select p.id, u.email::text, p.role, p.warehouse_id
    from public.profiles p
    join auth.users u on u.id = p.id
    order by u.email;
end; $$;

-- Also refuses to leave the project without an admin: demoting the only admin (even yourself by accident) would lock
-- everyone out of Manage Users, and only the SQL Editor could repair it.
create or replace function public.update_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current text;
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;
  if p_role is null or p_role not in ('viewer', 'editor', 'maintainer', 'admin') then
    raise exception 'invalid role: %', p_role;
  end if;
  select p.role into v_current from public.profiles p where p.id = p_user_id;
  if not found then raise exception 'no such user'; end if;
  if v_current = 'admin' and p_role <> 'admin'
     and (select count(*) from public.profiles p where p.role = 'admin') <= 1 then
    raise exception 'cannot demote the last admin';
  end if;
  update public.profiles set role = p_role where id = p_user_id;
end; $$;

create or replace function public.set_warehouse_permission(p_user_id uuid, p_warehouse_id text, p_role text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;
  if p_role is null or p_role not in ('viewer', 'editor', 'maintainer', 'admin') then
    raise exception 'invalid role: %', p_role;
  end if;
  insert into public.warehouse_permissions (user_id, warehouse_id, role)
  values (p_user_id, p_warehouse_id, p_role)
  on conflict (user_id, warehouse_id) do update set role = excluded.role;
end; $$;

create or replace function public.revoke_warehouse_permission(p_user_id uuid, p_warehouse_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;
  delete from public.warehouse_permissions where user_id = p_user_id and warehouse_id = p_warehouse_id;
end; $$;

create or replace function public.list_warehouse_permissions()
returns table(user_id uuid, email text, warehouse_id text, role text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if public.is_app_admin() then
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

create or replace function public.list_warehouse_members(p_warehouse_id text)
returns table(id uuid, name text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not (
    public.is_app_admin()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.warehouse_id = p_warehouse_id)
    or exists (select 1 from public.warehouse_permissions wp where wp.user_id = auth.uid() and wp.warehouse_id = p_warehouse_id)
  ) then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, public.get_display_name(p.id)
    from public.profiles p
    where p.warehouse_id = p_warehouse_id
       or p.role = 'admin'
       or p.id in (select wp.user_id from public.warehouse_permissions wp where wp.warehouse_id = p_warehouse_id)
    order by 2;
end; $$;

create or replace function public.list_colleagues()
returns table(id uuid, name text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if public.is_app_admin() then
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

create or replace function public.get_display_name(p_user_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_display_name text;
  v_email text;
begin
  if auth.uid() is null then return null; end if;
  select display_name into v_display_name from public.profiles where id = p_user_id;
  if v_display_name is not null and v_display_name <> '' then
    return v_display_name;
  end if;
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then return null; end if;
  return split_part(v_email, '@', 1);
end; $$;

create or replace function public.list_llm_api_keys()
returns table(id bigint, provider text, label text, active boolean, created_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_app_admin() then return; end if;   -- a non-admin gets an empty set, as before
  return query
    select k.id, k.provider, k.label, k.active, k.created_at
    from public.llm_api_keys k
    order by k.created_at asc;
end; $$;

-- The revert RPC (latest body: schema_visma_sync.sql), with two additions: it only ever acts on the item of the log
-- entry's OWN warehouse (a forged/foreign entry can no longer name another warehouse's item), and a re-inserted item
-- must carry that same warehouse and BTK.
create or replace function public.revert_activity_log_entry(p_log_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  entry public.activity_log%rowtype;
  current_row jsonb;
  restore_to jsonb;
begin
  if not public.is_app_admin() then raise exception 'not authorized'; end if;

  select * into entry from public.activity_log where id = p_log_id;
  if not found then raise exception 'log entry not found'; end if;
  if entry.reverted_at is not null then raise exception 'already reverted'; end if;
  if entry.entity_type <> 'item' then raise exception 'unsupported entity type'; end if;

  select to_jsonb(i) into current_row from public.items i where i.btk = entry.entity_id and i.warehouse_id = entry.warehouse_id;
  restore_to := entry.before_data;

  if restore_to is null then
    -- Reverting a 'create': the item shouldn't exist (in THIS entry's warehouse — never anywhere else).
    delete from public.items where btk = entry.entity_id and warehouse_id = entry.warehouse_id;
  elsif current_row is null then
    -- Reverting a 'delete': re-insert from the snapshot, which must describe this entry's own item.
    if restore_to->>'warehouse_id' is distinct from entry.warehouse_id or restore_to->>'btk' is distinct from entry.entity_id then
      raise exception 'snapshot does not match the log entry';
    end if;
    insert into public.items select * from jsonb_populate_record(null::public.items, restore_to);
  else
    update public.items set
      manufacturer = restore_to->>'manufacturer',
      manufacturer_id = (restore_to->>'manufacturer_id')::bigint,
      itemnumber = restore_to->>'itemnumber',
      itemname_en = restore_to->>'itemname_en',
      itemname_sv = restore_to->>'itemname_sv',
      itemnumber2 = restore_to->>'itemnumber2',
      itemnumber3 = restore_to->>'itemnumber3',
      numberofitems = (restore_to->>'numberofitems')::integer,
      inventorylocation = restore_to->>'inventorylocation',
      map_position = restore_to->>'map_position',
      location_code = restore_to->>'location_code',
      comments = restore_to->>'comments',
      visma_qty = case when restore_to ? 'visma_qty' then (restore_to->>'visma_qty')::numeric else items.visma_qty end,
      visma_synced_at = case when restore_to ? 'visma_synced_at' then (restore_to->>'visma_synced_at')::timestamptz else items.visma_synced_at end
    where btk = entry.entity_id and warehouse_id = entry.warehouse_id;
  end if;

  insert into public.activity_log (warehouse_id, user_id, action, entity_type, entity_id, before_data, after_data, summary, revert_of_id)
  values (entry.warehouse_id, auth.uid(), 'revert', entry.entity_type, entry.entity_id, current_row, restore_to,
          'Reverted: ' || entry.summary, entry.id);

  update public.activity_log set reverted_at = now(), reverted_by = auth.uid() where id = p_log_id;
end; $$;

-- ── 1d. EXECUTE: nobody but signed-in users, on every function the app calls ───────────────────────────────────────
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('is_app_admin', 'list_profiles_with_email', 'update_user_role', 'set_warehouse_permission',
                        'revoke_warehouse_permission', 'list_warehouse_permissions', 'revert_activity_log_entry',
                        'list_llm_api_keys', 'has_llm_api_key', 'count_llm_api_keys', 'get_display_name',
                        'shares_warehouse_with', 'list_colleagues', 'list_warehouse_members', 'adjust_item_stock',
                        'set_updated_meta', 'messages_rate_limit')
  loop
    execute format('revoke execute on function %s from public, anon', fn.sig);
    -- trigger functions never need to be callable by a client at all
    if fn.proname not in ('set_updated_meta', 'messages_rate_limit') then
      execute format('grant execute on function %s to authenticated', fn.sig);
    end if;
  end loop;
end $$;

-- Everything below is wrapped per section: a table or column from a migration you have not run yet is skipped with a
-- NOTICE (run schema_audit.sql, apply what it lists as missing, then re-run this file) instead of aborting the rest.

-- ── 2. activity_log: inserts are bound to the caller ───────────────────────────────────────────────────────────────
do $$ begin
  drop policy if exists p_activity_log_insert on public.activity_log;
  create policy p_activity_log_insert on public.activity_log for insert to authenticated with check (
    user_id = auth.uid()
    and action in ('create', 'update', 'delete')            -- 'revert' rows are written only by revert_activity_log_entry()
    and reverted_at is null and reverted_by is null and revert_of_id is null
    and (
      exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('editor', 'maintainer')
                 and p.warehouse_id = activity_log.warehouse_id)
      or exists (select 1 from public.warehouse_permissions wp where wp.user_id = auth.uid()
                 and wp.warehouse_id = activity_log.warehouse_id and wp.role in ('editor', 'maintainer', 'admin'))
    )
  );
  revoke update, delete, truncate on public.activity_log from authenticated;   -- append-only for clients
exception when undefined_table or undefined_column then raise notice 'section 2 skipped: %', sqlerrm;
end $$;

-- ── 3. kits / kit_items scoped to the caller's warehouse ───────────────────────────────────────────────────────────
do $$ begin
  drop policy if exists p_kits_insert on public.kits;
  create policy p_kits_insert on public.kits for insert to authenticated with check (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = kits.warehouse_id)))
  );
  drop policy if exists p_kits_update on public.kits;
  create policy p_kits_update on public.kits for update to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = kits.warehouse_id)))
  ) with check (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = kits.warehouse_id)))
  );
  drop policy if exists p_kit_items_insert on public.kit_items;
  create policy p_kit_items_insert on public.kit_items for insert to authenticated with check (
    exists (select 1 from public.kits k join public.profiles p on p.id = auth.uid()
            where k.id = kit_items.kit_id and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = k.warehouse_id))
              and exists (select 1 from public.items i where i.btk = kit_items.btk and i.warehouse_id = k.warehouse_id))
  );
  drop policy if exists p_kit_items_update on public.kit_items;
  create policy p_kit_items_update on public.kit_items for update to authenticated using (
    exists (select 1 from public.kits k join public.profiles p on p.id = auth.uid()
            where k.id = kit_items.kit_id and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = k.warehouse_id)))
  ) with check (
    exists (select 1 from public.kits k join public.profiles p on p.id = auth.uid()
            where k.id = kit_items.kit_id and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = k.warehouse_id))
              and exists (select 1 from public.items i where i.btk = kit_items.btk and i.warehouse_id = k.warehouse_id))
  );
exception when undefined_table or undefined_column then raise notice 'section 3 skipped: %', sqlerrm;
end $$;

-- ── 4. item_images: the photo's warehouse must be its item's ───────────────────────────────────────────────────────
do $$ begin
  drop policy if exists p_item_images_write on public.item_images;
  create policy p_item_images_write on public.item_images for all to authenticated using (
    (
      warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
      and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer', 'admin')
    )
    or (select role from public.profiles where id = auth.uid()) = 'admin'
    or exists (
      select 1 from public.warehouse_permissions wp
      where wp.user_id = auth.uid() and wp.warehouse_id = item_images.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
    )
  ) with check (
    exists (select 1 from public.items i where i.btk = item_images.btk and i.warehouse_id = item_images.warehouse_id)
    and (
      (
        warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
        and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer', 'admin')
      )
      or (select role from public.profiles where id = auth.uid()) = 'admin'
      or exists (
        select 1 from public.warehouse_permissions wp
        where wp.user_id = auth.uid() and wp.warehouse_id = item_images.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
      )
    )
  );
exception when undefined_table or undefined_column then raise notice 'section 4 skipped: %', sqlerrm;
end $$;

-- ── 5. column-scoped grants that actually scope ────────────────────────────────────────────────────────────────────
-- profiles: a signed-in user may change ONLY their own display_name (the client writes nothing else directly; role and
-- home warehouse change through update_user_role()/the admin RPCs). Without this a table-wide UPDATE privilege + the
-- own-row policy would let anyone set their own role to 'admin'.
do $$ begin
  revoke insert, update, delete, truncate on public.profiles from authenticated;
  grant update (display_name) on public.profiles to authenticated;
exception when undefined_table or undefined_column then raise notice 'section 5a skipped: %', sqlerrm;
end $$;
-- messages: the recipient may only mark a message read, never rewrite it; nobody deletes through the API.
do $$ begin
  revoke update, delete, truncate on public.messages from authenticated;
  grant update (read_at) on public.messages to authenticated;
exception when undefined_table or undefined_column then raise notice 'section 5b skipped: %', sqlerrm;
end $$;
do $$ begin
  revoke update, delete, truncate on public.message_reads from authenticated;
exception when undefined_table then raise notice 'section 5c skipped: %', sqlerrm;
end $$;
-- raw API keys are never readable by a client, whatever the policies say
do $$ begin
  revoke select, update, truncate on public.llm_api_keys from authenticated;
exception when undefined_table then raise notice 'section 5d skipped: %', sqlerrm;
end $$;

-- ── 6. message flood control: 20 per minute per sender ─────────────────────────────────────────────────────────────
create or replace function public.messages_rate_limit()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (select count(*) from public.messages m where m.sender_id = new.sender_id and m.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'too many messages — wait a minute and try again';
  end if;
  return new;
end; $$;
revoke execute on function public.messages_rate_limit() from public, anon, authenticated;
do $$ begin
  drop trigger if exists trg_messages_rate_limit on public.messages;
  create trigger trg_messages_rate_limit before insert on public.messages
    for each row execute function public.messages_rate_limit();
exception when undefined_table then raise notice 'section 6 skipped: %', sqlerrm;
end $$;

-- ── 7. input limits (NOT VALID: enforced for new/changed rows; existing rows are never scanned or rejected) ─────────
do $$ begin
  alter table public.items drop constraint if exists items_input_limits;
  alter table public.items add constraint items_input_limits check (
    char_length(coalesce(itemname_en, '')) <= 1000 and char_length(coalesce(itemname_sv, '')) <= 1000
    and char_length(coalesce(itemnumber, '')) <= 300 and char_length(coalesce(itemnumber2, '')) <= 300 and char_length(coalesce(itemnumber3, '')) <= 300
    and char_length(coalesce(manufacturer, '')) <= 300 and char_length(coalesce(inventorylocation, '')) <= 300
    and char_length(coalesce(comments, '')) <= 20000 and char_length(coalesce(link, '')) <= 2000
    -- a stored link is rendered as a clickable <a href>; never a script-bearing scheme
    and coalesce(link, '') !~* '^\s*(javascript|data|vbscript|file):'
  ) not valid;
exception when undefined_table or undefined_column then raise notice 'section 7a skipped: %', sqlerrm;
end $$;
do $$ begin
  alter table public.orders drop constraint if exists orders_input_limits;
  alter table public.orders add constraint orders_input_limits check (
    char_length(coalesce(recipient_name, '')) <= 300 and char_length(coalesce(recipient_address, '')) <= 1500
    and jsonb_typeof(items) = 'array' and pg_column_size(items) <= 262144
    and coalesce(box_length, 0) >= 0 and coalesce(box_width, 0) >= 0 and coalesce(box_height, 0) >= 0 and coalesce(box_weight, 0) >= 0
  ) not valid;
exception when undefined_table or undefined_column then raise notice 'section 7b skipped: %', sqlerrm;
end $$;
do $$ begin
  alter table public.kits drop constraint if exists kits_input_limits;
  alter table public.kits add constraint kits_input_limits check (char_length(coalesce(name, '')) <= 300) not valid;
exception when undefined_table or undefined_column then raise notice 'section 7c skipped: %', sqlerrm;
end $$;

-- ── 8. image buckets: pictures only, bounded size ──────────────────────────────────────────────────────────────────
update storage.buckets
   set file_size_limit = 8388608,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id in ('item-images', 'manufacturer-logos', 'rack-images');

commit;
