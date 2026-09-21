-- None of this project's SECURITY DEFINER functions set search_path explicitly, which Postgres
-- (and Supabase's own linter) flags as a hardening gap: a SECURITY DEFINER function resolves
-- unqualified names against the CALLER's search_path unless one is pinned, so if a caller could
-- ever get an object earlier in their own search_path than where the real one lives, the function
-- could silently operate on the wrong object with the function owner's elevated privileges. Every
-- function below already schema-qualifies its own references (public.items, public.profiles, etc.)
-- which is the main practical mitigation, and Supabase's `authenticated`/`anon` roles don't get
-- CREATE on `public` by default — so this is defense-in-depth, not a fix for a demonstrated
-- exploit here, but it's a one-line pin per function and the linter is right to ask for it.
--
-- adjust_item_stock() is NOT listed here on purpose — it's deliberately not SECURITY DEFINER (runs
-- as the caller, so normal items RLS still applies), so it has nothing to pin.
--
-- CREATE OR REPLACE FUNCTION resets a function's settings, so a migration that recreates one of these
-- has to pin it again itself (schema_maintainer_role.sql and schema_fix_email_type_mismatch.sql now do);
-- re-running this file is always safe and puts every pin back. set_updated_meta() (the trigger that stamps
-- updated_at/updated_by) was missing from the first version of this list.
--
-- Run once in the Supabase SQL Editor, after every migration that defines these functions.

alter function public.set_updated_meta() set search_path = public, pg_temp;
alter function public.has_llm_api_key() set search_path = public, pg_temp;
alter function public.count_llm_api_keys() set search_path = public, pg_temp;
alter function public.list_llm_api_keys() set search_path = public, pg_temp;
alter function public.revert_activity_log_entry(bigint) set search_path = public, pg_temp;
alter function public.set_warehouse_permission(uuid, text, text) set search_path = public, pg_temp;
alter function public.revoke_warehouse_permission(uuid, text) set search_path = public, pg_temp;
alter function public.list_warehouse_permissions() set search_path = public, pg_temp;
alter function public.list_profiles_with_email() set search_path = public, pg_temp;
alter function public.update_user_role(uuid, text) set search_path = public, pg_temp;
alter function public.get_display_name(uuid) set search_path = public, pg_temp;
