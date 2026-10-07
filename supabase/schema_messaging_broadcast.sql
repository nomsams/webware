-- Extends messages (schema_messaging.sql) with warehouse-wide broadcasts alongside the existing 1:1
-- direct messages — a message is either a DM (recipient_id set, warehouse_id null) or a broadcast
-- (warehouse_id set, recipient_id null), enforced below so a row is never both or neither. A single
-- messages.read_at column tracks a DM's one recipient's read state fine, but can't do the same for a
-- broadcast (many recipients, one row) — broadcasts get their own per-reader tracking table,
-- message_reads, instead.
--
-- SECURITY FIX, both halves of this file already re-run-safe below: the first version shipped with
-- two real authorization gaps, caught in review before anyone reported abuse, but re-apply this
-- WHOLE file even if you already ran the original once — every statement here is idempotent
-- (drop-policy-if-exists / drop-then-add-constraint / create-table-if-not-exists) specifically so
-- this is safe to do.
--   1. p_messages_insert_broadcast's global-role branch checked ONLY `profiles.role in (...)`, with
--      no comparison against the target warehouse_id at all — unlike every other grant-aware policy
--      in this codebase (p_orders_insert in schema_orders.sql ANDs the role check with the caller's
--      own warehouse; this file's own SELECT policy two blocks down correctly ANDs
--      `warehouse_id = messages.warehouse_id`). That let ANY global editor/maintainer broadcast to
--      ANY warehouse in the deployment, not just their own — the client's own
--      broadcastableWarehouseIds() picker was the only thing stopping it in the UI, and a signed-in
--      editor calling supabase.from('messages').insert(...) directly (devtools, or any other client)
--      with an arbitrary warehouse_id bypassed it entirely. Fixed to require the caller's own home
--      warehouse (not just their global role) for the non-grant branch.
--   2. p_message_reads_insert checked only `user_id = auth.uid()`, never that message_id refers to a
--      broadcast the caller can actually see — letting anyone insert a "read" row for any guessed/
--      enumerated message_id (DMs between other people included), an unauthorized write and an
--      existence oracle over messages.id even though it never discloses message content. Fixed to
--      require the referenced row to actually be a broadcast the caller has warehouse access to,
--      via the same criteria p_messages_select_broadcast uses.
--
-- Run once in the Supabase SQL Editor, after schema_messaging.sql.

alter table public.messages alter column recipient_id drop not null;
alter table public.messages add column if not exists warehouse_id text references public.warehouses(l);
alter table public.messages drop constraint if exists messages_recipient_xor_warehouse;
alter table public.messages add constraint messages_recipient_xor_warehouse
  check ((recipient_id is not null and warehouse_id is null) or (recipient_id is null and warehouse_id is not null));

create table if not exists public.message_reads (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_reads enable row level security;

drop policy if exists p_message_reads_select on public.message_reads;
create policy p_message_reads_select on public.message_reads for select to authenticated using (user_id = auth.uid());

-- Checking only user_id = auth.uid() would let anyone insert a "read" row for ANY message_id they
-- can guess/enumerate (ids are small sequential bigints) — including a DM between two other people,
-- or a broadcast in a warehouse they have no access to. It never discloses that message's content
-- (message_reads carries no body), but it is an unauthorized write and an existence oracle over
-- messages.id, so this requires the referenced row to actually be a broadcast the caller can see,
-- via the same criteria p_messages_select_broadcast uses.
drop policy if exists p_message_reads_insert on public.message_reads;
create policy p_message_reads_insert on public.message_reads for insert to authenticated with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.messages m
    where m.id = message_reads.message_id
      and m.warehouse_id is not null
      and (
        (select role from public.profiles where id = auth.uid()) = 'admin'
        or exists (select 1 from public.profiles where id = auth.uid() and warehouse_id = m.warehouse_id)
        or exists (select 1 from public.warehouse_permissions where user_id = auth.uid() and warehouse_id = m.warehouse_id)
      )
  )
);
grant select, insert on public.message_reads to authenticated;

-- Broadcast select: anyone with access to the warehouse (any grant, home warehouse, or admin) — same
-- shape as orders' own grant-aware policy (schema_grant_aware_policies.sql). Additive alongside
-- p_messages_select (schema_messaging.sql), which only ever matches sender_id/recipient_id and so
-- never applies to a warehouse_id-only broadcast row anyway.
drop policy if exists p_messages_select_broadcast on public.messages;
create policy p_messages_select_broadcast on public.messages for select to authenticated using (
  warehouse_id is not null and (
    (select role from public.profiles where id = auth.uid()) = 'admin'
    or exists (select 1 from public.profiles where id = auth.uid() and warehouse_id = messages.warehouse_id)
    or exists (select 1 from public.warehouse_permissions where user_id = auth.uid() and warehouse_id = messages.warehouse_id)
  )
);
-- Broadcasting is editor+/admin only (same bar as creating a Pack Order) — not every viewer should
-- be able to message an entire warehouse at once. Additive alongside p_messages_insert, which
-- requires recipient_id and so never matches a broadcast row (recipient_id is null) anyway. See the
-- security-fix note at the top of this file — this is the corrected version.
drop policy if exists p_messages_insert_broadcast on public.messages;
create policy p_messages_insert_broadcast on public.messages for insert to authenticated with check (
  warehouse_id is not null and sender_id = auth.uid() and (
    (select role from public.profiles where id = auth.uid()) = 'admin'
    or exists (
      select 1 from public.profiles
      where id = auth.uid() and warehouse_id = messages.warehouse_id and role in ('editor', 'maintainer')
    )
    or exists (
      select 1 from public.warehouse_permissions
      where user_id = auth.uid() and warehouse_id = messages.warehouse_id and role in ('editor', 'maintainer', 'admin')
    )
  )
);
