-- ── Two SECURITY DEFINER functions were reachable by the public ──────────────
-- 2026-08-10 · tenant-boundary audit
--
-- Supabase's DEFAULT PRIVILEGES grant EXECUTE on every new public function to
-- `anon` and `authenticated` at CREATE time. For a SECURITY DEFINER function
-- owned by `postgres` (which has rolbypassrls), that grant is not cosmetic: it
-- hands an unauthenticated caller a function that reads and writes with RLS
-- switched off. Both functions below were created without an explicit revoke,
-- so both were callable straight off the public REST surface
-- (/rest/v1/rpc/<name>) using the anon key that ships in every browser bundle.
--
-- Both were REPRODUCED against production inside rolled-back transactions
-- before this migration was written, and both exploits were replayed and
-- confirmed DEAD afterwards.
--
-- ⚠️⚠️ THE GRANT GOTCHA, corrected here — the earlier crew-mode note in this
-- repo said "revoke by role name; `revoke … from public` does NOT remove it".
-- That is only half true, and the half that is missing is the dangerous half.
-- The real ACL on find_customer_by_phone was:
--     {=X/postgres, postgres=X/postgres, anon=X/postgres,
--      authenticated=X/postgres, service_role=X/postgres}
-- The leading `=X/postgres` is a grant to **PUBLIC** (empty grantee). Revoking
-- `from anon, authenticated` left it standing, and `has_function_privilege
-- ('anon', …)` still answered TRUE — the first attempt at this migration was
-- caught by its own verify block for exactly that reason. Some functions carry
-- a PUBLIC grant, some carry per-role grants, and a few carry both. So:
--     ALWAYS revoke from `public, anon, authenticated` — and then ASSERT with
--     has_function_privilege() rather than trusting the revoke.
--
-- ── 1. find_customer_by_phone(text) — PII oracle ─────────────────────────────
-- Proven as `anon`: passing a 10-digit phone returned that customer's `name`,
-- `id`, `sms_opt_in` AND `user_id` — i.e. which business they belong to — while
-- a direct `select from customers` as the same role correctly returned 0 rows.
-- Anyone able to guess or harvest a phone number could confirm "is this person
-- a customer of this business, and what is their name". With a second tenant it
-- also becomes a cross-tenant lookup, because the function searches EVERY
-- business's customers.
--
-- The only caller in the app is the Twilio inbound-SMS webhook
-- (src/app/api/sms/inbound/route.ts), which builds a SERVICE-ROLE client — and
-- service_role keeps its grant. So this revoke is zero-impact on the product.
--
-- ⚠️ NOT fixed here, deliberately: the function still matches phones across all
-- businesses. That is correct for one tenant sharing one Twilio number, and the
-- right multi-tenant answer (per-tenant numbers, or scoping the match to the
-- number that received the message) is a product decision, not a security patch.
revoke execute on function public.find_customer_by_phone(text) from public, anon, authenticated;

-- ── 2. ensure_pricing_config_version(uuid) — RLS-bypass write primitive ──────
-- Takes the TARGET USER as a parameter and writes a pricing_config_versions row
-- for them. Proven by impersonating the real CREW member — an account that
-- reads 0 rows from jobs, customers, invoices, payments, roster and settings —
-- who called it with the OWNER's uuid and drove the owner's version count from
-- 3 to 4. `anon` held the same grant.
--
-- The legitimate caller is the owner's own browser (lib/pricingConfig.ts) with
-- their own id, plus any service-role path. So:
--   • revoke anon entirely — it has no business recording pricing history;
--   • keep `authenticated`, but make the function refuse to act for anyone
--     other than the caller. auth.uid() is NULL under service_role, so trusted
--     server paths are unaffected; a signed-in user may only ever target self.
-- Returning NULL (not raising) matches the function's existing contract — every
-- other refusal path already returns NULL, and the one caller treats a null as
-- "version not recorded" and self-heals on the next quote write.
revoke execute on function public.ensure_pricing_config_version(uuid) from public, anon;

