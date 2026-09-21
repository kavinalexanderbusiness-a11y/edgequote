begin;
-- REVIEW ONLY. Not applied. Promote with Supabase migration tooling after review.
-- Claims are permanent: no automatic retry after error, timeout or process crash.
create table public.card_charge_consents (
 id uuid primary key default gen_random_uuid(), user_id uuid not null,
 customer_id uuid not null references public.customers(id), payment_method_id text not null,
 terms_version text not null, scope text not null check(scope='recurring_invoice_balance'),
 terms_text text not null, amount_rule text not null, evidence_source text not null check(evidence_source='customer_portal'),
 granted_at timestamptz not null default now(), revoked_at timestamptz
);
create table public.card_charge_attempts (
 id uuid primary key default gen_random_uuid(), invoice_id uuid not null unique references public.invoices(id),
 user_id uuid not null, customer_id uuid not null, consent_id uuid not null references public.card_charge_consents(id),
 payment_method_id text not null, stripe_customer_id text not null,
 amount_cents bigint not null check(amount_cents>0), created_at timestamptz not null default now()
);
alter table public.card_charge_consents enable row level security;
alter table public.card_charge_attempts enable row level security;
revoke all on public.card_charge_consents,public.card_charge_attempts from public,anon,authenticated;
grant select,insert,update on public.card_charge_consents to service_role;
grant select,insert on public.card_charge_attempts to service_role;

create or replace function public.record_card_charge_consent(p_token text,p_enabled boolean,p_terms text)
returns boolean language plpgsql security definer set search_path=public as $$
declare c public.customers%rowtype; pm public.payment_methods%rowtype; cid uuid; uid uuid;
begin
 select customer_id,user_id into cid,uid from public.customer_portal_tokens where token=p_token and not revoked;
 if cid is null then return false; end if;
 select * into c from public.customers where id=cid and user_id=uid for update;
 if not found then return false; end if;
 if p_enabled then
  if p_terms is distinct from 'recurring-balance-v1' then return false; end if;
  select * into pm from public.payment_methods where customer_id=cid and user_id=uid order by is_default desc,created_at desc limit 1;
  if not found or pm.stripe_customer_id is distinct from c.stripe_customer_id then return false; end if;
 end if;
 update public.card_charge_consents set revoked_at=now() where customer_id=cid and user_id=uid and revoked_at is null;
 if p_enabled then
  insert into public.card_charge_consents(user_id,customer_id,payment_method_id,terms_version,scope,terms_text,amount_rule,evidence_source)
  values(uid,cid,pm.stripe_payment_method_id,p_terms,'recurring_invoice_balance',
   'I authorize this business to charge my saved card for the outstanding balance of each recurring-service invoice after the completed visit, including applicable tax. This does not cover one-time jobs. I can stop future charges by turning AutoPay off before a charge starts. A charge already in progress may still complete.',
   'Outstanding balance of each recurring-service invoice after the completed visit, including applicable tax; no one-time jobs.','customer_portal');
 end if;
 update public.customers set autopay_enabled=p_enabled where id=cid and user_id=uid;
 return true;
end $$;
revoke all on function public.record_card_charge_consent(text,boolean,text) from public,anon,authenticated;
grant execute on function public.record_card_charge_consent(text,boolean,text) to service_role;
-- Legacy API may disable only. It cannot create or revive authorization.
create or replace function public.portal_set_autopay(p_token text,p_enabled boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_enabled then return false; end if;
 return public.record_card_charge_consent(p_token,false,'');
end $$;

create or replace function public.claim_card_charge(p_invoice uuid,p_user uuid,p_customer uuid,p_method text,p_stripe_customer text,p_cents bigint)
returns uuid language plpgsql security definer set search_path=public as $$
declare i public.invoices%rowtype; c public.customers%rowtype; consent uuid; attempt uuid; gst numeric; cents bigint;
begin
 select * into i from public.invoices where id=p_invoice and user_id=p_user for update;
 if not found or i.status not in ('draft','sent','partial','overdue') or i.customer_id is distinct from p_customer then return null; end if;
 if not exists(select 1 from public.jobs where id=i.job_id and user_id=p_user and customer_id=p_customer and recurrence_id is not null and status='completed') then return null; end if;
 select * into c from public.customers where id=p_customer and user_id=p_user for update;
 if not found or not coalesce(c.autopay_enabled,false) or c.stripe_customer_id is distinct from p_stripe_customer then return null; end if;
 if not exists(select 1 from public.payment_methods where customer_id=p_customer and user_id=p_user and stripe_payment_method_id=p_method and stripe_customer_id=p_stripe_customer) then return null; end if;
 select id into consent from public.card_charge_consents where customer_id=p_customer and user_id=p_user and payment_method_id=p_method
 and revoked_at is null and terms_version='recurring-balance-v1' and scope='recurring_invoice_balance' order by granted_at desc limit 1;
 if consent is null then return null; end if;
 select gst_percent into gst from public.business_settings where user_id=p_user for share;
 if not found then return null; end if;
 cents:=round((round(i.amount::numeric,2)+round(round(i.amount::numeric,2)*greatest(coalesce(gst,0),0)/100,2)-round(coalesce(i.amount_paid,0)::numeric,2))*100);
 if cents<=0 or cents is distinct from p_cents then return null; end if;
 if exists(select 1 from public.payments where invoice_id=p_invoice and user_id=p_user and amount>0 and stripe_payment_intent is not null) then return null; end if;
 insert into public.card_charge_attempts(invoice_id,user_id,customer_id,consent_id,payment_method_id,stripe_customer_id,amount_cents)
 values(p_invoice,p_user,p_customer,consent,p_method,p_stripe_customer,cents)
 on conflict(invoice_id) do nothing returning id into attempt;
 return attempt;
end $$;
revoke all on function public.claim_card_charge(uuid,uuid,uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.claim_card_charge(uuid,uuid,uuid,text,text,bigint) to service_role;
-- Normalize legacy receipts BEFORE deploying webhook. Collision aborts migration;
-- reconcile rather than deleting evidence. Credit/refund mirror rows untouched.
update public.payments set stripe_session_id='autopay-pi:'||stripe_payment_intent
 where stripe_session_id like 'autopay:%' and stripe_payment_intent is not null and amount>0;
create unique index payments_successful_stripe_intent_once on public.payments(stripe_payment_intent)
 where stripe_payment_intent is not null and amount>0 and coalesce(kind,'payment')='payment' and coalesce(provider,'stripe')<>'credit';
-- Append-only processor outcome audit. A missing event means the claimed attempt
-- needs reconciliation (e.g. crash); no event reopens an invoice for retry.
create table public.card_charge_attempt_events (
 id uuid primary key default gen_random_uuid(), attempt_id uuid not null references public.card_charge_attempts(id),
 outcome text not null, stripe_payment_intent text, created_at timestamptz not null default now()
);
alter table public.card_charge_attempt_events enable row level security;
revoke all on public.card_charge_attempt_events from public,anon,authenticated;
grant select,insert on public.card_charge_attempt_events to service_role;

commit;
