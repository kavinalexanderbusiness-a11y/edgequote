-- =============================================================================
-- INVITE-ONLY BETA SIGNUP + TENANT PROVISIONING V1 (2026-08-13)
-- IDEMPOTENT. Safe to re-run.
--
-- WHAT THIS CLOSES. business_settings had a bare `auth.uid() = user_id` INSERT
-- policy, and "has a business_settings row" IS the definition of 'owner'
-- (current_app_role, RUN-2026-08-07-crew-mode.sql). The public GoTrue signup
-- endpoint is enabled (disable_signup:false, measured 2026-08-13), so any
-- stranger who minted a bare auth account could self-provision a whole tenant
-- with one browser upsert. Gating the front door in the UI alone would be
-- theatre; the gate lives here, on the row that makes someone an owner.
--
-- THE MODEL. beta_invites: one row per hand-issued invite. The URL token is
-- 32 random bytes (eqb_ + 64 hex); ONLY its sha256 hex is stored — the
-- api_keys precedent (RUN-2026-07-15-integrations-platform.sql), deliberately
-- NOT the crew join-code's plaintext random(). Lifecycle:
--
--   open ──(signup route creates the auth account)──> reserved
--        ──(claim runs with a VERIFIED email)───────> redeemed
--
--   · reserved_by binds the invite to the one auth account created for it;
--     deleting that account (ON DELETE SET NULL) frees the invite again, so
--     a botched signup is recoverable without touching this table by hand.
--   · redeemed_by is what licenses tenant creation (see the policy below).
--     Redemption REQUIRES auth.users.email_confirmed_at — verification is a
--     server-side gate, not a UX step.
--   · expires_at gates NEW reservations only: an account created before the
--     deadline may finish verifying after it. revoked_at is the operator
--     kill-switch and always wins.
--
-- platform_operators: who may mint/revoke/list invites. Being a tenant owner
-- grants NOTHING here — a beta business must never be able to invite others,
-- and redeeming an invite must never grant platform privilege.
--
-- TENANT CREATION ITSELF IS UNCHANGED: /setup's existing client upsert stays
-- the one door (settings-save contract). This migration only decides WHO may
-- walk through it: existing owners (grandfathered by role) and verified
-- redeemers. The claim RPC never inserts business_settings.
-- =============================================================================

-- ── 1. The invite ledger ─────────────────────────────────────────────────────

