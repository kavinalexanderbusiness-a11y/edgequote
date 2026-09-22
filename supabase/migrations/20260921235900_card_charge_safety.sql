begin;

-- Durable consent and one permanent charge claim per invoice. This migration is
-- intentionally fail-closed: if legacy Stripe evidence is ambiguous, the entire
-- transaction aborts before changing a session key or enabling the new charge path.
-- Block legacy payment writers until preflight, normalization and unique-index
-- creation have committed as one unit.
lock table public.payments in share row exclusive mode;

do $preflight$
declare
  v_invalid_intents bigint;
  v_duplicate_intents bigint;
  v_session_collisions bigint;
begin
  if to_regclass('public.customers') is null
     or to_regclass('public.customer_portal_tokens') is null
     or to_regclass('public.payment_methods') is null
     or to_regclass('public.jobs') is null
     or to_regclass('public.invoices') is null
     or to_regclass('public.business_settings') is null
     or to_regclass('public.payments') is null then
    raise exception using
      errcode = '55000',
      message = 'card charge safety preflight failed: required billing tables are missing';
  end if;

  if to_regclass('public.card_charge_consents') is not null
     or to_regclass('public.card_charge_attempts') is not null
     or to_regclass('public.card_charge_attempt_events') is not null
     or to_regclass('public.payments_positive_stripe_intent_once') is not null then
    raise exception using
      errcode = '55000',
      message = 'card charge safety preflight failed: a target object already exists; reconcile the partial rollout first';
  end if;

  select count(*) into v_invalid_intents
    from public.payments
   where amount > 0
     and coalesce(kind, 'payment') = 'payment'
     and coalesce(provider, 'stripe') <> 'credit'
     and (
       (stripe_session_id like 'autopay:%' and stripe_payment_intent is null)
       or (
         stripe_payment_intent is not null
         and (btrim(stripe_payment_intent) = '' or stripe_payment_intent <> btrim(stripe_payment_intent))
       )
     );
  if v_invalid_intents > 0 then
    raise exception using
      errcode = '22000',
      message = format('card charge safety preflight failed: %s positive payment row(s) have missing, blank or untrimmed Stripe PaymentIntent ids', v_invalid_intents);
  end if;

  select count(*) into v_duplicate_intents
    from (
      select stripe_payment_intent
        from public.payments
       where stripe_payment_intent is not null
         and amount > 0
         and coalesce(kind, 'payment') = 'payment'
         and coalesce(provider, 'stripe') <> 'credit'
       group by stripe_payment_intent
      having count(*) > 1
    ) duplicates;
  if v_duplicate_intents > 0 then
    raise exception using
      errcode = '23505',
      message = format('card charge safety preflight failed: %s duplicated positive Stripe PaymentIntent id(s) require reconciliation', v_duplicate_intents);
  end if;

  select count(*) into v_session_collisions
    from public.payments legacy
    join public.payments target
      on target.id <> legacy.id
     and target.stripe_session_id = 'autopay-pi:' || legacy.stripe_payment_intent
   where legacy.stripe_session_id like 'autopay:%'
     and legacy.stripe_payment_intent is not null
     and legacy.amount > 0
     and coalesce(legacy.kind, 'payment') = 'payment'
     and coalesce(legacy.provider, 'stripe') <> 'credit';
  if v_session_collisions > 0 then
    raise exception using
      errcode = '23505',
      message = format('card charge safety preflight failed: %s legacy AutoPay row(s) would collide with an existing normalized session key', v_session_collisions);
  end if;
end
$preflight$;

create table public.card_charge_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  customer_id uuid not null,
  payment_method_id text not null check (btrim(payment_method_id) <> ''),
  terms_version text not null check (btrim(terms_version) <> ''),
  scope text not null check (scope = 'recurring_invoice_balance'),
  terms_text text not null check (btrim(terms_text) <> ''),
  amount_rule text not null check (btrim(amount_rule) <> ''),
  evidence_source text not null check (evidence_source = 'customer_portal'),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint card_charge_consents_revoked_after_grant
    check (revoked_at is null or revoked_at >= granted_at),
  constraint card_charge_consents_customer_owner_fk
    foreign key (user_id, customer_id) references public.customers(user_id, id),
  constraint card_charge_consents_identity_owner_key
    unique (id, user_id, customer_id)
);

create index card_charge_consents_active_lookup_idx
  on public.card_charge_consents (user_id, customer_id, payment_method_id, granted_at desc)
  where revoked_at is null;

