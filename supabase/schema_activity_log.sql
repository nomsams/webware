-- Audit trail for item changes (Supabase-mode warehouses only — "who did this" requires a real
-- account, which static warehouses 2/3 don't have) plus admin-only revert. Append-only by design:
-- nothing ever UPDATEs or DELETEs a log row except revert_activity_log_entry() flipping the two
-- reverted_* marker columns on the ONE row being reverted — the log itself never rewrites history,
-- reverting instead writes a brand-new row (action='revert') so the revert itself is logged too,
-- and can itself be reverted (undo of an undo), which the client surfaces as "Redo".
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

create table public.activity_log (
  id bigint generated always as identity primary key,
  warehouse_id text not null references public.warehouses(l),
  user_id uuid references auth.users(id),
  action text not null check (action in ('create', 'update', 'delete', 'revert')),
  entity_type text not null default 'item',
  entity_id text not null,
  before_data jsonb,
  after_data jsonb,
  summary text not null,
  revert_of_id bigint references public.activity_log(id),
  reverted_at timestamptz,
  reverted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index idx_activity_log_warehouse on public.activity_log (warehouse_id, created_at desc);

alter table public.activity_log enable row level security;

-- Same visibility as items themselves: your own warehouse (home role or a per-warehouse grant), or
-- admin sees everything. Not gating to admin-only for read — anyone who can see an item should be
-- able to see its history.
create policy p_activity_log_select on public.activity_log for select to authenticated using (
  warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  or (select role from public.profiles where id = auth.uid()) = 'admin'
  or exists (select 1 from public.warehouse_permissions wp where wp.user_id = auth.uid() and wp.warehouse_id = activity_log.warehouse_id)
);

-- Anyone who can write items can log that they did — same role bar as the items write policies
-- (editor/maintainer/admin, globally or via a per-warehouse grant).
create policy p_activity_log_insert on public.activity_log for insert to authenticated with check (
  (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer', 'admin')
  or exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = activity_log.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
  )
);

-- Deliberately no update/delete policy for clients — the two marker columns only ever change
-- through revert_activity_log_entry() below (security definer, admin-gated), never a raw client
-- UPDATE, so the log can't be quietly edited after the fact from devtools.

grant select, insert on public.activity_log to authenticated;

-- Reverts one log entry: restores the item to before_data (a 'create' entry has no before_data,
-- so reverting it deletes the item instead; a 'delete' entry has no after_data, so reverting it
-- re-inserts from before_data). Admin only, security definer so it can write items regardless of
-- who currently owns the write grant on that specific warehouse. Always writes a new 'revert' log
-- row before marking the original reverted, so a failed/partial revert still leaves a trail.
create or replace function public.revert_activity_log_entry(p_log_id bigint)
returns void language plpgsql security definer as $$
declare
  entry public.activity_log%rowtype;
  current_row jsonb;
  restore_to jsonb;
begin
  if (select role from public.profiles where id = auth.uid()) != 'admin' then
    raise exception 'not authorized';
  end if;

  select * into entry from public.activity_log where id = p_log_id;
  if not found then raise exception 'log entry not found'; end if;
  if entry.reverted_at is not null then raise exception 'already reverted'; end if;

  select to_jsonb(i) into current_row from public.items i where i.btk = entry.entity_id;
  restore_to := entry.before_data;

  if restore_to is null then
    -- Reverting a 'create' (or a 'revert' whose own before_data was null) — the item shouldn't exist.
    delete from public.items where btk = entry.entity_id;
  elsif current_row is null then
    -- Reverting a 'delete' — the item is gone, re-insert it from the snapshot.
    insert into public.items select * from jsonb_populate_record(null::public.items, restore_to);
  else
    -- Reverting an 'update' — restore every column from the snapshot except identity/warehouse.
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
      comments = restore_to->>'comments'
    where btk = entry.entity_id;
  end if;

  insert into public.activity_log (warehouse_id, user_id, action, entity_type, entity_id, before_data, after_data, summary, revert_of_id)
  values (entry.warehouse_id, auth.uid(), 'revert', entry.entity_type, entry.entity_id, current_row, restore_to,
          'Reverted: ' || entry.summary, entry.id);

  update public.activity_log set reverted_at = now(), reverted_by = auth.uid() where id = p_log_id;
end; $$;
grant execute on function public.revert_activity_log_entry to authenticated;
