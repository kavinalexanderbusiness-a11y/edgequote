-- ── Deposit-gated scheduling V1 — the requirement, the link, and the preference ──
--
-- Approved ≠ secured. For big jobs the owner wants a deposit collected BEFORE the
-- booking is confirmed on the schedule, and wants the customer's preferred timing
-- as a REQUEST the business confirms — never self-booking. Three additions, all
-- additive, none of them a new money engine:
--
--  1. The REQUIREMENT lives on the quote (deposit_type/deposit_value) — mirroring
--     invoices.discount_type/discount_value's discriminated pair. A percent rule
--     derives its dollars from quotes.accepted_price (the figure the customer
--     consented to — for an options quote, the SELECTED option + travel, snapshotted
--     by quote_apply_option_choice). ⛔ No second calculation engine: the TS side
--     computes it with lib/payments/deposit.ts depositFromPercent, and no dollar
--     figure is ever stored for a percent rule, so it cannot drift from consent.
--
--  2. The COLLECTION is the EXISTING pre-invoice deposit shape — ledger.recordDeposit's
--     two legs (kind='payment' cash + kind='credit' liability, invoice_id null) —
--     plus payments.quote_id so the money is welded to the booking it secures.
--     "Collected" is then Σ signed cash rows (isCashRow) with this quote_id: a
--     refund is a negative row, so a refunded deposit un-satisfies the gate with
--     no stored boolean to go stale. ⛔ There is deliberately NO quotes.deposit_paid
--     column — readiness is derived from the ledger, always.
--
--  3. The PREFERENCE lives on the quote (preferred_date/_2/timing/note): the accepted
--     quote is the only durable pre-scheduling anchor (a jobs row IS a visit — a
--     placeholder visit to remember "prefers Aug 18" is forbidden vocabulary).
--     Written ONLY by portal_set_scheduling_preference (token-scoped) and ONLY while
--     status='accepted' — once the business schedules, the visit is the truth and
--     changes go through the existing request flow.
--
-- deposit_override_at records the owner's explicit "schedule without the deposit"
-- decision — the schedule doors confirm it, this stamps it, nothing hides that the
-- money is still owed.
--
-- Safe to re-run: everything is IF NOT EXISTS / guarded.

-- ── 1. The requirement + the preference, on the quote ────────────────────────
alter table public.quotes
  add column if not exists deposit_type        text,
  add column if not exists deposit_value       numeric(10,2),
  add column if not exists preferred_date      date,
  add column if not exists preferred_date_2    date,
  add column if not exists preferred_timing    text,
  add column if not exists preferred_note      text,
  add column if not exists deposit_override_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_deposit_rule_check') then
    alter table public.quotes add constraint quotes_deposit_rule_check check (
      ((deposit_type is null) = (deposit_value is null))
      and (deposit_type is null or deposit_type in ('percent','fixed'))
      and (deposit_value is null or deposit_value > 0)
      and (deposit_type is distinct from 'percent' or deposit_value <= 100)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_preferred_timing_check') then
    alter table public.quotes add constraint quotes_preferred_timing_check check (
      preferred_timing is null or preferred_timing in ('morning','afternoon')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_preferred_note_check') then
    alter table public.quotes add constraint quotes_preferred_note_check check (
      preferred_note is null or char_length(preferred_note) <= 500
    );
  end if;
end $$;

comment on column public.quotes.deposit_type is
  'Scheduling-deposit rule: ''percent'' (deposit_value = % of the accepted price) or ''fixed'' (deposit_value = dollars). NULL = no deposit required — the quote behaves exactly as before this feature existed. The dollar figure for percent is DERIVED at read time (lib/payments/depositGate), never stored.';
comment on column public.quotes.preferred_date is
  'The customer''s preferred work date — a REQUEST, never a booking. A real visit exists only when the owner schedules one. Written only by portal_set_scheduling_preference while the quote is accepted.';
comment on column public.quotes.deposit_override_at is
  'Owner explicitly scheduled without the required deposit collected (the confirm dialog''s stamp). The deposit remains owed — this records the decision, it does not waive the money.';

-- ── 2. The ledger link: which booking a pre-invoice deposit secures ──────────
alter table public.payments
  add column if not exists quote_id uuid;

-- Composite FK (user_id, quote_id) → quotes(user_id, id): the same tenancy lesson
-- job_line_items learned the hard way — a single-column FK + user_id-only RLS lets
-- Business A attach money to Business B's quote. The composite makes cross-tenant
-- attachment impossible AT THE DATABASE. ON DELETE SET NULL (quote_id): deleting a
-- quote must never delete or orphan-cascade money records — the ledger row survives,
-- only the link clears (PG15+ column-list form so user_id is untouched).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_quote_tenant_fkey') then
    alter table public.payments
      add constraint payments_quote_tenant_fkey
      foreign key (user_id, quote_id) references public.quotes (user_id, id)
      on delete set null (quote_id);
  end if;
end $$;

create index if not exists payments_quote_id_idx
  on public.payments (quote_id) where quote_id is not null;

comment on column public.payments.quote_id is
  'The quote/booking a PRE-INVOICE deposit secures (both legs of the recordDeposit pair carry it). Null on ordinary invoice payments. The scheduling gate sums signed cash rows (isCashRow) by this — a Stripe refund writes a negative row with the same quote_id, so readiness derives honestly.';

-- ── 3. The customer's preference door — token-scoped, accepted-only ──────────
-- One writer. The portal proves WHICH customer via the token; the quote must be
-- that customer's and still 'accepted' (pre-scheduling). After the business
-- schedules, the visit is the record and this door closes — date changes go
-- through the existing service-request flow, never by mutating a booked visit.
create or replace function public.portal_set_scheduling_preference(
  p_token text,
  p_quote_id uuid,
  p_date date default null,
  p_date_2 date default null,
  p_timing text default null,
  p_note text default null
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_customer uuid;
begin
  select customer_id into v_customer
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  -- Validation lives HERE, not in the client: obviously-invalid preferences are
  -- refused server-side so a forged call can't store garbage. current_date - 1
  -- tolerates the customer being behind UTC at midnight; the client enforces
  -- >= local today properly.
  if p_timing is not null and p_timing not in ('morning','afternoon') then return false; end if;
  if p_date_2 is not null and p_date is null then return false; end if;
  if p_date is not null and p_date < current_date - 1 then return false; end if;
  if p_date_2 is not null and p_date_2 < current_date - 1 then return false; end if;
  if p_note is not null and char_length(p_note) > 500 then return false; end if;

  update public.quotes
     set preferred_date   = p_date,
         preferred_date_2 = p_date_2,
         preferred_timing = p_timing,
         preferred_note   = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_quote_id
     and customer_id = v_customer
     and status = 'accepted';
  return found;
end $$;

-- ⚠️⚠️ Named roles, then re-grant the callers. This project's ALTER DEFAULT
-- PRIVILEGES hands EXECUTE to anon/authenticated/service_role at CREATE time —
-- `revoke from public` alone leaves all three holding grants (the quote-options
-- lesson; read pg_proc.proacl BACK after applying, the migration text is not
-- evidence). anon is re-granted because the portal runs on the anon key with the
-- token as the credential — the same contract as portal_accept_quote.
revoke all on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text)
  to anon, authenticated;

comment on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text) is
  'THE writer of a customer''s scheduling preference. Token proves the customer; quote must be theirs and ''accepted''. A preference is a request — it never creates, moves, or implies a visit. All-null clears it.';