create table public.card_charge_attempts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique,
  user_id uuid not null,
  customer_id uuid not null,
  consent_id uuid not null,
  payment_method_id text not null check (btrim(payment_method_id) <> ''),
  stripe_customer_id text not null check (btrim(stripe_customer_id) <> ''),
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  constraint card_charge_attempts_invoice_owner_fk
    foreign key (user_id, invoice_id) references public.invoices(user_id, id),
  constraint card_charge_attempts_customer_owner_fk
    foreign key (user_id, customer_id) references public.customers(user_id, id),
  constraint card_charge_attempts_consent_owner_fk
    foreign key (consent_id, user_id, customer_id)
      references public.card_charge_consents(id, user_id, customer_id)
);

create table public.card_charge_attempt_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.card_charge_attempts(id),
  outcome text not null check (btrim(outcome) <> ''),
  stripe_payment_intent text,
  created_at timestamptz not null default now()
);

create index card_charge_attempt_events_attempt_idx
  on public.card_charge_attempt_events (attempt_id, created_at);

alter table public.card_charge_consents enable row level security;
alter table public.card_charge_attempts enable row level security;
alter table public.card_charge_attempt_events enable row level security;
revoke all on public.card_charge_consents, public.card_charge_attempts, public.card_charge_attempt_events
  from public, anon, authenticated;
grant select, insert, update on public.card_charge_consents to service_role;
grant select, insert on public.card_charge_attempts, public.card_charge_attempt_events to service_role;

