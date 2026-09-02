-- Repairs "permission denied for table llm_api_keys" on insert, reported even when signed in as
-- admin. Two separate issues, both fixed here:
--
-- 1. The base GRANT (schema_llm_assistant.sql's `grant insert, delete ... to authenticated`)
--    apparently never landed (or was lost) in this project — that's a hard, role-independent
--    privilege check Postgres runs BEFORE row-level security policies are even consulted, which is
--    exactly why it happened for an admin too. GRANT is idempotent, so re-asserting it here is a
--    safe, direct fix no matter how it went missing.
--
-- 2. The insert policy's bootstrap clause read llm_api_keys via a raw subquery
--    (`not exists (select 1 from llm_api_keys where active)`) to check whether a key already
--    exists — but nothing was ever granted SELECT on this table (deliberately, so no client can
--    ever read a key back). That subquery needs its own SELECT privilege to run at all, which
--    doesn't exist, and even if it did, RLS (no select *policy* exists) would silently filter it to
--    zero rows regardless of the real data — making "not exists" always true and quietly breaking
--    the "only when no active key exists" gate rather than erroring. Using has_llm_api_key()
--    (SECURITY DEFINER, already built for exactly this — see schema_llm_assistant.sql) sidesteps
--    both problems: it needs no grant on the base table, and isn't subject to RLS, so it answers
--    correctly. No SELECT grant is added — none is needed anymore.
--
-- Run once in the Supabase SQL Editor, after schema_llm_assistant_bootstrap_fix.sql.

grant insert, delete on public.llm_api_keys to authenticated;

drop policy if exists p_llm_api_keys_insert on public.llm_api_keys;
create policy p_llm_api_keys_insert on public.llm_api_keys for insert to authenticated with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or (
    (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer')
    and not public.has_llm_api_key()
  )
);