create or replace function public.ensure_pricing_config_version(p_user uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  s    record;
  w    record;
begin
  if p_user is null then return null; end if;

  -- TENANT GUARD (2026-08-10). A signed-in caller may only record a version for
  -- THEMSELVES. auth.uid() is null for service_role/trigger contexts, which are
  -- already privileged and keep working. Without this, EXECUTE alone let any
  -- authenticated account — including a crew member with zero table access —
  -- write into another business's pricing history.
  if auth.uid() is not null and p_user is distinct from auth.uid() then
    return null;
  end if;

  select
    case when coalesce(pricing_base_charge, 0) > 0      then pricing_base_charge      else 28  end as base_charge,
    case when coalesce(pricing_mow_rate, 0) > 0         then pricing_mow_rate         else 15  end as mow_rate_per_1000,
    0.8::numeric  as budget_mult,
    0.92::numeric as market_mult,
    case when coalesce(pricing_recommended_mult, 0) > 0 then pricing_recommended_mult else 1.0 end as recommended_mult,
    case when coalesce(pricing_premium_mult, 0) > 0     then pricing_premium_mult     else 1.2 end as premium_mult,
    case when coalesce(pricing_travel_rate, 0) > 0      then pricing_travel_rate      else 1.5 end as travel_rate_per_km,
    coalesce(crew_cost_per_hour, 40)                        as crew_cost_per_hour,
    coalesce(fee_recovery_percent, 3)                       as fee_recovery_percent,
    coalesce(payment_fee_strategy, 'global_price_increase') as payment_fee_strategy
  into w
  from public.business_settings where user_id = p_user;

  if not found then return null; end if;

  select * into s from public.pricing_config_versions
   where user_id = p_user order by valid_from desc limit 1;

  if found
     and s.engine_version = 'v1'
     and s.base_charge          = w.base_charge
     and s.mow_rate_per_1000    = w.mow_rate_per_1000
     and s.budget_mult          = w.budget_mult
     and s.market_mult          = w.market_mult
     and s.recommended_mult     = w.recommended_mult
     and s.premium_mult         = w.premium_mult
     and s.travel_rate_per_km   = w.travel_rate_per_km
     and s.crew_cost_per_hour   = w.crew_cost_per_hour
     and s.fee_recovery_percent = w.fee_recovery_percent
     and s.payment_fee_strategy = w.payment_fee_strategy
  then
    return s.id;
  end if;

  insert into public.pricing_config_versions (
    user_id, valid_from, source, note, engine_version,
    base_charge, mow_rate_per_1000, budget_mult, market_mult,
    recommended_mult, premium_mult, travel_rate_per_km,
    crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy
  ) values (
    p_user, now(), 'recorded', 'Recorded by ensure_pricing_config_version on a detected settings change.', 'v1',
    w.base_charge, w.mow_rate_per_1000, w.budget_mult, w.market_mult,
    w.recommended_mult, w.premium_mult, w.travel_rate_per_km,
    w.crew_cost_per_hour, w.fee_recovery_percent, w.payment_fee_strategy
  ) returning id into v_id;

  return v_id;
end;
$function$;

-- `create or replace` resets the ACL to the default grants, so re-revoke AFTER
-- the redefinition. (Ordering matters: the revoke above alone would be undone.)
revoke execute on function public.ensure_pricing_config_version(uuid) from public, anon;

-- ── Proof, in the same transaction ───────────────────────────────────────────
do $verify$
declare
  v_anon_can_phone   boolean;
  v_anon_can_pricing boolean;
begin
  select has_function_privilege('anon', 'public.find_customer_by_phone(text)', 'EXECUTE')
    into v_anon_can_phone;
  select has_function_privilege('anon', 'public.ensure_pricing_config_version(uuid)', 'EXECUTE')
    into v_anon_can_pricing;

  if v_anon_can_phone then
    raise exception 'find_customer_by_phone is STILL executable by anon';
  end if;
  if v_anon_can_pricing then
    raise exception 'ensure_pricing_config_version is STILL executable by anon';
  end if;
  if not has_function_privilege('service_role', 'public.find_customer_by_phone(text)', 'EXECUTE') then
    raise exception 'service_role LOST find_customer_by_phone — the inbound SMS webhook would break';
  end if;

  raise notice 'verified: anon can execute neither function; service_role retains both';
end
$verify$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ── 3. CRITICAL: crew → owner escalation → owner account takeover ────────────
-- Found by the same audit, and the most severe finding in it. Two defects that
-- are each survivable alone and fatal together:
--
--   A. current_app_role() calls anyone with a business_settings row an 'owner',
--      and RLS lets ANY authenticated user insert that row for their own uid.
--      REPRODUCED: impersonating the real crew member (an account that reads 0
--      rows from jobs/customers/invoices/payments/roster/settings), a single
--      INSERT flipped current_app_role() from 'crew' to 'owner'.
--
--   B. /api/crew/invite is gated on role==='owner', then mints a Supabase
--      `recovery` token for whatever email it is given and RETURNS it to the
--      caller. Its only collision check refused addresses already bound to a
--      DIFFERENT technician — but a business owner's auth account is not a
--      technician at all, so a victim owner's email passed straight through.
--
-- Chained: crew self-promotes (A) → creates a technician on their own new
-- "business" → invites it with the victim owner's email → the response contains
-- a password-reset token for the victim's account. Full takeover, reachable
-- today by the one crew account that exists in production. After A is closed it
-- remains reachable between any two legitimately signed-up businesses, which is
-- why B is fixed in the route as well (see src/app/api/crew/invite/route.ts).
--
-- These two triggers close the DB half. Both are SECURITY DEFINER so they can
-- see rows the caller's RLS hides — a policy subquery could not.
create or replace function public.guard_business_settings_owner()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  -- crew_redeem_invite already refuses the reverse direction ("this account owns
  -- a business — it cannot also join one as crew"). This is the missing mirror.
  if exists (select 1 from public.technicians t where t.auth_user_id = new.user_id) then
    raise exception 'this account is linked to an employee record and cannot own a business'
      using errcode = '42501';
  end if;
  return new;
end $fn$;

drop trigger if exists business_settings_no_crew_owner on public.business_settings;
create trigger business_settings_no_crew_owner
  before insert on public.business_settings
  for each row execute function public.guard_business_settings_owner();

create or replace function public.guard_technician_auth_link()
returns trigger language plpgsql security definer set search_path to 'public','pg_temp' as $fn$
begin
  -- auth_user_id is the employee's IDENTITY LINK. Only the flows that prove
  -- consent or ownership may write it: crew_redeem_invite / crew_revoke_access
  -- (SECURITY DEFINER, so current_user is postgres) and the owner-authenticated
  -- invite route (service_role). Left client-writable, an "owner" could forge a
  -- link to a stranger's auth account and have the invite route mint a recovery
  -- token for it — which is exactly the carve-out the route now relies on.
  if current_user in ('postgres', 'service_role', 'supabase_admin') then return new; end if;
  if tg_op = 'INSERT' and new.auth_user_id is not null then
    raise exception 'auth_user_id is set by the invite/join flow, not written directly'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'auth_user_id is set by the invite/join flow, not written directly'
      using errcode = '42501';
  end if;
  return new;
end $fn$;

drop trigger if exists technicians_auth_link_guard on public.technicians;
create trigger technicians_auth_link_guard
  before insert or update on public.technicians
  for each row execute function public.guard_technician_auth_link();

-- ═════════════════════════════════════════════════════════════════════════════
-- ── 4. Storage: anonymous ENUMERATION of every tenant's files ────────────────
-- REPRODUCED as `anon`: listed all 61 job-photos objects and all 19
-- booking-uploads objects. Two things fell out of that listing:
--   • the OWNER'S UID, which is the first path segment of every job photo; and
--   • the raw 64-char booking_token, which is the top-level folder name in
--     booking-uploads and the tenant credential for the public booking API
--     (submit_booking / public_services / public_availability).
-- Those two together fed the branding hole below.
--
-- WHY THIS IS SAFE TO REVOKE: a bucket marked `public: true` serves
-- /storage/v1/object/public/<bucket>/<path> WITHOUT consulting RLS. The SELECT
-- policy on storage.objects governs LIST and the object API instead. The repo
-- contains ZERO .list() calls on any bucket and every read path is
-- getPublicUrl, so portal photos, PDFs and the marketing studio are unaffected.
-- Verified after applying: anon lists 0/0/0, the owner still lists 61 photos
-- and 1 logo, and the anonymous booking upload policy is untouched.
drop policy if exists "job-photos: read" on storage.objects;
create policy "job-photos: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = (auth.uid())::text);

drop policy if exists "booking_uploads_public_read" on storage.objects;
create policy "booking-uploads: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'booking-uploads');

-- branding: SELECT/INSERT/UPDATE were scoped by bucket_id ALONE, so ANY
-- authenticated account — the crew member included, today — could overwrite
-- another business's logo at `<their-uid>/logo.png`, and that uid is precisely
-- what the job-photos listing was handing out. The logo renders on every quote,
-- invoice, PDF and portal page, so this was a live brand-hijack primitive.
-- The app already writes `${user.id}/logo.<ext>`, so folder scoping matches.
drop policy if exists "branding read" on storage.objects;
drop policy if exists "branding upload" on storage.objects;
drop policy if exists "branding update" on storage.objects;
create policy "branding: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'branding' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "branding: insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branding' and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "branding: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and (storage.foldername(name))[1] = (auth.uid())::text)
  with check (bucket_id = 'branding' and (storage.foldername(name))[1] = (auth.uid())::text);

-- lead-uploads: anon-readable, and no reader or writer anywhere in the repo.
-- Dropped while it is provably empty rather than left for its first upload.
do $lead$
declare n int;
begin
  select count(*) into n from storage.objects where bucket_id='lead-uploads';
  if n > 0 then
    raise exception 'lead-uploads is no longer empty (% objects) — re-audit before revoking', n;
  end if;
  drop policy if exists "lead_uploads_public_read" on storage.objects;
end $lead$;

-- Proof: the ONLY anon storage policy left is the booking form's upload.
do $storage_verify$
declare n int; names text;
begin
  select count(*), coalesce(string_agg(policyname, ', '), '')
    into n, names
    from pg_policies where schemaname='storage' and roles::text like '%anon%';
  if n <> 1 or names <> 'booking_uploads_public_insert' then
    raise exception 'unexpected anon storage policies: % (%)', n, names;
  end if;
  raise notice 'verified: anon may upload a booking photo and nothing else';
end $storage_verify$;
