-- Adds an admin-only way to see WHICH keys exist (label + when added) without ever exposing a raw
-- value — has_llm_api_key()/count_llm_api_keys() (schema_llm_assistant.sql) only ever answered
-- "is one configured" / "how many", which isn't enough for an admin trying to tell two backup keys
-- apart or remove a broken one. Still SECURITY DEFINER (bypasses RLS to read the table at all), but
-- gates every row on the caller actually being an admin — a non-admin gets an empty set back, not
-- an error, same shape as any other unauthorized read in this app.
--
-- Run once in the Supabase SQL Editor, after schema_llm_assistant.sql.

create or replace function public.list_llm_api_keys()
returns table(id bigint, provider text, label text, active boolean, created_at timestamptz)
language sql security definer as $$
  select id, provider, label, active, created_at
  from public.llm_api_keys
  where (select role from public.profiles where id = auth.uid()) = 'admin'
  order by created_at asc;
$$;
grant execute on function public.list_llm_api_keys to authenticated;
