-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717055508
--   name    : quote_materials
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quote_services
  add column if not exists kind text not null default 'service';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_services'::regclass and conname = 'quote_services_kind_check'
  ) then
    alter table public.quote_services
      add constraint quote_services_kind_check check (kind in ('service','material'));
  end if;
end $$;

comment on column public.quote_services.kind is
  'What this line IS: service (labour you perform) or material (goods you supply). A material line is an ESTIMATE ON THE QUOTE — quantity x unit_price, same arithmetic, same discount engine. It never reserves, allocates or deducts stock, and carries no cost: see RUN-2026-07-16-quote-materials.sql.';

comment on column public.quote_services.service_type is
  'The line''s display name. For kind=service, the service performed; for kind=material, the material supplied ("Mulch"). Historical name — not a claim that the line is a service.';

insert into public.service_units (user_id, code, label, abbrev, step, decimals, sort_order) values
  (null, 'cubic_yard', 'Cubic yards', 'yd³',    0.5, 1, 100),
  (null, 'ton',        'Tons',        'ton',    0.5, 2, 110),
  (null, 'bag',        'Bags',        'bag',    1,   0, 120),
  (null, 'pallet',     'Pallets',     'pallet', 1,   0, 130),
  (null, 'tray',       'Trays',       'tray',   1,   0, 140)
on conflict do nothing;