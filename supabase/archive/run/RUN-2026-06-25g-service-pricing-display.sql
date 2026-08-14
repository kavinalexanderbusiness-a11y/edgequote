-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Service Templates → Pricing Display Type (2026-06-25g).
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- ════════════════════════════════════════════════════════════
--
-- Replaces the implicit "$X/hr" assumption on service templates with an explicit
-- pricing_display_type, so a service can be priced "Starting from", hourly, per
-- sq ft, per linear ft, or "+ materials". The existing default_rate column is
-- REUSED as the price value (a starting price, an hourly rate, or a per-unit rate
-- depending on the type) — no rename, so the quote builder keeps working and
-- EXISTING QUOTES/INVOICES ARE UNTOUCHED. Display is driven by one shared
-- formatter (src/lib/servicePricing.ts).

-- (1) The new type. Defaults to 'starting_from' — how almost everything is priced.
alter table public.service_templates
  add column if not exists pricing_display_type text not null default 'starting_from'
  check (pricing_display_type in (
    'starting_from','hourly','per_sqft','per_linear_ft','starting_from_materials','hourly_materials'
  ));

-- (2) Migrate existing rows. Every existing service started life as "$X/hr", but
-- the brief is explicit: those should become "Starting From" UNLESS they are a
-- genuinely hourly service. New rows already default to 'starting_from'; here we
-- only flip the clearly-hourly ones back to 'hourly' (their default_rate is a real
-- $/hr value, so it stays correct). All other types + their per-unit prices are
-- set by the owner in the editor — we never guess a per-sqft value from an $/hr one.
update public.service_templates
  set pricing_display_type = 'hourly'
  where pricing_display_type = 'starting_from'
    and (
      name ilike '%weed removal%'
      or name ilike '%general landscaping%'
      or name ilike '%hourly%'
      or name ilike '%labour%'
      or name ilike '%labor%'
      or name ilike '%handyman%'
    );
