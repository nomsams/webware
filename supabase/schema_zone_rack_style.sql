-- What kind of physical racking a zone actually is: open pallet racking (a beam bolted between
-- uprights at each level, pallets set directly on the beams — no solid deck) or boltless shelving
-- (a solid shelf board at each level, X cross-braced uprights at the back). The isometric 3D view
-- (modules/iso-rack.js) draws a visibly different picture for each — orange beams and yellow floor
-- guards for pallet racking, gray decking and diagonal bracing for shelving — matched against real
-- photos of the two kinds of storage this warehouse actually uses, instead of one generic drawing
-- for every zone regardless of what it really looks like.
--
-- Nullable, and null means "not recorded" (drawn as 'pallet', the more common default and what the
-- one zone with real data today already is) rather than being forced to a value — same convention
-- as every other optional column on this table (shelf_width_cm, label, ...).
--
-- Run once in the Supabase SQL Editor, after schema_zone_dimensions.sql. Safe to re-run.

begin;

alter table public.warehouse_zones add column if not exists rack_style text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.warehouse_zones'::regclass and conname = 'warehouse_zones_rack_style_check'
  ) then
    alter table public.warehouse_zones add constraint warehouse_zones_rack_style_check
      check (rack_style is null or rack_style in ('pallet', 'shelving'));
  end if;
end $$;

comment on column public.warehouse_zones.rack_style is
  'How this rack area is drawn in the isometric 3D view: ''pallet'' (open beam racking, the default when null) or ''shelving'' (boltless shelving with cross-bracing). Purely visual — never affects the Depth/Level/Bin numbering.';

commit;
