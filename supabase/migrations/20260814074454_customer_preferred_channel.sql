-- ── Customer communication preference ───────────────────────────────────────
-- ONE nullable column that records HOW a customer would rather be contacted.
--
-- This is deliberately NOT a consent column and NOT a second consent engine:
--
--   consent  (sms_opt_in / email_opt_in / message_prefs)  = MAY we contact them
--   capability (platform_capabilities)                    = MAY THIS TENANT send
--   preference (this column)                              = which do they PREFER
--
-- Preference can only ORDER the channels consent has already allowed. It can
-- never grant one: a customer whose preferred_channel is 'sms' with
-- sms_opt_in = false is still never texted (see src/lib/comms/reach.ts).
-- That is why this column carries no audit trail while consent does — flipping a
-- preference cannot change who may be messaged, so consent_changes must not be
-- polluted with rows that imply it did.
--
-- 'phone' means a human phone call, which EdgeQuote never places. It records an
-- instruction to the OWNER, not a channel the send pipeline can use.
--
-- NULL = no preference recorded, which is the state every existing customer
-- starts in and a state the product must work in unchanged.

alter table public.customers
  add column if not exists preferred_channel text;

-- The allowed set lives in the DATABASE, not only in TypeScript: a bad value
-- from an import, a script or a future writer is rejected at the one place all
-- of them pass through.
alter table public.customers
  drop constraint if exists customers_preferred_channel_chk;

alter table public.customers
  add constraint customers_preferred_channel_chk
  check (preferred_channel is null or preferred_channel in ('sms', 'email', 'phone'));

comment on column public.customers.preferred_channel is
  'How the customer prefers to be contacted: sms | email | phone | NULL (no preference). A PREFERENCE, never consent — it orders the channels consent already allows and can never grant one. ''phone'' is an instruction to the owner; the send pipeline never places calls.';
