-- Moves item photos from the "download + manually drop into assets/" convention to Supabase
-- Storage: one full-size (compressed) image + one thumbnail per item, both public-read so the
-- app can display them with a plain <img src>, with writes restricted to editor/admin.
--
-- Run once in the Supabase SQL Editor, after the original schema + kits migrations.

alter table public.items add column if not exists image_full_url text;
alter table public.items add column if not exists image_thumb_url text;

-- do update (not do nothing) — a bucket created by hand via the dashboard before this ever ran
-- defaults to private, and `do nothing` would leave it that way forever even though every upload
-- afterward would still "succeed" and still produce a public URL that just never actually loads
-- (see schema_image_storage_fix_bucket_public.sql for the standalone fix if you're hitting this
-- on an already-provisioned project).
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do update set public = true;

create policy "Public read item-images" on storage.objects for select
  using (bucket_id = 'item-images');

create policy "Editors can upload item-images" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'item-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can update item-images" on storage.objects for update to authenticated
  using (
    bucket_id = 'item-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can delete item-images" on storage.objects for delete to authenticated
  using (
    bucket_id = 'item-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );
