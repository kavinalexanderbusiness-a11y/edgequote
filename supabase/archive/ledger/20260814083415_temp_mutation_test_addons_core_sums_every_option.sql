-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083415
--   name    : temp_mutation_test_addons_core_sums_every_option
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ⚠️ MUTATION TEST — the choice core sums EVERY option and EVERY extra, the two
-- headline lies this feature exists to prevent. RESTORED by the next migration.
create or replace function public.quote_apply_choice(
  p_quote_id uuid, p_option_id uuid, p_addon_ids uuid[], p_via text
) returns boolean
language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_status text; v_travel numeric(10,2); v_follow int;
  v_base numeric(10,2); v_addons numeric(10,2);
  v_ids uuid[]; v_known int; v_want int;
begin
  if p_via is null or p_via not in ('portal', 'owner') then return false; end if;
  select q.status, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0), q.initial_price
    into v_status, v_travel, v_follow, v_base
    from public.quotes q where q.id = p_quote_id and q.status in ('draft', 'sent');
  if v_status is null then return false; end if;

  if p_option_id is not null then
    -- MUTATION: every alternative summed, not the chosen one.
    select coalesce(sum(o.price), 0) into v_base from public.quote_options o where o.quote_id = p_quote_id;
    if v_base is null then return false; end if;
  elsif exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    return false;
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_addon_ids, '{}'::uuid[])) x where x is not null;
  v_want := coalesce(array_length(v_ids, 1), 0);
  if v_want > 0 then
    select count(*) into v_known from public.quote_addons where quote_id = p_quote_id and id = any(v_ids);
    if v_known <> v_want then return false; end if;
  end if;

  update public.quote_addons
     set is_selected  = (id = any(v_ids)),
         selected_via = case when id = any(v_ids) then p_via else null end,
         selected_at  = case when id = any(v_ids) then now()  else null end
   where quote_id = p_quote_id;

  -- MUTATION: every extra summed, selected or not.
  select coalesce(sum(price), 0) into v_addons from public.quote_addons where quote_id = p_quote_id;

  update public.quotes
     set status = 'accepted',
         selected_option_id = coalesce(p_option_id, selected_option_id),
         initial_price = v_base,
         accepted_price = v_base + v_travel + v_addons,
         accepted_after_followup = v_follow > 0,
         follow_up_count_at_acceptance = v_follow
   where id = p_quote_id and status in ('draft', 'sent');
  return found;
end $fn$;
revoke all on function public.quote_apply_choice(uuid, uuid, uuid[], text)
  from public, anon, authenticated, service_role;