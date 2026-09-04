-- Lets a whole CSV import (or bulk stock update) be undone as one action instead of reverting each
-- item one at a time from the Activity Log. logActivity() now accepts an optional batch_id, shared
-- across every entry written during one commitCSVImport()/commitStockUpdateImport() call; the
-- client's "↩️ Undo Import" button (shown on the success toast right after a Supabase-mode import)
-- looks up every not-yet-reverted entry for that batch_id and reverts each one via the existing
-- revert_activity_log_entry() RPC — no new RPC needed, this migration only adds the column (plus an
-- index for that lookup) that makes finding "everything from this one import" possible.
--
-- Run once in the Supabase SQL Editor, after schema_activity_log.sql.

alter table public.activity_log add column if not exists batch_id uuid;
create index if not exists idx_activity_log_batch on public.activity_log (batch_id) where batch_id is not null;
