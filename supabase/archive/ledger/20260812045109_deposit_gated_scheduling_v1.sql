-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260812045109
--   name    : deposit_gated_scheduling_v1
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

-- ── Deposit-gated scheduling V1 — the requirement, the link, and the preference ──
-- (Body identical to supabase/RUN-2026-08-11-deposit-gated-scheduling.sql)

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

alter table public.payments
  add column if not exists quote_id uuid;

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

revoke all on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text)
  to anon, authenticated;

comment on function public.portal_set_scheduling_preference(text, uuid, date, date, text, text) is
  'THE writer of a customer''s scheduling preference. Token proves the customer; quote must be theirs and ''accepted''. A preference is a request — it never creates, moves, or implies a visit. All-null clears it.';