create or replace function public.record_card_charge_consent(
  p_token text,
  p_enabled boolean,
  p_terms text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  c public.customers%rowtype;
  pm public.payment_methods%rowtype;
  cid uuid;
  uid uuid;
begin
  select customer_id, user_id into cid, uid
    from public.customer_portal_tokens
   where token = p_token and not revoked;
  if cid is null then return false; end if;

  -- This row lock serializes grant/revoke with claim_card_charge, which locks the
  -- same customer before reading active consent.
  select * into c
    from public.customers
   where id = cid and user_id = uid
   for update;
  if not found then return false; end if;

  if p_enabled then
    if p_terms is distinct from 'recurring-balance-v1' then return false; end if;
    select * into pm
      from public.payment_methods
     where customer_id = cid
       and user_id = uid
       and stripe_customer_id is not null
       and btrim(stripe_customer_id) <> ''
     order by is_default desc, created_at desc, id desc
     limit 1;
    if not found
       or c.stripe_customer_id is null
       or btrim(c.stripe_customer_id) = ''
       or pm.stripe_customer_id is distinct from c.stripe_customer_id then
      return false;
    end if;
  end if;

  update public.card_charge_consents
     set revoked_at = now()
   where customer_id = cid and user_id = uid and revoked_at is null;

  if p_enabled then
    insert into public.card_charge_consents (
      user_id, customer_id, payment_method_id, terms_version, scope,
      terms_text, amount_rule, evidence_source
    ) values (
      uid, cid, pm.stripe_payment_method_id, p_terms,
      'recurring_invoice_balance',
      'I authorize this business to charge my saved card for the outstanding balance of each recurring-service invoice after the completed visit, including applicable tax. This does not cover one-time jobs. I can stop future charges by turning AutoPay off before a charge starts. A charge already in progress may still complete.',
      'Outstanding balance of each recurring-service invoice after the completed visit, including applicable tax; no one-time jobs.',
      'customer_portal'
    );
  end if;

  update public.customers
     set autopay_enabled = p_enabled
   where id = cid and user_id = uid;
  return true;
end
$function$;

revoke all on function public.record_card_charge_consent(text, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_card_charge_consent(text, boolean, text)
  to service_role;

-- Legacy clients may still turn AutoPay off with a portal token, but cannot create
-- or revive authorization without the reviewed terms flow above.
create or replace function public.portal_set_autopay(p_token text, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
begin
  if p_enabled then return false; end if;
  return public.record_card_charge_consent(p_token, false, '');
end
$function$;

revoke all on function public.portal_set_autopay(text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.portal_set_autopay(text, boolean)
  to anon, authenticated, service_role;

-- Prevent owner UI or an older application build from restoring the legacy boolean
-- without durable, card-specific consent. claim_card_charge repeats every check.
create or replace function public.enforce_customer_autopay_consent()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.autopay_enabled and not exists (
    select 1
      from public.card_charge_consents consent
      join public.payment_methods method
        on method.user_id = consent.user_id
       and method.customer_id = consent.customer_id
       and method.stripe_payment_method_id = consent.payment_method_id
     where consent.user_id = new.user_id
       and consent.customer_id = new.id
       and consent.revoked_at is null
       and consent.terms_version = 'recurring-balance-v1'
       and consent.scope = 'recurring_invoice_balance'
       and method.stripe_customer_id is not null
       and method.stripe_customer_id = new.stripe_customer_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'active customer-portal card charge consent is required to enable AutoPay';
  end if;
  return new;
end
$function$;

revoke all on function public.enforce_customer_autopay_consent()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_enforce_customer_autopay_consent on public.customers;
create trigger trg_enforce_customer_autopay_consent
before insert or update of autopay_enabled on public.customers
for each row execute function public.enforce_customer_autopay_consent();

create or replace function public.claim_card_charge(
  p_invoice uuid,
  p_user uuid,
  p_customer uuid,
  p_method text,
  p_stripe_customer text,
  p_cents bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  i public.invoices%rowtype;
  c public.customers%rowtype;
  consent uuid;
  attempt uuid;
  gst numeric;
  cents bigint;
begin
  select * into i
    from public.invoices
   where id = p_invoice and user_id = p_user
   for update;
  if not found
     or i.status not in ('draft', 'unpaid', 'sent', 'partial')
     or i.customer_id is distinct from p_customer then
    return null;
  end if;

  if not exists (
    select 1 from public.jobs
     where id = i.job_id
       and user_id = p_user
       and customer_id = p_customer
       and recurrence_id is not null
       and status = 'completed'
  ) then
    return null;
  end if;

  select * into c
    from public.customers
   where id = p_customer and user_id = p_user
   for update;
  if not found
     or not coalesce(c.autopay_enabled, false)
     or c.stripe_customer_id is null
     or btrim(c.stripe_customer_id) = ''
     or c.stripe_customer_id is distinct from p_stripe_customer then
    return null;
  end if;

  if not exists (
    select 1 from public.payment_methods
     where customer_id = p_customer
       and user_id = p_user
       and stripe_payment_method_id = p_method
       and stripe_customer_id = p_stripe_customer
  ) then
    return null;
  end if;

  select id into consent
    from public.card_charge_consents
   where customer_id = p_customer
     and user_id = p_user
     and payment_method_id = p_method
     and revoked_at is null
     and terms_version = 'recurring-balance-v1'
     and scope = 'recurring_invoice_balance'
   order by granted_at desc, id desc
   limit 1;
  if consent is null then return null; end if;

  select gst_percent into gst
    from public.business_settings
   where user_id = p_user
   for share;
  if not found then return null; end if;

  cents := round((
    round(i.amount::numeric, 2)
    + round(round(i.amount::numeric, 2) * greatest(coalesce(gst, 0), 0) / 100, 2)
    - round(coalesce(i.amount_paid, 0)::numeric, 2)
  ) * 100);
  if cents <= 0 or cents is distinct from p_cents then return null; end if;

  -- Any existing positive Stripe evidence is treated as an ambiguous or completed
  -- earlier attempt and blocks a second charge, even if its local status is stale.
  if exists (
    select 1 from public.payments
     where invoice_id = p_invoice
       and user_id = p_user
       and amount > 0
       and stripe_payment_intent is not null
  ) then
    return null;
  end if;

  insert into public.card_charge_attempts (
    invoice_id, user_id, customer_id, consent_id,
    payment_method_id, stripe_customer_id, amount_cents
  ) values (
    p_invoice, p_user, p_customer, consent,
    p_method, p_stripe_customer, cents
  )
  on conflict (invoice_id) do nothing
  returning id into attempt;
  return attempt;
end
$function$;

revoke all on function public.claim_card_charge(uuid, uuid, uuid, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_card_charge(uuid, uuid, uuid, text, text, bigint)
  to service_role;

-- No legacy boolean is sufficient evidence of authorization. Reset every legacy
-- toggle so the customer must explicitly accept the versioned terms after release.
-- The current schema publishes customers with REPLICA IDENTITY FULL and includes a
-- stored generated phone_digits column. PostgreSQL 18 refuses every customer UPDATE
-- in that shape because generated columns are not part of the publication. Use the
-- stable customer primary key as its replica identity. No repository subscriber to
-- the customers table depends on a full old-row payload.
alter table public.customers replica identity default;
update public.customers
   set autopay_enabled = false
 where autopay_enabled = true;

-- Normalize the successful legacy AutoPay receipt key before the new webhook ships.
-- The preflight above guarantees this update cannot overwrite another row.
update public.payments
   set stripe_session_id = 'autopay-pi:' || stripe_payment_intent
 where stripe_session_id like 'autopay:%'
   and stripe_payment_intent is not null
   and amount > 0
   and coalesce(kind, 'payment') = 'payment'
   and coalesce(provider, 'stripe') <> 'credit';

create unique index payments_positive_stripe_intent_once
  on public.payments (stripe_payment_intent)
  where stripe_payment_intent is not null
    and amount > 0
    and coalesce(kind, 'payment') = 'payment'
    and coalesce(provider, 'stripe') <> 'credit';

commit;
