-- ── Self-service registration — the schema prerequisite ─────────────────────
-- 20260905191549_self_service_registration.sql
--
-- ⛔ NOT APPLIED. S106 applies after exact approval, re-checking this version
--    against the live ledger first (production's head was 20260830150000 when
--    this file was minted with `supabase migration new`).
--
-- WHAT THIS IS
-- Public sign-up: a person with a VERIFIED email can create a business without
-- an operator-issued invite. The gate stays exactly where it is — the
-- business_settings INSERT policy carries can_provision_business() — and gains a
-- THIRD licence, behind an operator switch that this migration inserts CLOSED.
-- Applying this file changes no behaviour for any account.
--
-- WHY THE SWITCH IS A TABLE ROW, NOT A CODE FLAG
-- GoTrue's public signup endpoint is enabled at the API level, so the policy is
-- the only thing between an API-created, self-verified account and a tenant. A
-- code flag would open that door at deploy time — before the sign-up UI, the
-- throttles and the copy exist. A service-role row opens and closes it in ONE
-- statement, without a deploy, and records who/why (opened_at, note). Same
-- trust shape as platform_capabilities: operator SQL writes it, the app reads.
--
-- THE ONE DECISION — provisioning_status(), first match wins:
--   not-signed-in     auth.uid() is null
--   already-owner     a business_settings row exists           → licensed (grandfather)
--   crew-account      ANY technicians.auth_user_id link        → never (mirrors the INSERT trigger)
--   invited           beta_invites.redeemed_by = auth.uid()    → licensed (unchanged)
--   email-unverified  auth.users.email_confirmed_at is null
--   self-service      the switch is open                       → licensed (NEW)
--   closed            otherwise
-- can_provision_business() = status IN (already-owner, invited, self-service).
-- One engine: the policy, the app's routing and the error a user sees all come
-- from the same function, so they cannot disagree.
--
-- WHAT IS NOT HERE
-- No capability grant: a self-service tenant has no platform_capabilities row,
-- so no shared email/SMS/payments — that boundary is untouched. No billing, no
-- trial. No change to claim_beta_invite(), beta_invites or the invite routes.
-- No user_metadata anywhere: the only identity fact read is
-- auth.users.email_confirmed_at, which GoTrue sets server-side (verifyOtp for
-- email sign-ups; the provider's verified email for OAuth) and no client can write.

-- ── 1. the operator switch ───────────────────────────────────────────────────
create table if not exists public.platform_registration (
  id boolean primary key default true,
  self_service_open boolean not null default false,
  opened_at timestamptz,
  note text,
  updated_at timestamptz not null default now(),
  constraint platform_registration_single_row check (id)
);
alter table public.platform_registration enable row level security;
-- Zero policies on purpose: nothing but the service role reads or writes this
-- row. Default privileges would otherwise hand anon/authenticated full access
-- (docs/MIGRATIONS.md, "the grants trap") — revoke first, then grant back.
revoke all on table public.platform_registration from public, anon, authenticated, service_role;
grant all on table public.platform_registration to service_role;
comment on table public.platform_registration is
  'The public sign-up switch. One row. self_service_open=false means a verified email alone does not license a business. Service-role only (RLS on, zero policies): the operator opens it with an UPDATE; the app never writes it.';
-- Born closed. The operator opens it later with:
--   update public.platform_registration set self_service_open = true, opened_at = now(), note = '…' where id;
insert into public.platform_registration (id, self_service_open) values (true, false)
  on conflict (id) do nothing;

-- ── 2. the single decision ───────────────────────────────────────────────────
create or replace function public.provisioning_status()
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid       uuid := auth.uid();
  v_confirmed timestamptz;
begin
  if v_uid is null then
    return 'not-signed-in';
  end if;
  -- Owner already: the grandfather licence every settings UPSERT relies on.
  if exists (select 1 from public.business_settings b where b.user_id = v_uid) then
    return 'already-owner';
  end if;
  -- Mirrors guard_business_settings_owner() exactly — ANY technician link,
  -- active or not — so the answer here is the answer the INSERT trigger gives.
  if exists (select 1 from public.technicians t where t.auth_user_id = v_uid) then
    return 'crew-account';
  end if;
  -- The invite licence, unchanged: redemption already required a verified email.
  if exists (select 1 from public.beta_invites i where i.redeemed_by = v_uid) then
    return 'invited';
  end if;
  -- The only identity fact this function reads.
  select u.email_confirmed_at into v_confirmed from auth.users u where u.id = v_uid;
  if v_confirmed is null then
    return 'email-unverified';
  end if;
  -- A missing switch row reads as closed.
  if coalesce((select r.self_service_open from public.platform_registration r where r.id), false) then
    return 'self-service';
  end if;
  return 'closed';
end
$function$;
revoke all on function public.provisioning_status() from public, anon, authenticated, service_role;
grant execute on function public.provisioning_status() to authenticated;
grant execute on function public.provisioning_status() to service_role;
comment on function public.provisioning_status() is
  'Why this signed-in account may or may not create a business: not-signed-in | already-owner | crew-account | invited | email-unverified | self-service | closed. Read-only; can_provision_business() and the app both derive from it.';

-- ── 3. the gate, derived from the decision ───────────────────────────────────
-- The policy text is untouched: "settings: insert own" still carries
-- can_provision_business(); only its body changes, and CREATE OR REPLACE keeps
-- its ACL. Restated anyway so what may execute it is written down here.
create or replace function public.can_provision_business()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select public.provisioning_status() in ('already-owner', 'invited', 'self-service')
$function$;
revoke all on function public.can_provision_business() from public, anon, authenticated, service_role;
grant execute on function public.can_provision_business() to authenticated;
grant execute on function public.can_provision_business() to service_role;

-- ── 4. read back what was just claimed ───────────────────────────────────────
-- Applies only if every claim above is true in THIS database; otherwise the
-- whole file rolls back with the reason.
do $$
begin
  if has_function_privilege('anon', 'public.provisioning_status()', 'execute') then
    raise exception 'provisioning_status() is executable by anon';
  end if;
  if has_function_privilege('anon', 'public.can_provision_business()', 'execute') then
    raise exception 'can_provision_business() is executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.provisioning_status()', 'execute') then
    raise exception 'provisioning_status() must be executable by authenticated';
  end if;
  if has_table_privilege('anon', 'public.platform_registration', 'select')
     or has_table_privilege('authenticated', 'public.platform_registration', 'select')
     or has_table_privilege('authenticated', 'public.platform_registration', 'update') then
    raise exception 'platform_registration is reachable by a client role';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'platform_registration') <> 0 then
    raise exception 'platform_registration must have zero policies';
  end if;
  if (select self_service_open from public.platform_registration where id) is distinct from false then
    raise exception 'the switch must be born CLOSED';
  end if;
end $$;
