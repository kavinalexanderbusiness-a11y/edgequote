-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-07-14 — Provider delivery tracking (SMS + email)
-- Today a send is recorded as 'sent' the moment Twilio/Resend ACCEPT it, which
-- is not the same as the customer receiving it. This persists the provider's own
-- message id (Twilio MessageSid / Resend email id) on the send records so the
-- delivery webhooks (/api/sms/status, /api/email/status) can find the row later
-- and advance it to what actually happened: delivered · opened · clicked, or
-- failed · bounced · spam.
--
-- Additive + idempotent. The sending pipeline is untouched: with no webhooks
-- configured every row simply stays at 'sent', exactly as it behaves today.
--
-- Webhooks authenticate with the service-role key, which bypasses RLS, so no
-- UPDATE policy is added here (owners must not be able to rewrite delivery
-- history — it's an audit trail).
-- ════════════════════════════════════════════════════════════

-- The per-channel audit record: one row per channel attempt.
alter table public.notification_log
  add column if not exists provider            text,          -- 'twilio' | 'resend'
  add column if not exists provider_message_id text,          -- Twilio MessageSid / Resend email id
  add column if not exists delivered_at        timestamptz,
  add column if not exists opened_at           timestamptz;

-- The thread bubble the owner actually reads. (twilio_sid stays as-is: it is the
-- INBOUND sid + its unique index guards Twilio re-delivery — a different job.)
alter table public.messages
  add column if not exists provider            text,
  add column if not exists provider_message_id text,
  add column if not exists delivered_at        timestamptz;

-- Webhook lookup path: resolve a provider id to its row(s) in one indexed hit.
-- Partial — only sent rows carry an id, so the index stays small.
create index if not exists notification_log_provider_msg_idx
  on public.notification_log(provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists messages_provider_msg_idx
  on public.messages(provider, provider_message_id)
  where provider_message_id is not null;
