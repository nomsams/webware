-- Backing store for the AI assistant's Groq API key(s) — shared across everyone using this
-- warehouse's Supabase project, with backups (the edge function tries them in order, falling
-- through on a rate limit/auth failure), and a Settings UI to add one if none is configured yet.
--
-- Security shape: there is NO select policy on this table at all — RLS default-denies every client
-- read, admin included. The only way anything ever learns about a key's existence is
-- has_llm_api_key() below, which returns a boolean and nothing else. The actual key value is only
-- ever read by the Edge Function (supabase/functions/llm-assistant), which authenticates to
-- Postgres with the service-role key — a credential that bypasses RLS entirely and never reaches
-- the browser. This is the part that makes "stored in a database" actually safe: the database
-- itself refuses to hand the key to any client-side query, so where it's stored doesn't matter as
-- much as the fact that no client-facing path can ever read it.
--
-- Run once in the Supabase SQL Editor.

create table public.llm_api_keys (
  id bigint generated always as identity primary key,
  provider text not null default 'groq',
  label text,
  api_key text not null,
  active boolean not null default true,
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.llm_api_keys enable row level security;

-- Insert: an admin can always add a (backup) key. A non-admin can only add one when the pool is
-- currently empty — bootstraps the feature for a warehouse with no admin available right this
-- second, without leaving it permanently open for anyone to add keys once one already exists.
create policy p_llm_api_keys_insert on public.llm_api_keys for insert to authenticated with check (
  (select role from public.profiles where id = auth.uid()) = 'admin'
  or not exists (select 1 from public.llm_api_keys where active)
);
create policy p_llm_api_keys_delete on public.llm_api_keys for delete to authenticated using (
  (select role from public.profiles where id = auth.uid()) = 'admin'
);
grant insert, delete on public.llm_api_keys to authenticated;

create or replace function public.has_llm_api_key()
returns boolean language sql security definer as $$
  select exists (select 1 from public.llm_api_keys where active);
$$;
grant execute on function public.has_llm_api_key to authenticated;

create or replace function public.count_llm_api_keys()
returns integer language sql security definer as $$
  select count(*)::integer from public.llm_api_keys where active;
$$;
grant execute on function public.count_llm_api_keys to authenticated;
