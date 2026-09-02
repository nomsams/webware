-- p_llm_api_keys_insert's bootstrap clause ("...or not exists (select 1 where active)") let ANY
-- authenticated user — including the lowest-privilege viewer role, who can't write anything else
-- in this app — add the very first Groq key. That's inconsistent with the rest of the permission
-- model, where "can write" starts at editor. Tightens the bootstrap case to editor+ as well;
-- admins could always add keys (including backups) regardless, so that clause is unchanged.
--
-- Run once in the Supabase SQL Editor, after schema_llm_assistant.sql.

drop policy if exists p_llm_api_keys_insert on public.llm_api_keys;
create policy p_llm_api_keys_insert on public.llm_api_keys for insert to authenticated with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or (
    (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer')
    and not exists (select 1 from public.llm_api_keys where active)
  )
);
