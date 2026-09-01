-- Per-item override for the "Low stock" badge threshold — the existing lowstock-threshold Settings
-- value is one number for the whole app; some items genuinely need reordering at 5 units, others
-- at 500. Set on an item (Add/Edit or quick-edit), it always applies regardless of whether the
-- app-wide Settings toggle is even on; left blank, the item falls back to that app-wide setting.
--
-- Run once in the Supabase SQL Editor.

alter table public.items add column if not exists reorder_threshold integer;
