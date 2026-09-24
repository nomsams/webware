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
-- A few numbers are missing from the list on purpose, because they leave nothing separate to look for:
-- #12 (schema_location_code_v2.sql) and #16 (schema_bin_row.sql) each rewrote the items_location_code_format
-- constraint and #39 (schema_bin_code_format.sql) replaced it again, so #39's row answers for all three — if
-- it says "applied", the constraint is the current "A 3-3 1-1" pattern. #26 is superseded by #29 (same policy
-- rewritten) and #32 only changed function bodies.

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
  union all
  select 23, 'schema_llm_assistant.sql', 'llm_api_keys table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'llm_api_keys')
  union all
  select 24, 'schema_llm_assistant_key_list.sql', 'list_llm_api_keys() function',
    exists (select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'list_llm_api_keys')
  union all
  select 25, 'schema_orders_update_scope_fix.sql', 'p_orders_update also checks the warehouse',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'p_orders_update' and qual ilike '%warehouse_id%')
  union all
  -- #26 (bootstrap fix) is superseded by #29, which rewrites the same policy, so #29 is what is checked.
  select 27, 'schema_storage_object_btk_token.sql', 'storage_object_btk() reads tokenized file names',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'storage_object_btk' and pg_get_functiondef(p.oid) ilike '%(full|thumb)%' and pg_get_functiondef(p.oid) ilike '%0-9a-f%')
  union all
  select 28, 'schema_harden_search_path.sql', 'every SECURITY DEFINER function pins search_path',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prosecdef
                  and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')))
  union all
  select 29, 'schema_llm_assistant_grant_repair.sql', 'p_llm_api_keys_insert uses has_llm_api_key()',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'llm_api_keys' and policyname = 'p_llm_api_keys_insert' and with_check ilike '%has_llm_api_key%')
  union all
  select 30, 'schema_item_units.sql', 'items.unit_type column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'unit_type')
  union all
  select 31, 'schema_zone_shelf_dimensions.sql', 'warehouse_zones.shelf_width_cm column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouse_zones' and column_name = 'shelf_width_cm')
  union all
  -- #32 (email cast) changes a function body only; nothing separate to look for.
  select 33, 'schema_activity_log_batch_id.sql', 'activity_log.batch_id column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'activity_log' and column_name = 'batch_id')
  union all
  select 34, 'schema_item_images.sql', 'item_images table',
    exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'item_images')
  union all
  select 35, 'schema_item_link.sql', 'items.link column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'link')
  union all
  select 36, 'schema_zone_dimensions.sql', 'warehouse_zones.rack_width_cm column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouse_zones' and column_name = 'rack_width_cm')
  union all
  select 37, 'schema_grant_aware_policies.sql', '24 per-warehouse-grant policies (orders, kits, zones, rack photos, manufacturers, storage)',
    (select count(*) from pg_policies
      where policyname ilike '%grant%' and (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))) >= 24
  union all
  select 38, 'schema_editor_add_items.sql', 'items: grant delete = admin only, no FOR ALL grant policy',
    exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'items' and policyname = 'p_items_warehouse_permission_delete')
    and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'items' and policyname = 'p_items_warehouse_permission_write')
  union all
  -- #39 also stands in for #12 and #16: it replaces the same constraint, so the current definition is the answer.
  select 39, 'schema_bin_code_format.sql', 'items_location_code_format is the "A 3-3 1-1" pattern',
    exists (select 1 from pg_constraint where conrelid = 'public.items'::regclass and conname = 'items_location_code_format'
            and pg_get_constraintdef(oid) like '%[A-Z]{1,2} [0-9]{1,2}-[0-9]{1,2} [0-9]{1,2}-[0-9]{1,2}$%')
  union all
  select 40, 'schema_visma_sync.sql', 'items.visma_qty column + revert restores it',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'visma_qty')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'revert_activity_log_entry' and pg_get_functiondef(p.oid) ilike '%visma_qty%')
  union all
  select 41, 'schema_zone_rack_style.sql', 'warehouse_zones.rack_style column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouse_zones' and column_name = 'rack_style')
  union all
  select 42, 'schema_zone_grid_rotated.sql', 'warehouse_zones.grid_rotated column',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'warehouse_zones' and column_name = 'grid_rotated')
  union all
  -- Unlike a missing column/policy, a missing grant shows up nowhere in the app's own UI —
  -- has_llm_api_key()/Settings are SECURITY DEFINER and never subject to it, so they report a key
  -- exists right up until the Edge Function's own read of it fails with "permission denied".
  select 43, 'schema_llm_assistant_service_role_select.sql', 'service_role can select llm_api_keys',
    exists (select 1 from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'llm_api_keys' and grantee = 'service_role' and privilege_type = 'SELECT')
) t
order by t.n;
