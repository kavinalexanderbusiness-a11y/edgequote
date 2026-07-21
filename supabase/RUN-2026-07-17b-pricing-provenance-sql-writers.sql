-- ADR-002 · Pricing Configuration Provenance · MIGRATION 2 of 3: the SQL writers
--
-- Two of this app's quote writers price in plpgsql, and a TypeScript grep cannot see
-- either of them. That is not hypothetical: Phase 0 shipped a PR claiming "zero
-- hand-rolled sent-writers remain" on the strength of a grep that was blind to exactly
-- this surface. Covering them is the riskiest part of ADR-002, so it goes early.
--
-- ── ONE ENGINE, and why it lives HERE rather than in TypeScript ──────────────
-- `ensure_pricing_config_version` is THE implementation of "record the current rate
-- card if it moved". It is in SQL because BOTH callers must reach it:
--
--   * the dashboard (authenticated, TypeScript)  → calls it by RPC
--   * submit_booking (anonymous, SECURITY DEFINER, plpgsql) → calls it directly
--
-- The anonymous booking client CANNOT read pricing_config_versions (RLS scopes it to
-- auth.uid() = user_id), so it cannot resolve a version itself. The alternatives were
-- both worse: duplicate the comparison in plpgsql (two implementations of one concept
-- — precisely the defect this codebase keeps re-manufacturing), or have submit_booking
-- blindly SELECT the newest version (which silently records a STALE version as if it
-- had priced the quote, i.e. a lie, in the one case we cannot observe). One engine,
-- reachable from both, is the only honest option.
--
-- The TypeScript seam in lib/pricingConfig.ts now calls this rather than comparing
-- settings itself. Its comparison logic is deleted, not left beside this one.

begin;

-- ── THE engine ───────────────────────────────────────────────────────────────
-- Returns the version describing the CURRENT settings, recording a new one first if
-- the rate card has moved since the last. Idempotent: no change, no new row.
--
-- Mirrors lib/pricing's pos(): a null or non-positive setting falls back to the CODE
-- default, so a version records what the engine WOULD ACTUALLY HAVE USED rather than
-- what the column literally held. Recording the raw column would make the version
-- disagree with the price it exists to explain.
--
-- budget_mult / market_mult are hard-coded from DEFAULT_PRICING because they are NOT
-- settings-backed — they are code constants. That is exactly why they are versioned: a
-- code change moves them silently. ⚠️ If DEFAULT_PRICING.budgetMult/marketMult ever
-- change in lib/pricing.ts, this function must change WITH them and PRICING_ENGINE_VERSION
-- must be bumped — otherwise this records a config the engine did not use.
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

  -- No settings row at all: we cannot state a configuration, so we do not invent one.
  -- The caller must treat null as "cannot record engine provenance".
  if not found then return null; end if;

  select * into s from public.pricing_config_versions
   where user_id = p_user order by valid_from desc limit 1;

  -- Same rate card → reuse. Numeric comparison, so 45 and 45.00 never mint a version.
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

  -- The rate card moved. Record it — valid_from is the moment of RECORDING, which is
  -- the honest claim: we know this config is in force now; we cannot observe when it
  -- started. (business_settings.updated_at stamps the last touch of ANY field, not a
  -- pricing change, so it is not evidence of a start time.)
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

commit;
