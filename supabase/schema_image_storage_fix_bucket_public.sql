-- Fixes "images uploaded fine but never display": schema_image_storage.sql's bucket creation
-- used `on conflict (id) do nothing`, so if the `item-images` bucket already existed in the
-- project before that migration ran (e.g. created by hand via the Supabase dashboard, which
-- defaults new buckets to PRIVATE) it silently never got flipped to public=true. Uploads still
-- succeed (that's covered by the insert policy) and a well-formed public URL still gets saved to
-- items.image_full_url/image_thumb_url, but a private bucket rejects the plain, unauthenticated
-- <img src> fetch the app relies on to actually display it — no error toast, just a broken image
-- icon (or, before that was made visible, nothing at all).
--
-- getPublicUrl()'s /object/public/... endpoint checks the bucket's own `public` flag directly and
-- does NOT consult storage.objects RLS policies at all, so the "Public read item-images" policy
-- from schema_image_storage.sql being correct doesn't help if the bucket itself isn't public.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.

update storage.buckets set public = true where id = 'item-images';

-- Confirms the fix: should return exactly one row with public = true.
select id, public from storage.buckets where id = 'item-images';
