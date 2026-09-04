-- Up to 5 photos per item instead of exactly 1: replaces items.image_full_url/image_thumb_url
-- (still read by already-loaded rows until the app's own migration step below runs) with a proper
-- one-item-to-many table. Only the item's designated MAIN photo carries a thumbnail (thumb_url) —
-- the others are full-resolution only, shown in a gallery but never used anywhere a small list-view
-- thumbnail is needed, so there's no point paying for a second compressed copy of each one.
--
-- RLS mirrors items' own policies (schema_maintainer_role.sql) rather than the simpler
-- profiles.role-only shape other satellite tables (orders, activity_log) use — a photo is
-- logically part of an item's own data, so whoever can edit an item's fields (including a
-- per-warehouse maintainer grant via warehouse_permissions, not just their global profiles.role)
-- should be able to manage its photos too, without a confusing RLS denial on that one action alone.
--
-- Run once in the Supabase SQL Editor, after schema_maintainer_role.sql.

create table public.item_images (
  id bigint generated always as identity primary key,
  btk text not null references public.items(btk) on delete cascade,
  warehouse_id text not null references public.warehouses(l),
  full_url text not null,
  thumb_url text,
  is_main boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_item_images_btk on public.item_images (btk);
-- At most one main photo per item, enforced here (not just client-side) so a race between two
-- near-simultaneous uploads/promotions can't leave two rows both claiming to be the main one.
create unique index idx_item_images_one_main_per_btk on public.item_images (btk) where is_main;

alter table public.item_images enable row level security;

create policy p_item_images_select on public.item_images for select to authenticated using (
  warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  or (select role from public.profiles where id = auth.uid()) = 'admin'
  or exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = item_images.warehouse_id
  )
);
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
  (
    warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer', 'admin')
  )
  or (select role from public.profiles where id = auth.uid()) = 'admin'
  or exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = item_images.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
  )
);

grant select, insert, update, delete on public.item_images to authenticated;

-- One-time backfill: an item that already had the old single image_full_url/image_thumb_url gets
-- exactly one item_images row for it, marked as the main photo, so nothing already uploaded is
-- orphaned by this migration. Safe to re-run (only inserts for a btk with zero rows so far).
insert into public.item_images (btk, warehouse_id, full_url, thumb_url, is_main, sort_order)
select i.btk, i.warehouse_id, i.image_full_url, i.image_thumb_url, true, 0
from public.items i
where i.image_full_url is not null
  and not exists (select 1 from public.item_images ii where ii.btk = i.btk);
