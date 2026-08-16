-- ── Tips / gratuity v1 ───────────────────────────────────────────────────────
-- A customer paying an invoice online may voluntarily add a tip. The tip rides
-- inside ONE Stripe charge with the invoice payment, but it is NOT invoice
-- revenue: the invoice total, the amount applied to it, its balance and its
-- status must all read exactly as they would have with no tip.
--
-- THE MECHANISM, and why it is a mechanism rather than a discipline:
-- recompute_invoice_paid_for() — the trigger that owns invoices.amount_paid,
-- paid_at and status — sums ONLY `kind = 'payment'` rows:
--
--     select coalesce(sum(p.amount), 0) into v_paid
--     from public.payments p
--     where p.invoice_id = p_invoice_id and p.kind = 'payment' and p.status = 'paid';
--
-- So a tip recorded under a NEW kind is invisible to it by construction. No
-- application code can leak a tip into an invoice balance, because no
-- application code maintains that balance. The same `kind = 'payment'` filter
-- already keeps tips out of: isCashRow (lib/payments/ledger — THE definition of
-- cash arriving, which every collected/revenue figure reads), collectedBetween's
-- query, capture_integration_event's `payment.recorded` outbound webhook, and
-- the webhook's own paymentForIntent lookup.
--
-- We add 'tip' to the existing kind CHECK rather than adding a tip_amount column
-- to the payment row, because a tip must be independently REFUNDABLE. Stripe
-- refunds arrive as a cumulative figure against one charge; with a separate row
-- the reversal is just another signed row on the same ledger the invoice
-- reversal already uses, and paymentForIntent (which filters kind='payment' AND
-- amount > 0) keeps resolving one candidate per PaymentIntent.
--
-- Note 'refund' is already permitted by this CHECK and written by nothing — a
-- refund is a negative kind='payment' row. That is unchanged here; widening this
-- constraint is additive and cannot invalidate an existing row.

alter table public."payments" drop constraint if exists "payments_kind_check";
alter table public."payments" add constraint "payments_kind_check"
  CHECK ((kind = ANY (ARRAY['payment'::text, 'credit'::text, 'refund'::text, 'tip'::text])));

comment on column public."payments"."kind" is
  'What this ledger row IS. payment = money applied to an invoice (the ONLY kind recompute_invoice_paid_for sums, and the only kind isCashRow accepts). credit = the customer-credit liability ledger. tip = voluntary gratuity collected alongside an invoice payment — deliberately outside every invoice balance and every cash/revenue figure. refund = permitted but unwritten; a reversal is a NEGATIVE row of the kind it reverses.';

-- ── Owner configuration ──────────────────────────────────────────────────────
-- Tips are OFF by default. Most trades (HVAC, plumbing, electrical, commercial)
-- do not take gratuity, and a tip prompt that appears uninvited on a customer's
-- invoice is the business's reputation, not ours. There is deliberately NO
-- service-name or industry heuristic: the business decides.
--
-- Discrete columns, not a jsonb blob: every money/behaviour setting on this
-- table is discrete, and a jsonb settings blob on business_settings has twice
-- lost owner data to a partial write. A CHECK can also police an array; it
-- cannot police a key inside jsonb.

alter table public."business_settings"
  add column if not exists "tips_enabled" boolean default false not null;

-- Percentages, 1..100, at most three. Stored as the OWNER's intent (a percent),
-- never as pre-computed money: the dollar figure is derived at display time from
-- the amount actually being charged, so it cannot drift from the ask.
alter table public."business_settings"
  add column if not exists "tip_presets" integer[] default '{10,15,20}'::integer[] not null;

-- Whether the customer may name their own amount. Independent of the presets:
-- an owner may want presets only, or a custom field only.
alter table public."business_settings"
  add column if not exists "tip_custom_enabled" boolean default true not null;

alter table public."business_settings" drop constraint if exists "business_settings_tip_presets_check";
alter table public."business_settings" add constraint "business_settings_tip_presets_check"
  CHECK (
    array_length(tip_presets, 1) is null
    or (array_length(tip_presets, 1) <= 3
        and array_length(tip_presets, 1) = cardinality(tip_presets)   -- no NULL elements
        and 0 < ALL (tip_presets)
        and 100 >= ALL (tip_presets))
  );

comment on column public."business_settings"."tips_enabled" is
  'Offer an optional tip on the customer portal''s online invoice payment. OFF by default — most trades do not take gratuity, and nothing infers this from the service name. Gated additionally by platform_capabilities.online_payments: a tenant that may not take card payments at all may not take tips.';
comment on column public."business_settings"."tip_presets" is
  'Up to three suggested tip PERCENTAGES (1..100) shown to the customer. Stored as the owner''s intent; the dollar figure is derived from the amount actually being charged, so a preset can never disagree with the ask. An empty array means presets-off (custom only, if enabled).';
comment on column public."business_settings"."tip_custom_enabled" is
  'Whether the customer may enter their own tip amount instead of picking a preset. The server clamps any custom amount regardless of this flag.';

-- ── Index: the tip lookups ───────────────────────────────────────────────────
-- The refund apportioner asks "what tip legs already exist for this Stripe
-- PaymentIntent?" on every charge.refunded delivery, and the owner's tip
-- reporting slices by tenant + date. Partial on kind='tip' so it stays tiny —
-- tips are a small minority of the ledger.
create index if not exists "payments_tip_intent_idx"
  on public."payments" ("stripe_payment_intent") where (kind = 'tip');
create index if not exists "payments_tip_user_paid_at_idx"
  on public."payments" ("user_id", "paid_at") where (kind = 'tip');
