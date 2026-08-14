-- ── Owner password recovery — the abuse ledger ──────────────────────────────
-- Backs POST /api/public/password-reset, the page at /forgot-password.
--
-- Same shape and the same reasoning as portal_access_requests
-- (RUN-2026-08-10-portal-access-requests.sql), and deliberately a SEPARATE
-- table rather than a `kind` column on that one: they throttle different
-- populations for different reasons — a customer recovering a portal link, and
-- a business owner recovering their login. Sharing a bucket would let a burst of
-- one silently deny the other, and the global ceilings below are not the same
-- number for a reason.
--
-- WHY IT EXISTS. The endpoint answers IDENTICALLY for an address that has an
-- EdgeQuote account and one that does not. That neutrality is the whole security
-- property, and it means the ONLY defence against someone walking a list of
-- addresses to discover which are owners is a rate limit that counts BOTH. That
-- needs a record of attempts including the ones that matched nothing — hence
-- this table.
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
-- `email_key` is sha256(lower(trim(email))), never the address. Storing the
-- plaintext would turn an abuse ledger into a harvestable list of every address
-- anyone ever typed into the form — including people with no account, who never
-- consented to being in this database at all. A hash counts just as well.
--
-- `matched` and `sent` are booleans about OUR side: did an account match, did
-- Resend accept the message. They exist so a failed send is never recorded as a
-- success — the public response stays neutral either way, but the truth has to
-- live somewhere an operator can look.
--
-- NO user_id, NO email, NO token, NO IP: this row must never become a second
-- place the recovery link exists, nor a log of who tried to sign in.
--
-- RLS is enabled with NO policies. The route reaches it with the service-role
-- key (which bypasses RLS); anon and authenticated get nothing, so the ledger
-- cannot be read back by the browser that wrote to it.

create table if not exists public.password_reset_requests (
  id          uuid primary key default uuid_generate_v4(),
  email_key   text        not null,
  created_at  timestamptz not null default now(),
  matched     boolean     not null default false,
  sent        boolean     not null default false
);

alter table public.password_reset_requests enable row level security;

-- Belt AND braces, the way beta_invites does it. RLS with zero policies already
-- returns nothing to anon, but a table created in `public` inherits default
-- SELECT/INSERT grants for anon and authenticated, and a future policy added in
-- good faith would silently become reachable through them. Revoking by role name
-- means the deny survives that mistake.
-- ⚠️ portal_access_requests (the table this mirrors) still holds those default
--    grants. It is safe today for the RLS reason above, but it is one policy away
--    from not being — worth closing separately.
revoke all on table public.password_reset_requests from anon, authenticated;

-- The two windows the route counts over: one bucket per address (stops a single
-- inbox being mail-bombed) and one global (stops a broad enumeration sweep).
create index if not exists password_reset_requests_key_time_idx
  on public.password_reset_requests (email_key, created_at desc);
create index if not exists password_reset_requests_time_idx
  on public.password_reset_requests (created_at desc);

comment on table public.password_reset_requests is
  'Abuse ledger for the public password-reset endpoint. email_key = sha256(lower(trim(email))) — never the address. No user_id/email/token/IP by design.';
