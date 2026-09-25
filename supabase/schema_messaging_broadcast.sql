-- Extends messages (schema_messaging.sql) with warehouse-wide broadcasts alongside the existing 1:1
-- direct messages — a message is either a DM (recipient_id set, warehouse_id null) or a broadcast
-- (warehouse_id set, recipient_id null), enforced below so a row is never both or neither. A single
-- messages.read_at column tracks a DM's one recipient's read state fine, but can't do the same for a
-- broadcast (many recipients, one row) — broadcasts get their own per-reader tracking table,
-- message_reads, instead.
--
-- Run once in the Supabase SQL Editor, after schema_messaging.sql.

alter table public.messages alter column recipient_id drop not null;
alter table public.messages add column if not exists warehouse_id text references public.warehouses(l);
alter table public.messages add constraint messages_recipient_xor_warehouse
  check ((recipient_id is not null and warehouse_id is null) or (recipient_id is null and warehouse_id is not null));

create table public.message_reads (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_reads enable row level security;
create policy p_message_reads_select on public.message_reads for select to authenticated using (user_id = auth.uid());
create policy p_message_reads_insert on public.message_reads for insert to authenticated with check (user_id = auth.uid());
grant select, insert on public.message_reads to authenticated;

-- Broadcast select: anyone with access to the warehouse (any grant, home warehouse, or admin) — same
-- shape as orders' own grant-aware policy (schema_grant_aware_policies.sql). Additive alongside
-- p_messages_select (schema_messaging.sql), which only ever matches sender_id/recipient_id and so
-- never applies to a warehouse_id-only broadcast row anyway.
create policy p_messages_select_broadcast on public.messages for select to authenticated using (
  warehouse_id is not null and (
    (select role from public.profiles where id = auth.uid()) = 'admin'
    or exists (select 1 from public.profiles where id = auth.uid() and warehouse_id = messages.warehouse_id)
    or exists (select 1 from public.warehouse_permissions where user_id = auth.uid() and warehouse_id = messages.warehouse_id)
  )
);
-- Broadcasting is editor+/admin only (same bar as creating a Pack Order) — not every viewer should
-- be able to message an entire warehouse at once. Additive alongside p_messages_insert, which
-- requires recipient_id and so never matches a broadcast row (recipient_id is null) anyway.
create policy p_messages_insert_broadcast on public.messages for insert to authenticated with check (
  warehouse_id is not null and sender_id = auth.uid() and (
    (select role from public.profiles where id = auth.uid()) in ('editor', 'maintainer', 'admin')
    or exists (select 1 from public.warehouse_permissions where user_id = auth.uid() and warehouse_id = messages.warehouse_id and role in ('editor', 'maintainer', 'admin'))
  )
);
