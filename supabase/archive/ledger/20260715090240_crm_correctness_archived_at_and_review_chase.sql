-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715090240
--   name    : crm_correctness_archived_at_and_review_chase
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

-- 1. Soft delete: a hard DELETE cascades crm_campaign_log, which is BOTH the CASL
-- audit trail and the per-period dedupe ledger — so Undo restored an enabled
-- campaign with an empty ledger and re-sent to everyone.
alter table public.crm_campaigns
  add column if not exists archived_at timestamptz;

comment on column public.crm_campaigns.archived_at is
  'Soft delete. A hard DELETE cascades crm_campaign_log (the audit trail AND the dedupe ledger), so an undo would re-send to everyone. The cron and the manager both filter archived_at is null.';

create index if not exists crm_campaigns_active_idx
  on public.crm_campaigns(user_id, enabled)
  where archived_at is null;

-- 2. The bulk review campaign now sends `review_chase` (categorised 'marketing',
-- so it honours the marketing opt-out); the day-after ask keeps `review_request`
-- ('reminders', correct — it follows a visit the customer booked). The trigger
-- matched only review_request, so the chase would otherwise stop stamping
-- review_requested_at and could chase a customer forever.
create or replace function public.crm_stamp_review_requested()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.template in ('review_request', 'review_chase')
     and new.status = 'sent'
     and new.customer_id is not null then
    update public.customers
      set review_requested_at = coalesce(review_requested_at, new.created_at)
      where id = new.customer_id and reviewed_at is null and review_declined_at is null;
  end if;
  return new;
end; $$;