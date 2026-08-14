-- ══════════════════════════════════════════════════════════════════════════════
-- CRM correctness pass (from the 8-lane audit of 2026-07-15).
--
-- Two schema changes, both required by fixes that are otherwise app-side.
--
-- 1. crm_campaigns.archived_at — soft delete.
--    crm_campaign_log.campaign_id is `on delete cascade`, and that log is BOTH the
--    CASL audit trail (who was messaged, when, on what channel) AND the per-period
--    dedupe ledger. So a hard DELETE destroyed the evidence, and the Undo toast then
--    re-inserted the campaign `enabled` with an EMPTY ledger — the next run messaged
--    every customer a second time. Archiving keeps the log, so Undo is a flag flip
--    and the dedupe still holds.
--
-- 2. crm_stamp_review_requested — widen to the new review_chase template.
--    The bulk review campaign now sends `review_chase` (categorised 'marketing', so
--    it honours the marketing opt-out) rather than `review_request` (categorised
--    'reminders', correct for the day-after ask that follows a real visit). The
--    trigger matched only 'review_request', so without this the chase would stop
--    stamping review_requested_at — and a customer could be chased forever.
--
-- Additive + idempotent. Safe to re-run. No data is destroyed.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Soft delete ───────────────────────────────────────────────────────────
alter table public.crm_campaigns
  add column if not exists archived_at timestamptz;

comment on column public.crm_campaigns.archived_at is
  'Soft delete. A hard DELETE cascades crm_campaign_log (the audit trail AND the dedupe ledger), so an undo would re-send to everyone. The cron and the manager both filter archived_at is null.';

-- The cron selects enabled + not-archived campaigns on every run.
create index if not exists crm_campaigns_active_idx
  on public.crm_campaigns(user_id, enabled)
  where archived_at is null;

-- ── 2. Review lifecycle: stamp on either review template ─────────────────────
-- Unchanged from the original except the template match. Still AFTER INSERT only,
-- still status='sent' (correct at insert time — a later delivery webhook advancing
-- the row to 'delivered' cannot re-fire an INSERT trigger), still coalesce() so a
-- repeat stamp is idempotent and never moves the first-asked date forward.
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
