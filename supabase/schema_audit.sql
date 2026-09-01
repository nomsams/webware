-- Not a migration — a read-only diagnostic, safe to re-run any time. Shows which migrations have
-- actually been applied to THIS project, as a plain readable status column (rather than a raw
-- true/false boolean, which some SQL Editor result-grid views render as a checkbox/icon that's
-- easy to miss) — so a later migration failing because an earlier one was skipped (like
-- schema_bugfixes.sql needing schema_maintainer_role.sql's warehouse_permissions table) shows up
-- clearly instead of by trial and error.
--
-- Run it, then apply whichever migration files show "MISSING" below, in order (oldest # first —
-- a later one can depend on an earlier table/column existing).
--
-- Two migrations aren't included below because they don't add a new checkable object (they alter
-- an existing constraint's definition instead): #12 schema_location_code_v2.sql (tightens
-- items_location_code_format) and #16 schema_bin_row.sql (loosens the same constraint to accept
-- an optional -Row suffix). Check those separately, after everything else here says "applied":
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.items'::regclass and contype = 'c';
-- Should read: location_code IS NULL OR location_code ~ '^[A-Z]{1,2}[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}(-[0-9]{1,2})?$'
-- (or narrower) once both of those have run.

select
  t.n as "#",
  t.migration,
  t.object,
  case when t.found then 'applied' else 'MISSING - run this migration' end as status
from (
  select 2 as n, 'schema_kits.sql' as migration, 'kit_items table' as object,
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'kit_items') as found
  union all
  select 3, 'schema_image_storage.sql', 'items.image_full_url column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'image_full_url')
  union all
  select 4, 'schema_map_position.sql', 'items.map_position column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'map_position')
  union all
  select 5, 'schema_manufacturers.sql', 'manufacturers table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'manufacturers')
  union all
  select 6, 'schema_user_management.sql', 'list_profiles_with_email() function',
    exists (select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'list_profiles_with_email')
  union all
  select 7, 'schema_display_names.sql', 'profiles.display_name column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name')
  union all
  select 8, 'schema_orders.sql', 'orders table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'orders')
  union all
  select 9, 'schema_bin_location.sql', 'items.location_code column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'location_code')
  union all
  select 10, 'schema_warehouse_layout.sql', 'warehouse_zones table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'warehouse_zones')
  union all
  select 11, 'schema_warehouse_zone_position.sql', 'warehouse_zones.grid_col column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouse_zones' and column_name = 'grid_col')
  union all
  select 13, 'schema_inventering_history.sql', 'items.last_inventoried_at column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'last_inventoried_at')
  union all
  select 14, 'schema_admin_cross_warehouse_items.sql', 'p_items_admin_read_all policy',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'items' and policyname = 'p_items_admin_read_all')
  union all
  select 15, 'schema_maintainer_role.sql', 'warehouse_permissions table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'warehouse_permissions')
  union all
  select 17, 'schema_warehouse_insert.sql', 'p_warehouses_insert policy',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'warehouses' and policyname = 'p_warehouses_insert')
  union all
  select 18, 'schema_warehouse_remove_type.sql', 'warehouses.active column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouses' and column_name = 'active')
  union all
  select 19, 'schema_activity_log.sql', 'activity_log table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'activity_log')
  union all
  select 20, 'schema_bugfixes.sql', 'adjust_item_stock() function',
    exists (select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'adjust_item_stock')
  union all
  select 21, 'schema_reorder_threshold.sql', 'items.reorder_threshold column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'reorder_threshold')
  union all
  select 22, 'schema_orders_status.sql', 'orders.status column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'status')
) t
order by t.n;
