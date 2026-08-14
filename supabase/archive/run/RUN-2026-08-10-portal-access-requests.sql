-- ── Public "email me my portal link" — the abuse ledger ─────────────────────
-- Backs POST /api/public/portal-access, the page at /portal-access.
--
-- The endpoint must answer IDENTICALLY for a known and an unknown address, so
-- the only defence against someone walking a list of emails to discover which
-- ones are customers is a rate limit that applies to BOTH. That needs a record
-- of attempts, including the ones that matched nothing — hence this table.
--
-- WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
-- `email_key` is sha256(lower(trim(email))), never the address. The table's only
-- job is counting attempts per bucket; storing the plaintext would turn an abuse
-- ledger into a harvestable list of every address anyone ever typed — including
-- non-customers, who never consented to being in this database at all. A hash
-- counts just as well.
--
-- `matched` and `sent` are booleans about OUR side of the exchange (did any
-- customer match, did the provider accept the message). They exist so a failed
-- send is never recorded as a success — the public response stays neutral either
-- way, but the truth has to live somewhere the owner can look.
--
-- NO customer_id, NO user_id, NO token: this row must never become a second
-- place where the link exists.
--
-- RLS is enabled with NO policies. The route reaches it with the service-role
-- key (which bypasses RLS); anon and authenticated get nothing, so the ledger
-- cannot be read back by the browser that wrote to it.

create table if not exists public.portal_access_requests (
  id          uuid primary key default uuid_generate_v4(),
  email_key   text        not null,
  created_at  timestamptz not null default now(),
  matched     boolean     not null default false,
  sent        boolean     not null default false
);

alter table public.portal_access_requests enable row level security;

-- The two windows the route counts over: one bucket per address (stops a single
-- inbox being mail-bombed) and one global (stops a broad enumeration sweep).
create index if not exists portal_access_requests_key_time_idx
  on public.portal_access_requests (email_key, created_at desc);
create index if not exists portal_access_requests_time_idx
  on public.portal_access_requests (created_at desc);

comment on table public.portal_access_requests is
  'Abuse ledger for the public portal-link endpoint. email_key = sha256(lower(trim(email))) — never the address. No customer_id/user_id/token by design.';

-- ── The lookup ───────────────────────────────────────────────────────────────
-- Normalised on BOTH sides. PostgREST filters cannot call trim() on a column, so
-- a plain .ilike('email', …) matches case but not a stored address with padding
-- — and this database already holds names like 'Shaune ' and 'Elena ', so the
-- same data-entry habit will reach the email column eventually. A customer who
-- could not recover their own portal because their address was saved with a
-- trailing space is exactly the silent failure this endpoint exists to prevent.
--
-- SECURITY: definer, but execute is REVOKED from anon and authenticated. Only the
-- service-role client behind /api/public/portal-access may call it. If anon could
-- run it, the public anon key would be a customer-lookup oracle — the precise
-- thing the endpoint's neutral response is designed to deny.
--
-- Returns no email, no token and no contact detail: just enough to mint the link
-- server-side. Archived customers are excluded — the owner removed them, and this
-- must not be a way back in.
create or replace function public.find_portal_access_customers(p_email text)
returns table (customer_id uuid, customer_name text, owner_id uuid)
language sql
security definer
set search_path = public
as $$
  select c.id, c.name, c.user_id
  from public.customers c
  where c.archived_at is null
    and c.email is not null
    and lower(trim(c.email)) = lower(trim(p_email))
$$;

revoke all on function public.find_portal_access_customers(text) from public;
revoke all on function public.find_portal_access_customers(text) from anon;
revoke all on function public.find_portal_access_customers(text) from authenticated;

comment on function public.find_portal_access_customers(text) is
  'Portal-link recovery lookup. Normalises both sides (lower+trim). NOT executable by anon/authenticated — service-role only, or the public anon key becomes a customer-existence oracle.';