create table if not exists public.beta_invites (
  id           uuid primary key default gen_random_uuid(),
  -- sha256 hex of the raw eqb_… token. The CHECK is structural proof that a
  -- raw token (eqb_ prefix, 68 chars) can never be stored by mistake.
  token_hash   text not null unique
               constraint beta_invites_token_hash_is_sha256 check (token_hash ~ '^[0-9a-f]{64}$'),
  label        text not null,        -- who this invite is for (operator's note)
  email        text,                 -- optional: lock redemption to one address
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  reserved_by  uuid references auth.users(id) on delete set null,
  reserved_at  timestamptz,
  redeemed_by  uuid references auth.users(id) on delete set null,
  redeemed_at  timestamptz,
  send_count   integer not null default 0,   -- verification emails sent (resend cap)
  last_sent_at timestamptz                   -- resend throttle anchor
);

comment on table public.beta_invites is
  'One-time beta signup invites. Raw tokens are never stored — sha256 hex only. Service-role and DEFINER access only: RLS is on with zero policies.';
comment on column public.beta_invites.reserved_by is
  'The auth account created against this invite. SET NULL on user delete frees the invite for a fresh signup.';
comment on column public.beta_invites.redeemed_by is
  'Set by claim_beta_invite once the email is verified. This is what can_provision_business() reads.';

-- one invite per account, in both directions
create unique index if not exists beta_invites_reserved_by_key
  on public.beta_invites (reserved_by) where reserved_by is not null;
create unique index if not exists beta_invites_redeemed_by_key
  on public.beta_invites (redeemed_by) where redeemed_by is not null;

alter table public.beta_invites enable row level security;
-- Zero policies: the deny is structural (portal_access_requests precedent).
-- Supabase's default privileges grant table DML to anon/authenticated at
-- CREATE time and `revoke ... from public` does NOT remove it — revoke by
-- role name (learned in crew-mode and quote-options).
revoke all on table public.beta_invites from anon, authenticated;

-- ── 2. Platform operators ────────────────────────────────────────────────────

create table if not exists public.platform_operators (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.platform_operators is
  'Who may issue beta invites. NOT a role system: one row today (the founding account). No client access of any kind.';

alter table public.platform_operators enable row level security;
revoke all on table public.platform_operators from anon, authenticated;

-- Seed the founding account. Idempotent.
insert into public.platform_operators (user_id, note)
values ('a12a0549-7210-4b6c-829e-3ed9feb380b3', 'founding account — kavin.alexander.business@gmail.com')
on conflict (user_id) do nothing;

-- ── 3. Operator functions (mint / revoke / list) ─────────────────────────────
-- Callable by authenticated sessions; the operator check is the gate. A tenant
-- owner who is not an operator gets 42501, same as anyone else.

create or replace function public.create_beta_invite(
  p_token_hash text,
  p_label      text,
  p_email      text default null,
  p_days       integer default 14
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_exp timestamptz;
begin
  if auth.uid() is null
     or not exists (select 1 from public.platform_operators o where o.user_id = auth.uid()) then
    raise exception 'only a platform operator can issue beta invites' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'token_hash must be sha256 hex — never send the raw token' using errcode = '22023';
  end if;
  if p_label is null or btrim(p_label) = '' then
    raise exception 'label is required — an invite must say who it is for' using errcode = '22023';
  end if;

  v_exp := now() + make_interval(days => greatest(1, least(90, coalesce(p_days, 14))));

  insert into public.beta_invites (token_hash, label, email, created_by, expires_at)
  values (p_token_hash, btrim(p_label), nullif(lower(btrim(coalesce(p_email, ''))), ''), auth.uid(), v_exp)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'expires_at', v_exp);
end
$$;

create or replace function public.revoke_beta_invite(p_id uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_found boolean;
begin
  if auth.uid() is null
     or not exists (select 1 from public.platform_operators o where o.user_id = auth.uid()) then
    raise exception 'only a platform operator can revoke beta invites' using errcode = '42501';
  end if;
  update public.beta_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = p_id
  returning true into v_found;
  return coalesce(v_found, false);
end
$$;

create or replace function public.list_beta_invites()
returns table (
  id uuid, label text, email text, created_at timestamptz, expires_at timestamptz,
  state text, reserved_at timestamptz, redeemed_at timestamptz,
  send_count integer, last_sent_at timestamptz
)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.platform_operators o where o.user_id = auth.uid()) then
    raise exception 'only a platform operator can list beta invites' using errcode = '42501';
  end if;
  return query
  select i.id, i.label, i.email, i.created_at, i.expires_at,
         case
           when i.revoked_at  is not null then 'revoked'
           when i.redeemed_at is not null then 'redeemed'
           when i.reserved_by is not null then 'reserved'
           when i.expires_at < now()      then 'expired'
           else 'open'
         end,
         i.reserved_at, i.redeemed_at, i.send_count, i.last_sent_at
    from public.beta_invites i
   order by i.created_at desc;
end
$$;

-- ── 4. The provisioning licence ──────────────────────────────────────────────
-- Used by the business_settings INSERT policy. Two ways in:
--   · already an owner (grandfather: every existing settings write is an
--     UPSERT, and ON CONFLICT DO UPDATE still evaluates the INSERT policy's
--     WITH CHECK on the proposed row — without this disjunct, the live
--     owner's settings save would break the moment this migration ran)
--   · redeemed a beta invite (set only by claim_beta_invite, below, which
--     requires a verified email)
-- SECURITY DEFINER because the calling role has no grant on beta_invites —
-- the same reason current_app_role() is DEFINER. Fails closed: no uid, no rows.

create or replace function public.can_provision_business()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.current_app_role() = 'owner'
      or exists (select 1 from public.beta_invites i where i.redeemed_by = auth.uid())
$$;

drop policy if exists "settings: insert own" on public.business_settings;
create policy "settings: insert own" on public.business_settings
  for insert with check (auth.uid() = user_id and public.can_provision_business());

-- ── 5. Redemption ────────────────────────────────────────────────────────────
-- No-arg on purpose: the invite was bound to this account at reservation time
-- by the signup route, so the raw token never has to ride through the email
-- link or the client. auth.uid() is the only input — the same no-parameter
-- shape as the verify-suite's tenant marker check, and for the same reason:
-- nothing client-supplied to forge. Idempotent: every path re-entered returns a calm status, never
-- an error — this runs on page load at /setup as the self-heal.
--
-- Reads auth.users directly for email_confirmed_at — the crew_access_states
-- precedent (RUN-2026-08-09-crew-invite.sql): no RLS policy can expose that
-- table safely, so a DEFINER function names exactly what it needs.
--
-- expires_at is deliberately NOT checked here: expiry gates reservation (new
-- signups), and an account created in time may finish verifying late.
-- Revocation, by contrast, always wins — it is the kill-switch.

create or replace function public.claim_beta_invite()
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_confirmed timestamptz;
  v_inv       public.beta_invites%rowtype;
begin
  if v_uid is null then
    return 'not-signed-in';
  end if;

  select u.email_confirmed_at into v_confirmed from auth.users u where u.id = v_uid;
  if v_confirmed is null then
    return 'email-unverified';
  end if;

  select * into v_inv
    from public.beta_invites i
   where i.reserved_by = v_uid or i.redeemed_by = v_uid
   order by (i.redeemed_by = v_uid) desc
   limit 1
     for update;

  if not found then
    -- Legacy owners (and the fixture tenant) have no invite; that is fine.
    return case when public.current_app_role() = 'owner' then 'already-owner' else 'no-invite' end;
  end if;

  if v_inv.redeemed_by = v_uid then
    return 'already-claimed';
  end if;

  if v_inv.revoked_at is not null then
    return 'revoked';
  end if;

  update public.beta_invites
     set redeemed_by = v_uid, redeemed_at = now()
   where id = v_inv.id;

  return 'claimed';
end
$$;

-- ── 6. Grants ────────────────────────────────────────────────────────────────
-- Default privileges grant EXECUTE on every new public function to anon and
-- authenticated at CREATE time; revoke by role name, then grant back only
-- what each caller needs.

revoke execute on function public.create_beta_invite(text, text, text, integer) from public, anon;
grant  execute on function public.create_beta_invite(text, text, text, integer) to authenticated;

revoke execute on function public.revoke_beta_invite(uuid) from public, anon;
grant  execute on function public.revoke_beta_invite(uuid) to authenticated;

revoke execute on function public.list_beta_invites() from public, anon;
grant  execute on function public.list_beta_invites() to authenticated;

revoke execute on function public.can_provision_business() from public, anon;
grant  execute on function public.can_provision_business() to authenticated;

revoke execute on function public.claim_beta_invite() from public, anon;
grant  execute on function public.claim_beta_invite() to authenticated;
