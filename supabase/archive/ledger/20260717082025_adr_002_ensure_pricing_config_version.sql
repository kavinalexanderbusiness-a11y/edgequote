-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717082025
--   name    : adr_002_ensure_pricing_config_version
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

create or replace function public.ensure_pricing_config_version(p_user uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  s    record;
  w    record;
begin
  if p_user is null then return null; end if;

  select
    case when coalesce(pricing_base_charge, 0) > 0      then pricing_base_charge      else 28  end as base_charge,
    case when coalesce(pricing_mow_rate, 0) > 0         then pricing_mow_rate         else 15  end as mow_rate_per_1000,
    0.8::numeric  as budget_mult,
    0.92::numeric as market_mult,
    case when coalesce(pricing_recommended_mult, 0) > 0 then pricing_recommended_mult else 1.0 end as recommended_mult,
    case when coalesce(pricing_premium_mult, 0) > 0     then pricing_premium_mult     else 1.2 end as premium_mult,
    case when coalesce(pricing_travel_rate, 0) > 0      then pricing_travel_rate      else 1.5 end as travel_rate_per_km,
    coalesce(crew_cost_per_hour, 40)                        as crew_cost_per_hour,
    coalesce(fee_recovery_percent, 3)                       as fee_recovery_percent,
    coalesce(payment_fee_strategy, 'global_price_increase') as payment_fee_strategy
  into w
  from public.business_settings where user_id = p_user;

  if not found then return null; end if;

  select * into s from public.pricing_config_versions
   where user_id = p_user order by valid_from desc limit 1;

  if found
     and s.engine_version = 'v1'
     and s.base_charge          = w.base_charge
     and s.mow_rate_per_1000    = w.mow_rate_per_1000
     and s.budget_mult          = w.budget_mult
     and s.market_mult          = w.market_mult
     and s.recommended_mult     = w.recommended_mult
     and s.premium_mult         = w.premium_mult
     and s.travel_rate_per_km   = w.travel_rate_per_km
     and s.crew_cost_per_hour   = w.crew_cost_per_hour
     and s.fee_recovery_percent = w.fee_recovery_percent
     and s.payment_fee_strategy = w.payment_fee_strategy
  then
    return s.id;
  end if;

  insert into public.pricing_config_versions (
    user_id, valid_from, source, note, engine_version,
    base_charge, mow_rate_per_1000, budget_mult, market_mult,
    recommended_mult, premium_mult, travel_rate_per_km,
    crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy
  ) values (
    p_user, now(), 'recorded', 'Recorded by ensure_pricing_config_version on a detected settings change.', 'v1',
    w.base_charge, w.mow_rate_per_1000, w.budget_mult, w.market_mult,
    w.recommended_mult, w.premium_mult, w.travel_rate_per_km,
    w.crew_cost_per_hour, w.fee_recovery_percent, w.payment_fee_strategy
  ) returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.ensure_pricing_config_version(uuid) from public;
grant execute on function public.ensure_pricing_config_version(uuid) to authenticated, service_role;