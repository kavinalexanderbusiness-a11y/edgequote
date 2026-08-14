-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717020230
--   name    : pricing_v2_phase0_quote_accepted_snapshot
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

alter table public.quotes
  add column if not exists accepted_price numeric(10,2),
  add column if not exists selected_cadence text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_selected_cadence_check'
  ) then
    alter table public.quotes
      add constraint quotes_selected_cadence_check
      check (selected_cadence is null or selected_cadence in ('one_time','weekly','biweekly','monthly'));
  end if;
end $$;

comment on column public.quotes.accepted_price is
  'SNAPSHOT of what the customer agreed to pay, captured at acceptance. Deliberately a copy, not a reference to total: editing a quote afterwards must never rewrite what was agreed. NULL = accepted before this column existed, or accepted by a path that does not know. Never guess it.';

comment on column public.quotes.selected_cadence is
  'Which cadence was actually bought (one_time|weekly|biweekly|monthly). NULL = nobody said — do NOT infer it from whichever price column is populated; that is the bug this column exists to kill.';

create index if not exists quotes_accepted_snapshot_idx
  on public.quotes (user_id, selected_cadence)
  where accepted_price is not null;