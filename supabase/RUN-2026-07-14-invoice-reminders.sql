-- ── Automatic invoice reminders ──────────────────────────────────────────────
-- Gives invoices the same two-field reminder anchor quotes already have
-- (last_followed_up_at / follow_up_count). The dunning cron needs them for BOTH
-- of its guarantees:
--   • last_reminded_at is the clock the next reminder is spaced from (and, when
--     it's null, the due date is used — so the first chase lands delay-days after
--     the invoice actually came due).
--   • reminder_count is what the cron compare-and-swaps on, so two overlapping
--     runs can never remind the same invoice twice, and it enforces the owner's
--     maximum.
-- Nothing else reads these; every existing balance/status stays derived from the
-- ledger + the recompute_invoice_paid trigger exactly as before.
--
-- Idempotent: safe to run more than once.

alter table public.invoices
  add column if not exists last_reminded_at timestamptz,
  add column if not exists reminder_count   integer not null default 0;

-- The cron only ever scans invoices that still owe money. Keep that scan cheap
-- as the invoice history grows.
create index if not exists invoices_reminder_scan_idx
  on public.invoices (user_id, status, due_date)
  where status in ('unpaid', 'sent', 'partial');

comment on column public.invoices.last_reminded_at is
  'When the automatic payment reminder last went out. Null = never reminded; the due date is the anchor instead.';
comment on column public.invoices.reminder_count is
  'How many automatic payment reminders have been sent. Compare-and-swapped by /api/cron/invoice-reminders to guarantee at-most-once, and capped by the owner''s maximum.';
