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
-- Run once in the Supabase SQL Editor, after every migration that defines these functions.

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
