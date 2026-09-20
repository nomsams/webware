-- Makes per-warehouse grants (warehouse_permissions — see schema_maintainer_role.sql) count everywhere
-- the app already treats them as real, not just on items / item_images / activity_log.
--
-- The client computes an EFFECTIVE role per warehouse (computeEffectiveRole): someone who is a plain
-- viewer globally but holds an 'editor'/'maintainer'/'admin' grant in warehouse W is shown the edit
-- controls in W. Their items/photos/activity-log writes were allowed by the grant-aware policies from
-- the earlier migrations, but orders, kits, the zone layout, rack photos and manufacturers still
-- checked ONLY profiles.role / profiles.warehouse_id — so for a grant-holder the Pack Order save, the
-- kit screens, the Warehouse page and adding a manufacturer either showed nothing or failed with an
-- RLS error (and resolveManufacturer() quietly fell back to saving the item with no manufacturer link).
-- schema_maintainer_role.sql listed exactly that as "extend later".
--
-- Additive on purpose: Postgres ORs permissive policies, so these can only ADD access, and only for
-- someone who has a row in warehouse_permissions — nobody's existing access changes, and while that
-- table is empty this migration changes nothing at all. The rules mirror the existing profile-based ones:
--   read     any grant in that warehouse (viewer and up)
--   write    'editor' / 'maintainer' / 'admin' grant — orders, kit rows, rack photos
--   delete   'admin' grant only (orders, kits) — same as the global rule, which is admin-only
--   layout   'admin' grant only (warehouse_zones) — the Layout Designer is admin-only for everyone
-- manufacturers are global (not per warehouse), so creating/editing one needs an editor+ grant in ANY
-- warehouse; deleting one stays global-admin-only. Storage: manufacturer-logos likewise; rack-images is
-- scoped by its "<warehouseId>/…" path prefix to the warehouse the grant is for.
--
-- Safe to run more than once (drop-if-exists, then create). Run once in the Supabase SQL Editor, after
-- schema_maintainer_role.sql and schema_warehouse_layout.sql.

begin;

-- ── orders ──────────────────────────────────────────────────────────────────────────────────────
drop policy if exists p_orders_grant_select on public.orders;
create policy p_orders_grant_select on public.orders for select to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = orders.warehouse_id)
);
drop policy if exists p_orders_grant_insert on public.orders;
create policy p_orders_grant_insert on public.orders for insert to authenticated with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = orders.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_orders_grant_update on public.orders;
create policy p_orders_grant_update on public.orders for update to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = orders.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
) with check (
  -- the row may not be moved to a warehouse the grant doesn't cover
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = orders.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_orders_grant_delete on public.orders;
create policy p_orders_grant_delete on public.orders for delete to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = orders.warehouse_id and wp.role = 'admin')
);

-- ── kits ────────────────────────────────────────────────────────────────────────────────────────
drop policy if exists p_kits_grant_select on public.kits;
create policy p_kits_grant_select on public.kits for select to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = kits.warehouse_id)
);
drop policy if exists p_kits_grant_insert on public.kits;
create policy p_kits_grant_insert on public.kits for insert to authenticated with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = kits.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_kits_grant_update on public.kits;
create policy p_kits_grant_update on public.kits for update to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = kits.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
) with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = kits.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_kits_grant_delete on public.kits;
create policy p_kits_grant_delete on public.kits for delete to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = kits.warehouse_id and wp.role = 'admin')
);

