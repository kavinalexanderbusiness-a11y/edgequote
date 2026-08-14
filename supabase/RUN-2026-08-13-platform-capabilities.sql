-- ── Platform capabilities — what the PLATFORM permits a tenant to use ─────────
-- Session 43 (2026-08-13). Private-beta tenant safety.
--
-- THE PROBLEM. The deployment has exactly one Stripe account, one Twilio number
-- and one Resend sending identity — all of them belong to the founding business.
-- Every gate in the app (`stripeEnabled()`, `commsEnabled()`) asks "does the
-- DEPLOYMENT have this key?", which answers wrongly the moment a second business
-- exists: a beta tenant's Pay button would settle money into the founding
-- tenant's Stripe balance, its texts would go out from the founding tenant's
-- number, and inbound SMS resolved customers GLOBALLY (release-gate C4).
--
-- THE CONTRACT.
--   • One row per tenant that has been granted anything. A MISSING row means NO
--     shared-infrastructure capabilities — every future tenant is restricted by
--     construction, not by remembering to restrict them.
--   • The app only ever READS this table. There is deliberately no INSERT/UPDATE
--     path from any signed-in role: granting a capability is a platform operation
--     (SQL by the operator), because these bits decide whose money and whose
--     sending identity a tenant can touch. This is the same reasoning that keeps
--     plan state off business_settings (PLATFORM-BILLING-ADR): an owner-writable
--     row here would be self-serve access to another business's Stripe account.
--   • NOT capabilities: things a business composes for itself (enabled_modules),
--     things that are theirs alone (offline payment recording, quotes, portal).
--     This table gates only what is SHARED across the deployment.

create table if not exists public.platform_capabilities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- May this tenant mint Stripe checkouts / save cards / AutoPay? Money settles
  -- into the deployment's ONE Stripe account, so only its owner may hold this.
  online_payments boolean not null default false,
  -- May inbound SMS on the shared Twilio number resolve to this tenant's
  -- customers? (find_inbound_sms_customer below joins on this.)
  inbound_sms boolean not null default false,
  -- May this tenant send SMS from the shared Twilio number?
  outbound_sms boolean not null default false,
  -- May this tenant send email from the shared Resend identity?
  outbound_email boolean not null default false,
  -- Operator note: WHY this tenant holds these grants.
  note text,
  updated_at timestamptz not null default now()
);

comment on table public.platform_capabilities is
  'Platform-managed grants for SHARED deployment infrastructure (Stripe account, Twilio number, Resend identity). Missing row = no grants. App code reads only; rows are written by the platform operator in SQL.';

alter table public.platform_capabilities enable row level security;

-- A business may SEE its own grants (so the UI can say "not enabled for this
-- business" instead of pretending a button works). Nothing else: no INSERT, no
-- UPDATE, no DELETE policy exists for any app role, so RLS offers no write path
-- even before the grant revocations below.
drop policy if exists "capabilities: read own" on public.platform_capabilities;
create policy "capabilities: read own" on public.platform_capabilities
  for select to authenticated using (user_id = auth.uid());

-- Belt AND braces: revoke the table-level privileges too. Supabase's ALTER
-- DEFAULT PRIVILEGES hands anon/authenticated full grants on every new table
-- (the trap documented in quote-options: revoking "from public" alone leaves
-- those standing). service_role keeps its grants — it is the platform's hand.
revoke all on table public.platform_capabilities from anon, authenticated;
grant select on table public.platform_capabilities to authenticated;

-- ── Seed: the founding tenant keeps exactly what it uses today ────────────────
-- The one hardcoded UUID in this design lives HERE, as platform data — never in
-- application code. Edge Property Services owns the deployment's Stripe account,
-- Twilio number and Resend identity, so it holds all four grants.
insert into public.platform_capabilities
  (user_id, online_payments, inbound_sms, outbound_sms, outbound_email, note)
values
  ('a12a0549-7210-4b6c-829e-3ed9feb380b3', true, true, true, true,
   'Founding tenant (Edge Property Services) — owns the deployment''s Stripe account, Twilio number and Resend sending identity.')
on conflict (user_id) do nothing;

-- ── THE inbound-SMS resolver, scoped to capable tenants ───────────────────────
-- Replaces find_customer_by_phone for the Twilio webhook. The old function
-- resolved a phone number across EVERY tenant (`order by created_at desc limit
-- 1`, no user_id filter) — harmless with one tenant, cross-tenant message
-- disclosure the day two businesses share a customer, and STOP flipped whichever
-- tenant added the number most recently.
--
-- This is NOT "guess the tenant from the phone". The resolution set is
-- structurally restricted to tenants the platform has granted inbound_sms —
-- today exactly one, the tenant whose number this actually is. A message from a
-- phone known only to a non-granted tenant resolves to nothing and is stored
-- nowhere, which is the honest outcome: that tenant does not receive SMS here.
-- (Recency ordering only matters again if a second tenant is ever granted
-- inbound_sms — which is exactly the per-tenant-number decision the grant forces
-- someone to make first.)
create or replace function public.find_inbound_sms_customer(p_phone text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d text; result json;
begin
  d := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(d) < 10 then return null; end if;
  select to_json(c) into result from (
    select cu.id, cu.user_id, cu.sms_opt_in, cu.name
    from public.customers cu
    join public.platform_capabilities pc
      on pc.user_id = cu.user_id and pc.inbound_sms
    where cu.phone is not null
      and right(regexp_replace(cu.phone, '\D', '', 'g'), 10) = d
    order by cu.created_at desc limit 1
  ) c;
  return result;
end; $function$;

-- Webhook-only, same posture the old resolver was locked down to (C4 fix):
-- callable by the service role alone. Read pg_proc.proacl BACK after applying —
-- "revoke from public" without these three is the standing-default-grants trap.
revoke execute on function public.find_inbound_sms_customer(text) from public, anon, authenticated;
grant execute on function public.find_inbound_sms_customer(text) to service_role;

-- find_customer_by_phone is left in place (already service-role-only in prod)
-- but is now UNREFERENCED by the app. Dropping it is a separate, deliberate
-- operator step — not done here because this file must be safe to re-run.
