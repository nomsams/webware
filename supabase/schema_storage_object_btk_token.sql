-- item-images object paths are moving from deterministic `<btk>_full.jpg`/`<btk>_thumb.jpg` to
-- `<btk>_<token>_full.jpg`/`<btk>_<token>_thumb.jpg` (see index.html's uploadItemPhotoToSupabase) —
-- the item-images bucket is public, and a purely BTK-derived filename let anyone walk the
-- predictable BTK sequence and view every item's photo with zero credentials. storage_object_btk()
-- is what the "Editors can upload/update/delete item-images" policies (schema_bugfixes.sql) use to
-- recover the owning item's BTK from an object name for warehouse-scoping, so it has to learn the
-- new shape too, or every write to a tokenized filename gets rejected. The token segment is
-- optional in the pattern so already-uploaded, not-yet-replaced photos using the old untokenized
-- name keep resolving correctly.
--
-- Run once in the Supabase SQL Editor, after schema_bugfixes.sql.

create or replace function public.storage_object_btk(object_name text)
returns text language sql immutable as $$
  select regexp_replace(object_name, '(_[0-9a-f]{8,16})?_(full|thumb)\.jpg$', '')
$$;
