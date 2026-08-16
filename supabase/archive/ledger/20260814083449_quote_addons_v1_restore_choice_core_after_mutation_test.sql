-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083449
--   name    : quote_addons_v1_restore_choice_core_after_mutation_test
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restores public.quote_apply_choice after the deliberate mutation test above.
-- Byte-identical to quote_addons_v1_choice_core.
create or replace function public.quote_apply_choice(
  p_quote_id uuid, p_option_id uuid, p_addon_ids uuid[], p_via text
) returns boolean
language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_status text; v_travel numeric(10,2); v_follow int;
  v_base numeric(10,2); v_addons numeric(10,2);
  v_ids uuid[]; v_known int; v_want int;
begin
  -- Provenance is passed in by the door that knows it, never inferred here.
  if p_via is null or p_via not in ('portal', 'owner') then return false; end if;

  -- 'draft' or 'sent' = NOT YET DECIDED. Anything else means a choice already
  -- stands, and re-deciding would silently rewrite the approved price.
  select q.status, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0), q.initial_price
    into v_status, v_travel, v_follow, v_base
    from public.quotes q
   where q.id = p_quote_id and q.status in ('draft', 'sent');
  if v_status is null then return false; end if;

  -- THE tenancy statement: o.quote_id = p_quote_id. Resolving the option THROUGH
  -- the quote is what makes "you may not name another quote's option" true here
  -- rather than wherever someone remembered to check it.
  if p_option_id is not null then
    select o.price into v_base from public.quote_options o
     where o.id = p_option_id and o.quote_id = p_quote_id;
    if v_base is null then return false; end if;
  elsif exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    -- A quote that offers alternatives cannot be approved without naming one.
    return false;
  end if;

  -- Every id must resolve THROUGH this quote, and an id we cannot name is a
  -- REFUSAL, never a silent drop: approving "the ones we recognised" would record
  -- consent to a configuration the customer never saw. De-duplicated first, so
  -- naming the same extra twice cannot bill it twice.
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_addon_ids, '{}'::uuid[])) x where x is not null;
  v_want := coalesce(array_length(v_ids, 1), 0);
  if v_want > 0 then
    select count(*) into v_known from public.quote_addons
     where quote_id = p_quote_id and id = any(v_ids);
    if v_known <> v_want then return false; end if;
  end if;

  -- The selection is set for EVERY add-on on the quote, not just the chosen ones:
  -- an extra the customer unticked must stop being selected, or a pre-ticked
  -- suggestion would be billed because nobody said no loudly enough.
  update public.quote_addons
     set is_selected  = (id = any(v_ids)),
         selected_via = case when id = any(v_ids) then p_via else null end,
         selected_at  = case when id = any(v_ids) then now()  else null end
   where quote_id = p_quote_id;

  select coalesce(sum(price), 0) into v_addons
    from public.quote_addons where quote_id = p_quote_id and is_selected;

  update public.quotes
     set status = 'accepted',
         selected_option_id = coalesce(p_option_id, selected_option_id),
         initial_price = v_base,
         -- ⭐ Computed EXPLICITLY, never coalesce(accepted_price, total): `total`
         -- is GENERATED over initial_price/addons_total and every SET expression
         -- reads the OLD row, so it would snapshot the pre-choice price.
         accepted_price = v_base + v_travel + v_addons,
         accepted_after_followup = v_follow > 0,
         follow_up_count_at_acceptance = v_follow
   where id = p_quote_id and status in ('draft', 'sent');
  return found;
end $fn$;

revoke all on function public.quote_apply_choice(uuid, uuid, uuid[], text)
  from public, anon, authenticated, service_role;