-- Editors and maintainers can ADD and UPDATE items in their warehouse; only admins can DELETE them.
--
-- Until now the two kinds of "editor" disagreed:
--   * a profile-role editor (profiles.role = 'editor', in their home warehouse) could UPDATE items but not
--     add any - p_items_insert was admin-only - so "Add item", Duplicate and a CSV import's new rows were
--     refused for them;
--   * an editor/maintainer GRANT (warehouse_permissions) had one FOR ALL policy, so it could add, update
--     AND delete items in that warehouse - a maintainer could wipe a warehouse.
-- Now they agree:
--
--                                add    update   delete
--     viewer / viewer grant       no      no       no
--     editor (home warehouse)     yes     yes      no
--     editor grant                yes     yes      no
--     maintainer grant            yes     yes      no
--     admin (profile role)        yes     yes      yes    (every warehouse)
--     admin grant                 yes     yes      yes    (that warehouse only)
--
-- Also tightens the old p_items_update, whose WITH CHECK was (true): nothing in that policy stopped an
-- UPDATE from changing items.warehouse_id and moving a row out of the editor's own warehouse - a delete in
-- all but name, since items.btk is the primary key on its own. (An UPDATE with a WHERE clause or RETURNING,
-- which is every one the app sends, happens to be stopped anyway, because Postgres then also applies the
-- SELECT policies to the new row - but an UPDATE with neither is not.) The new-row check now has the same
-- scope as the old-row check. It matters for the grant policies too: Postgres ORs the WITH CHECKs of
-- permissive policies, so a leftover (true) made every grant policy's own WITH CHECK meaningless.
--
-- What is NOT changed: the undo/revert RPC (revert_activity_log_entry) is still admin-only, so an editor
-- cannot delete items by "undoing" an import either; item photos (item_images) and manufacturers keep
-- their existing rules.
--
-- The client (canEditItems / canDeleteItems in index.html) mirrors this table.
--
-- Safe to run more than once (drop-if-exists, then create). Run once in the Supabase SQL Editor, after
-- schema_maintainer_role.sql (which now creates the split grant policies below directly; this file also
-- converts a database that still has its older single FOR ALL grant policy).

begin;

-- ── profile-role policies (viewer / editor / admin, home warehouse = profiles.warehouse_id) ──────────
drop policy if exists p_items_insert on public.items;
create policy p_items_insert on public.items for insert to authenticated with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or (
    (select role from public.profiles where id = auth.uid()) = 'editor'
    and warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  )
);

drop policy if exists p_items_update on public.items;
create policy p_items_update on public.items for update to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or (
    (select role from public.profiles where id = auth.uid()) = 'editor'
    and warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  )
) with check (
  -- the row may not be moved to a warehouse the caller could not have edited it in
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or (
    (select role from public.profiles where id = auth.uid()) = 'editor'
    and warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  )
);

-- p_items_delete (admin profile role only) and the SELECT policies stay exactly as they are.

-- ── per-warehouse grants (warehouse_permissions) ─────────────────────────────────────────────────────
-- Replaces the single FOR ALL policy, which also let editor/maintainer grants delete.
drop policy if exists p_items_warehouse_permission_write on public.items;

drop policy if exists p_items_warehouse_permission_insert on public.items;
create policy p_items_warehouse_permission_insert on public.items for insert to authenticated with check (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id
      and wp.role in ('editor', 'maintainer', 'admin')
  )
);

drop policy if exists p_items_warehouse_permission_update on public.items;
create policy p_items_warehouse_permission_update on public.items for update to authenticated using (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id
      and wp.role in ('editor', 'maintainer', 'admin')
  )
) with check (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id
      and wp.role in ('editor', 'maintainer', 'admin')
  )
);

drop policy if exists p_items_warehouse_permission_delete on public.items;
create policy p_items_warehouse_permission_delete on public.items for delete to authenticated using (
  exists (
    select 1 from public.warehouse_permissions wp
    where wp.user_id = auth.uid() and wp.warehouse_id = items.warehouse_id and wp.role = 'admin'
  )
);

commit;