-- ── kit_items (no warehouse_id of its own — the kit it belongs to has one) ─────────────────────────
drop policy if exists p_kit_items_grant_select on public.kit_items;
create policy p_kit_items_grant_select on public.kit_items for select to authenticated using (
  exists (select 1 from public.kits k
          join public.warehouse_permissions wp on wp.warehouse_id = k.warehouse_id
          where k.id = kit_items.kit_id and wp.user_id = auth.uid())
);
drop policy if exists p_kit_items_grant_insert on public.kit_items;
create policy p_kit_items_grant_insert on public.kit_items for insert to authenticated with check (
  exists (select 1 from public.kits k
          join public.warehouse_permissions wp on wp.warehouse_id = k.warehouse_id
          where k.id = kit_items.kit_id and wp.user_id = auth.uid()
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_kit_items_grant_update on public.kit_items;
create policy p_kit_items_grant_update on public.kit_items for update to authenticated using (
  exists (select 1 from public.kits k
          join public.warehouse_permissions wp on wp.warehouse_id = k.warehouse_id
          where k.id = kit_items.kit_id and wp.user_id = auth.uid()
            and wp.role in ('editor', 'maintainer', 'admin'))
) with check (
  exists (select 1 from public.kits k
          join public.warehouse_permissions wp on wp.warehouse_id = k.warehouse_id
          where k.id = kit_items.kit_id and wp.user_id = auth.uid()
            and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_kit_items_grant_delete on public.kit_items;
create policy p_kit_items_grant_delete on public.kit_items for delete to authenticated using (
  exists (select 1 from public.kits k
          join public.warehouse_permissions wp on wp.warehouse_id = k.warehouse_id
          where k.id = kit_items.kit_id and wp.user_id = auth.uid() and wp.role = 'admin')
);

-- ── warehouse_zones (the Layout Designer — admin-only for everyone, so an 'admin' grant) ────────────
drop policy if exists p_warehouse_zones_grant_select on public.warehouse_zones;
create policy p_warehouse_zones_grant_select on public.warehouse_zones for select to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_zones.warehouse_id)
);
drop policy if exists p_warehouse_zones_grant_write on public.warehouse_zones;
create policy p_warehouse_zones_grant_write on public.warehouse_zones for all to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_zones.warehouse_id and wp.role = 'admin')
) with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_zones.warehouse_id and wp.role = 'admin')
);

-- ── warehouse_rack_images ─────────────────────────────────────────────────────────────────────────
drop policy if exists p_rack_images_grant_select on public.warehouse_rack_images;
create policy p_rack_images_grant_select on public.warehouse_rack_images for select to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_rack_images.warehouse_id)
);
drop policy if exists p_rack_images_grant_write on public.warehouse_rack_images;
create policy p_rack_images_grant_write on public.warehouse_rack_images for all to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_rack_images.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
) with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.warehouse_id = warehouse_rack_images.warehouse_id
            and wp.role in ('editor', 'maintainer', 'admin'))
);

-- ── manufacturers (global: an editor+ grant in ANY warehouse; delete stays global-admin-only) ───────
drop policy if exists p_manufacturers_grant_insert on public.manufacturers;
create policy p_manufacturers_grant_insert on public.manufacturers for insert to authenticated with check (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin'))
);
drop policy if exists p_manufacturers_grant_update on public.manufacturers;
create policy p_manufacturers_grant_update on public.manufacturers for update to authenticated using (
  exists (select 1 from public.warehouse_permissions wp
          where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin'))
);

-- ── Storage ─────────────────────────────────────────────────────────────────────────────────────────
-- manufacturer-logos: same rule as manufacturers (global).
drop policy if exists "Grant editors can upload manufacturer-logos" on storage.objects;
create policy "Grant editors can upload manufacturer-logos" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'manufacturer-logos'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin'))
  );
drop policy if exists "Grant editors can update manufacturer-logos" on storage.objects;
create policy "Grant editors can update manufacturer-logos" on storage.objects for update to authenticated
  using (
    bucket_id = 'manufacturer-logos'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin'))
  );
drop policy if exists "Grant editors can delete manufacturer-logos" on storage.objects;
create policy "Grant editors can delete manufacturer-logos" on storage.objects for delete to authenticated
  using (
    bucket_id = 'manufacturer-logos'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin'))
  );

-- rack-images: objects are named "<warehouseId>/<zone>-<aisle>-<rack>-<token>.jpg", so the grant is
-- matched to the FIRST path segment — a grant for warehouse 5 writes under "5/", nowhere else.
drop policy if exists "Grant editors can upload rack-images" on storage.objects;
create policy "Grant editors can upload rack-images" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'rack-images'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin')
                  and wp.warehouse_id = split_part(storage.objects.name, '/', 1))
  );
drop policy if exists "Grant editors can update rack-images" on storage.objects;
create policy "Grant editors can update rack-images" on storage.objects for update to authenticated
  using (
    bucket_id = 'rack-images'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin')
                  and wp.warehouse_id = split_part(storage.objects.name, '/', 1))
  );
drop policy if exists "Grant editors can delete rack-images" on storage.objects;
create policy "Grant editors can delete rack-images" on storage.objects for delete to authenticated
  using (
    bucket_id = 'rack-images'
    and exists (select 1 from public.warehouse_permissions wp
                where wp.user_id = auth.uid() and wp.role in ('editor', 'maintainer', 'admin')
                  and wp.warehouse_id = split_part(storage.objects.name, '/', 1))
  );

commit;
