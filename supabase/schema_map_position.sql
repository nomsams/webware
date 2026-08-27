-- Adds a real per-item grid coordinate for the warehouse locator map (was previously a fake
-- hash-of-BTK-number visual with no connection to actual item data).
--
-- Run once in the Supabase SQL Editor, after the earlier migrations.

alter table public.items add column if not exists map_position text;
