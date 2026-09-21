-- Two-way stock sync with Visma: remembers, per item, what VISMA held the last time the two were in
-- step. That one number is what makes a safe update possible at all.
--
--     items.numberofitems   what webware holds now          (W)
--     items.visma_qty       what Visma held at the last sync (B)   <- added here
--     the article in Visma  what Visma holds now            (V)   <- only the add-on can read this
--
--   W = B                 nothing to send
--   W != B and V = B      safe: nobody touched Visma, write W
--   W != B and V != B     someone sold or received in Visma since the last sync - flag it for a
--                         person instead of overwriting their change
--   W = B  and V != B     Visma moved on its own - offer to pull V in
--
-- visma_qty is written ONLY by a sync (the export/audit round trip through the VismaScrap add-on, or
-- a scraped article list), never by an ordinary edit - that is exactly what makes an edit show up as
-- "pending". numeric, not integer: Visma keeps fractional stock for kg/metre articles.
--
-- Both columns are nullable and default to null, meaning "never synced". The Visma importer fills
-- them in for a fresh import (it knows Visma's own ant_i_lager for every row it creates), so after
-- one run only hand-added items start out unsynced.
--
-- No RLS changes: these are ordinary columns on items and are covered by its existing policies (an
-- editor may update them in their own warehouse, see schema_editor_add_items.sql). No index either -
-- the sync panel reads the warehouse's items that the app has already loaded.
--
-- Safe to run more than once. Run once in the Supabase SQL Editor, after schema_bin_code_format.sql.

begin;

alter table public.items add column if not exists visma_qty numeric;
alter table public.items add column if not exists visma_synced_at timestamptz;

comment on column public.items.visma_qty is
  'What Visma held for this article at the last sync. Written only by a Visma sync, never by an ordinary edit, so numberofitems <> visma_qty means "waiting to be pushed to Visma". Null = never synced.';
comment on column public.items.visma_synced_at is
  'When visma_qty was last confirmed against Visma.';

-- Undo has to put the baseline back too. revert_activity_log_entry() restores an updated item column
-- by column from the snapshot (it cannot use the whole row, since identity/warehouse must not move),
-- so the two new columns have to be named there or an undone sync would leave the item holding its
-- old quantity against the NEW baseline - reporting a difference that does not exist. This is the
-- same body as schema_activity_log.sql's, plus those two lines and the search_path pin from
-- schema_harden_search_path.sql (CREATE OR REPLACE resets a function's settings).
create or replace function public.revert_activity_log_entry(p_log_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
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
    -- Reverting a 'create' (or a 'revert' whose own before_data was null) - the item shouldn't exist.
    delete from public.items where btk = entry.entity_id;
  elsif current_row is null then
    -- Reverting a 'delete' - the item is gone, re-insert it from the snapshot.
    insert into public.items select * from jsonb_populate_record(null::public.items, restore_to);
  else
    -- Reverting an 'update' - restore every column from the snapshot except identity/warehouse.
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
      -- Only when the snapshot actually carries the key. Every other write path leaves the baseline
      -- alone and so does not put it in its snapshots (itemToSupabaseRow in index.html); restoring
      -- it unconditionally would read a missing key as null and WIPE a baseline that this edit never
      -- touched - including for every entry written before this migration.
      visma_qty = case when restore_to ? 'visma_qty' then (restore_to->>'visma_qty')::numeric else items.visma_qty end,
      visma_synced_at = case when restore_to ? 'visma_synced_at' then (restore_to->>'visma_synced_at')::timestamptz else items.visma_synced_at end
    where btk = entry.entity_id;
  end if;

  insert into public.activity_log (warehouse_id, user_id, action, entity_type, entity_id, before_data, after_data, summary, revert_of_id)
  values (entry.warehouse_id, auth.uid(), 'revert', entry.entity_type, entry.entity_id, current_row, restore_to,
          'Reverted: ' || entry.summary, entry.id);

  update public.activity_log set reverted_at = now(), reverted_by = auth.uid() where id = p_log_id;
end; $$;

commit;
