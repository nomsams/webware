-- Three unrelated fixes found during a code review, bundled into one migration since none of them
-- need their own explanation beyond what's here. Run once in the Supabase SQL Editor.

-- ─── Fix 1: kit insert policies required admin while the matching update policies allow editor
-- too — inconsistent, and would silently 403 an editor the moment kit create/edit gets a Supabase
-- UI (it doesn't have one yet, so this was never reachable, but it's wrong regardless).
alter policy p_kits_insert on public.kits
  with check ((select role from public.profiles where id = auth.uid()) in ('editor', 'admin'));
alter policy p_kit_items_insert on public.kit_items
  with check ((select role from public.profiles where id = auth.uid()) in ('editor', 'admin'));

-- ─── Fix 2: adjustStock() (the +/- stock stepper) read numberofitems client-side, computed
-- current+delta, then wrote that back — two people adjusting the same item within the same
-- round-trip window silently lose whichever write lands first. This RPC does the increment in one
-- atomic UPDATE instead, computed from whatever the row's real current value is at write time.
-- Not security definer — runs as the caller, so the normal items UPDATE RLS policy still applies
-- exactly as if the client had written the row directly.
create or replace function public.adjust_item_stock(p_btk text, p_delta integer)
returns integer language plpgsql as $$
declare new_qty integer;
begin
  update public.items set numberofitems = greatest(0, numberofitems + p_delta)
  where btk = p_btk
  returning numberofitems into new_qty;
  if new_qty is null then raise exception 'item not found, or not authorized to update it'; end if;
  return new_qty;
end; $$;
grant execute on function public.adjust_item_stock to authenticated;

-- ─── Fix 3: item-photo Storage policies (schema_image_storage.sql) checked only role, never which
-- warehouse the photo's item actually belongs to — any editor/admin anywhere could overwrite or
-- delete `<any-other-warehouse's-BTK>_full.jpg`/`_thumb.jpg` by guessing the filename (which is
-- just the public BTK). Re-scoped to the same "home warehouse, or a per-warehouse grant, or global
-- admin" shape items' own write policies already use.
create or replace function public.storage_object_btk(object_name text)
returns text language sql immutable as $$
  select regexp_replace(object_name, '_(full|thumb)\.jpg$', '')
$$;

drop policy if exists "Editors can upload item-images" on storage.objects;
drop policy if exists "Editors can update item-images" on storage.objects;
drop policy if exists "Editors can delete item-images" on storage.objects;

create policy "Editors can upload item-images" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and exists (
      select 1 from public.items i
      where i.btk = public.storage_object_btk(storage.objects.name)
        and (
          (select role from public.profiles where id = auth.uid()) = 'admin'
          or (
            i.warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
            and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer')
          )
          or exists (
            select 1 from public.warehouse_permissions wp
            where wp.user_id = auth.uid() and wp.warehouse_id = i.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
          )
        )
    )
  );
create policy "Editors can update item-images" on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and exists (
      select 1 from public.items i
      where i.btk = public.storage_object_btk(storage.objects.name)
        and (
          (select role from public.profiles where id = auth.uid()) = 'admin'
          or (
            i.warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
            and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer')
          )
          or exists (
            select 1 from public.warehouse_permissions wp
            where wp.user_id = auth.uid() and wp.warehouse_id = i.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
          )
        )
    )
  );
create policy "Editors can delete item-images" on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and exists (
      select 1 from public.items i
      where i.btk = public.storage_object_btk(storage.objects.name)
        and (
          (select role from public.profiles where id = auth.uid()) = 'admin'
          or (
            i.warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
            and (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer')
          )
          or exists (
            select 1 from public.warehouse_permissions wp
            where wp.user_id = auth.uid() and wp.warehouse_id = i.warehouse_id and wp.role in ('editor', 'maintainer', 'admin')
          )
        )
    )
  );
