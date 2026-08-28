-- Extends warehouse metadata (phone, contact email — name/address already existed) and adds
-- optional structures for the bin-location grid view in item detail:
--
-- 1. `warehouse_zones` — an explicit, optional bounding box per zone (highest aisle/rack/level/
--    bin number in use). If a warehouse has no rows here, the app auto-detects the same bounds by
--    scanning items.location_code instead — this table only exists to let you override that when
--    the real layout is bigger than what's currently stocked (e.g. an aisle exists but is empty
--    today), or to give a zone a human-friendly label.
-- 2. `warehouse_rack_images` — NOT used by the app yet. Schema-only preparation for a future
--    feature: a photo of each rack (taken along its aisle), later overlaid with a grid mapping
--    image regions to Level/Bin. `grid_overlay` is an open jsonb column for whatever calibration
--    data that overlay ends up needing — intentionally undefined until that feature is designed.
--
-- Run once in the Supabase SQL Editor, after schema_bin_location.sql.

alter table public.warehouses add column if not exists phone text;
alter table public.warehouses add column if not exists contact_email text;

-- warehouses only had a public-read policy before now — nothing could update it via the API.
create policy p_warehouses_update on public.warehouses for update to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);
grant update on public.warehouses to authenticated;

create table public.warehouse_zones (
  id bigint generated always as identity primary key,
  warehouse_id text not null references public.warehouses(l),
  zone text not null,              -- matches the Zone component of items.location_code, e.g. 'A'
  label text,                      -- optional human-friendly name, e.g. "Hydraulics section"
  max_aisle smallint,
  max_rack smallint,
  max_level smallint,
  max_bin smallint,
  unique (warehouse_id, zone)
);

alter table public.warehouse_zones enable row level security;

create policy p_warehouse_zones_select on public.warehouse_zones for select to authenticated using (
  warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  or (select role from public.profiles where id = auth.uid()) = 'admin'
);
create policy p_warehouse_zones_write on public.warehouse_zones for all to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
) with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);

grant select, insert, update, delete on public.warehouse_zones to authenticated;

-- Future feature (see header note) — not read or written by the app today.
create table public.warehouse_rack_images (
  id bigint generated always as identity primary key,
  warehouse_id text not null references public.warehouses(l),
  zone text not null,
  aisle smallint not null,
  rack smallint not null,
  image_url text not null,
  grid_overlay jsonb,
  created_at timestamptz default now(),
  unique (warehouse_id, zone, aisle, rack)
);

alter table public.warehouse_rack_images enable row level security;

create policy p_rack_images_select on public.warehouse_rack_images for select to authenticated using (
  warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  or (select role from public.profiles where id = auth.uid()) = 'admin'
);
create policy p_rack_images_write on public.warehouse_rack_images for all to authenticated using (
  (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
) with check (
  (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
);

grant select, insert, update, delete on public.warehouse_rack_images to authenticated;

insert into storage.buckets (id, name, public)
values ('rack-images', 'rack-images', true)
on conflict (id) do nothing;

create policy "Public read rack-images" on storage.objects for select
  using (bucket_id = 'rack-images');

create policy "Editors can upload rack-images" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'rack-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can update rack-images" on storage.objects for update to authenticated
  using (
    bucket_id = 'rack-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );

create policy "Editors can delete rack-images" on storage.objects for delete to authenticated
  using (
    bucket_id = 'rack-images'
    and (select role from public.profiles where id = auth.uid()) in ('editor', 'admin')
  );
