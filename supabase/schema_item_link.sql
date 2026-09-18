-- A free-form "Link" field per item — a URL to a supplier's product page, a datasheet, or
-- anything else worth one click away from the item itself. Shown on the item page as a clickable
-- link, editable via Add/Edit Item, Quick Edit, CSV import ("Link"/"URL"/"Website" columns), and
-- the AI Assistant's edit_field action, same as every other free-text item field.
--
-- Run once in the Supabase SQL Editor.

alter table public.items add column if not exists link text;
