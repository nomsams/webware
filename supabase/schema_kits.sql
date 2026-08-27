-- Normalized kit tables for Supabase-mode warehouses (edge-list, not the wide CSV-A matrix).
-- Run once in the Supabase SQL Editor, after the original items/profiles/warehouses schema.
--
-- kitnumber is NOT a reliable unique key on its own (several kits in the source data share
-- kitnumber 'None') — kits.id is the real primary key; kitnumber/name are just display fields.

create table public.kits (
  id bigint generated always as identity primary key,
  kitnumber text,
  name text not null,
  warehouse_id text not null references public.warehouses(l)
);

create table public.kit_items (
  kit_id bigint not null references public.kits(id) on delete cascade,
  btk text not null references public.items(btk) on delete cascade,
  quantity integer not null default 1,
  primary key (kit_id, btk)
);

alter table public.kits enable row level security;
alter table public.kit_items enable row level security;

-- Same viewer/editor/admin shape as items: read scoped to your own warehouse (or admin sees all),
-- update open to editor+admin, insert/delete restricted to admin.
create policy p_kits_select on public.kits for select to authenticated using (
  warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
  or (select role from public.profiles where id = auth.uid()) = 'admin'
);
create policy p_kits_insert on public.kits for insert to authenticated
  with check ((select role from public.profiles where id = auth.uid()) = 'admin');
create policy p_kits_update on public.kits for update to authenticated using (
  (select role from public.profiles where id = auth.uid()) in ('editor','admin')
) with check (true);
create policy p_kits_delete on public.kits for delete to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'admin');

create policy p_kit_items_select on public.kit_items for select to authenticated using (
  exists (
    select 1 from public.kits k where k.id = kit_id and (
      k.warehouse_id = (select warehouse_id from public.profiles where id = auth.uid())
      or (select role from public.profiles where id = auth.uid()) = 'admin'
    )
  )
);
create policy p_kit_items_insert on public.kit_items for insert to authenticated
  with check ((select role from public.profiles where id = auth.uid()) = 'admin');
create policy p_kit_items_update on public.kit_items for update to authenticated using (
  (select role from public.profiles where id = auth.uid()) in ('editor','admin')
) with check (true);
create policy p_kit_items_delete on public.kit_items for delete to authenticated
  using ((select role from public.profiles where id = auth.uid()) = 'admin');

grant select, insert, update, delete on public.kits to authenticated;
grant select, insert, update, delete on public.kit_items to authenticated;
