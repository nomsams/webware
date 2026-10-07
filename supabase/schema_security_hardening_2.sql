-- SECURITY HARDENING, round 2 — run once in the Supabase SQL Editor (or `npx supabase db query --linked --file …`), after
-- schema_security_hardening.sql. Idempotent: every statement is drop-if-exists / create-or-replace / revoke, so re-running is safe.
--
-- Found by auditing the LIVE project (not just the repo files) after the first hardening round:
--
--  1. Anyone with the public anon key could LIST the photo buckets. The storage policies were "Public read <bucket> ... TO public",
--     and a SELECT policy on storage.objects is what lets /storage/v1/object/list answer. Item photo file names carry an
--     unguessable token on purpose (schema_storage_object_btk_token.sql: the bucket is public, so a BTK-derived name would let anyone
--     walk every photo) — listing hands that token over, so the protection was void. Public buckets serve /object/public/<path>
--     without any policy at all, so the <img> URLs keep working; only the app's own signed-in listing/upsert need SELECT, and they
--     get it as `authenticated`.
--  2. Rack photos were not scoped to a warehouse for editors who hold their role through profiles (the usual case): the table policy
--     and the storage policies only asked "is an editor", so an editor in one warehouse could add, replace or delete another
--     warehouse's rack pictures. Scoped to the caller's home warehouse (the table row's warehouse_id / the object's first path
--     segment, which is how rack photos are named: "<warehouseId>/<zone>-…jpg"); admins stay unrestricted. (Per-warehouse GRANT
--     holders were already scoped by schema_grant_aware_policies.sql.)
--  3. `authenticated` still held TRUNCATE, REFERENCES and TRIGGER on every table. Row Level Security does NOT apply to TRUNCATE
--     (one statement empties a table), and the API does not expose it, but a privilege nobody uses should not exist. Revoked.
--  4. adjust_item_stock() and storage_object_btk() had no pinned search_path.
--  5. profiles.display_name is shown to every colleague (and in Last-updated-by lines): capped at 60 characters (NOT VALID — existing
--     rows are never rejected).
--  6. public.keepalive(): the project's GitHub Actions keep-alive used the SERVICE-ROLE key (full database access, bypasses RLS) as a
--     repository secret just to read one row. This is a harmless function the anon key may call instead — the workflow now uses it,
--     and you can DELETE the SUPABASE_SERVICE_ROLE_KEY secret from the repository (Settings -> Secrets and variables -> Actions).
--     Also consider rotating that key (Supabase dashboard -> Project Settings -> API) since it has lived in a CI secret.
--
-- schema_audit.sql rows #51-#52 check the two most important parts.

begin;

-- ── 3. unused table privileges ─────────────────────────────────────────────────────────────────────────────────────
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t.tablename);
    execute format('revoke all on public.%I from anon', t.tablename);
  end loop;
end $$;

-- ── 1. storage: no anonymous listing ───────────────────────────────────────────────────────────────────────────────
do $$
declare b text;
begin
  foreach b in array array['item-images', 'manufacturer-logos', 'rack-images'] loop
    execute format('drop policy if exists %I on storage.objects', 'Public read ' || b);
    execute format('drop policy if exists %I on storage.objects', 'Signed-in read ' || b);
    execute format('create policy %I on storage.objects for select to authenticated using (bucket_id = %L)', 'Signed-in read ' || b, b);
  end loop;
exception when insufficient_privilege or undefined_table then raise notice 'storage policies skipped: %', sqlerrm;
end $$;

-- ── 2. rack photos: an editor writes only their own warehouse's ────────────────────────────────────────────────────
do $$ begin
  drop policy if exists p_rack_images_write on public.warehouse_rack_images;
  create policy p_rack_images_write on public.warehouse_rack_images for all to authenticated using (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = warehouse_rack_images.warehouse_id)))
  ) with check (
    exists (select 1 from public.profiles p where p.id = auth.uid()
            and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = warehouse_rack_images.warehouse_id)))
  );
exception when undefined_table or undefined_column then raise notice 'rack table policy skipped: %', sqlerrm;
end $$;

do $$ begin
  drop policy if exists "Editors can upload rack-images" on storage.objects;
  create policy "Editors can upload rack-images" on storage.objects for insert to authenticated with check (
    bucket_id = 'rack-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid()
                and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = split_part(storage.objects.name, '/', 1))))
  );
  drop policy if exists "Editors can update rack-images" on storage.objects;
  create policy "Editors can update rack-images" on storage.objects for update to authenticated using (
    bucket_id = 'rack-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid()
                and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = split_part(storage.objects.name, '/', 1))))
  );
  drop policy if exists "Editors can delete rack-images" on storage.objects;
  create policy "Editors can delete rack-images" on storage.objects for delete to authenticated using (
    bucket_id = 'rack-images'
    and exists (select 1 from public.profiles p where p.id = auth.uid()
                and (p.role = 'admin' or (p.role = 'editor' and p.warehouse_id = split_part(storage.objects.name, '/', 1))))
  );
exception when insufficient_privilege or undefined_table then raise notice 'rack storage policies skipped: %', sqlerrm;
end $$;

-- ── 4. search_path pins ────────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  alter function public.adjust_item_stock(text, integer) set search_path = public, pg_temp;
  alter function public.storage_object_btk(text) set search_path = pg_catalog, public;
exception when undefined_function then raise notice 'search_path pin skipped: %', sqlerrm;
end $$;

-- ── 5. display name length ─────────────────────────────────────────────────────────────────────────────────────────
do $$ begin
  alter table public.profiles drop constraint if exists profiles_display_name_len;
  alter table public.profiles add constraint profiles_display_name_len check (char_length(coalesce(display_name, '')) <= 60) not valid;
exception when undefined_table or undefined_column then raise notice 'display_name limit skipped: %', sqlerrm;
end $$;

-- ── 6. a harmless, anon-callable keep-alive (see the header) ───────────────────────────────────────────────────────
create or replace function public.keepalive()
returns timestamptz language sql stable set search_path = pg_catalog as $$ select now(); $$;
revoke execute on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;

commit;
