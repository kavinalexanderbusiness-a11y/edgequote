-- ── Close the REST surface on six trigger functions ──────────────────────────
--
-- WHY
-- RUN-db-catchup-2026-06-25.sql revoked EXECUTE from public/anon/authenticated on
-- every SECURITY DEFINER trigger function that existed at the time (11 of them). Six
-- trigger functions have been added since and none of them got the same treatment, so
-- they are currently reachable at /rest/v1/rpc/<name> by the anon role:
--
--   crm_stamp_review_requested   crm_sync_referral        crm_touch_last_contacted
--   recompute_equipment_service  recompute_invoice_paid   recompute_part_stock
--
-- Flagged by Supabase's own linter (anon_security_definer_function_executable).
--
-- HOW BAD, HONESTLY
-- Not an open door. Postgres refuses a direct call to a trigger function
-- ("trigger functions can only be called as triggers"), so this is unexploited
-- surface rather than a live hole. But recompute_invoice_paid is the trigger that
-- derives invoices.amount_paid/status from the payments ledger — it should not be
-- addressable by an anonymous caller at all, and the repo already decided that for
-- its 11 siblings. This is the pattern catching up with the code, not a new rule.
--
-- NOT A BEHAVIOUR CHANGE
-- Triggers do not consult the *caller's* EXECUTE privilege — they fire as the trigger
-- owner regardless. Verified before writing this that no application code calls any of
-- these six via .rpc(); they are trigger-only by construction. So every trigger keeps
-- firing exactly as it does today; only the ability to name them over REST goes away.
--
-- SAFETY: re-runnable. `if exists` guards each one so this survives a database where
-- a given trigger function hasn't been created yet.

do $$
declare fn text;
begin
  foreach fn in array array[
    'crm_stamp_review_requested()',
    'crm_sync_referral()',
    'crm_touch_last_contacted()',
    'recompute_equipment_service()',
    'recompute_invoice_paid()',
    'recompute_part_stock()'
  ] loop
    if exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where p.proname = split_part(fn, '(', 1)
        and pg_get_function_identity_arguments(p.oid) = ''
    ) then
      execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    end if;
  end loop;
end $$;
