-- Manufacturers as a real entity (name, description, contact, email, logo) instead of a free-text
-- field on items — powers the manufacturer detail page and prevents spelling-variant duplicates
-- (the client also folds known transliterations like "HÄNY"/"haeny" before creating a new one).
--
-- Manufacturers are global, not warehouse-scoped (the same supplier can ship to multiple
-- warehouses), so RLS here is simpler than items/kits: any authenticated user can read all of
-- them, editor/admin can create/update, admin can delete.
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

create table public.manufacturers (
  id bigint generated always as identity primary key,
  name text not null unique,
  description text,
  contact_name text,
  email text,
  logo_url text,
  created_at timestamptz default now()
);

alter table public.items add column if not exists manufacturer_id bigint references public.manufacturers(id);

alter table public.manufacturers enable row level security;

create policy p_manufacturers_select on public.manufacturers for select to authenticated using (true);
create policy p_manufacturers_insert on public.manufacturers for insert to authenticated
  with check ((select role from public.profiles where id = auth.uid()) in ('editor', 'admin'));
create policy p_manufacturers_update on public.manufacturers for update to authenticated
  using ((select role from public.profiles where id = auth.uid()) in ('editor', 'admin'));
create policy p_manufacturers_delete on public.manufacturers for delete to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'admin');

grant select, insert, update, delete on public.manufacturers to authenticated;

-- Logo storage — same pattern as item-images (supabase/schema_image_storage.sql).
insert into storage.buckets (id, name, public)
values ('manufacturer-logos', 'manufacturer-logos', true)
on conflict (id) do nothing;

create policy "Public read manufacturer-logos" on storage.objects for select
  using (bucket_id = 'manufacturer-logos');

create policy "Editors can upload manufacturer-logos" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'manufacturer-logos'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can update manufacturer-logos" on storage.objects for update to authenticated
  using (
    bucket_id = 'manufacturer-logos'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can delete manufacturer-logos" on storage.objects for delete to authenticated
  using (
    bucket_id = 'manufacturer-logos'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

-- Backfill: turn existing free-text items.manufacturer values into real manufacturer rows and
-- link items to them. Safe to re-run — "on conflict do nothing" skips names already present.
insert into public.manufacturers (name)
select distinct manufacturer from public.items
where manufacturer is not null and manufacturer <> '' and manufacturer <> 'None'
on conflict (name) do nothing;

update public.items i
set manufacturer_id = m.id
from public.manufacturers m
where i.manufacturer = m.name and i.manufacturer_id is null;
