-- DISPOSABLE DATABASE FIXTURE ONLY. Never apply to a real Supabase project.
-- Run after the repository platform prelude, baseline and all migrations.
-- The harness bootstraps fictional auth identities as its database administrator,
-- then uses the prelude's service role for ordinary native business inserts.
-- No trigger, constraint, RLS policy or registration/capability switch is changed.
-- This is fixture provisioning, not evidence of a real signup/login ceremony.
--
-- Owner A  00000000-0000-4000-8000-0000000000a1
-- Owner B  00000000-0000-4000-8000-0000000000b1
-- Customer A/B ...00a2 / ...00b2 deliberately share one email across tenants.
-- Quote A1/A2/B1 ...00a3 / ...00a4 / ...00b3.
-- No connections, provider grants, workflows, messages, acceptances or invoices.

begin;

insert into auth.users (id, email, email_confirmed_at)
values
  ('00000000-0000-4000-8000-0000000000a1', 'owner-a@business.example.invalid', now()),
  ('00000000-0000-4000-8000-0000000000b1', 'owner-b@business.example.invalid', now());

set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- NULL terms are deliberate: no payment-timing claim is invented for the fixture.
-- Canonical quote_terms_fingerprint still supplies the current empty-terms hash.
insert into public.business_settings
  (user_id, company_name, owner_name, email_primary, business_type, timezone, terms_text)
values
  ('00000000-0000-4000-8000-0000000000a1', 'Fictional Service A', 'Owner A',
   'owner-a@business.example.invalid', 'general', 'America/Edmonton', null),
  ('00000000-0000-4000-8000-0000000000b1', 'Fictional Service B', 'Owner B',
   'owner-b@business.example.invalid', 'general', 'America/Edmonton', null);

insert into public.customers
  (id, user_id, name, email, email_opt_in, sms_opt_in, message_prefs, preferred_channel)
values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1',
   'Fictional Customer A', 'shared@customer.example.invalid', true, false,
   '{"estimates":true}'::jsonb, 'email'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b1',
   'Fictional Customer B', 'shared@customer.example.invalid', true, false,
   '{"estimates":true}'::jsonb, 'email');

insert into public.quotes
  (id, user_id, customer_id, quote_number, customer_name, address, service_type,
   initial_price, travel_fee, status, sent_at, issued_date, valid_until)
values
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000a2', 'FIXTURE-A-1', 'Fictional Customer A',
   '1 Fictional Fixture Lane', 'General service visit', 100, 0, 'sent',
   now() - interval '7 days', current_date - 7, current_date + 30),
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000a2', 'FIXTURE-A-2', 'Fictional Customer A',
   '2 Fictional Fixture Lane', 'Another service visit', 200, 0, 'sent',
   now() - interval '7 days', current_date - 7, current_date + 30),
  ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-0000000000b2', 'FIXTURE-B-1', 'Fictional Customer B',
   '3 Fictional Fixture Lane', 'General service visit', 150, 0, 'sent',
   now() - interval '7 days', current_date - 7, current_date + 30);

commit;
