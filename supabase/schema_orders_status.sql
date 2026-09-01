-- Pack Orders had no lifecycle at all — saving one wrote a row and nothing ever changed it again.
-- "✅ Finalize Order" (deducts every line's quantity from stock via adjust_item_stock()) marks a
-- saved order fulfilled here, so a fulfilled order is distinguishable from a still-open one later.
--
-- Run once in the Supabase SQL Editor.

alter table public.orders add column if not exists status text not null default 'open';
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('open', 'fulfilled'));
