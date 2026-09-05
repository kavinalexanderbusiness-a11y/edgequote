-- ── The verification boundary: a guard's fixtures live in a tenant nobody watches ──
--
-- WHAT WENT WRONG. `verify:quote-options` created a quote in the OWNER's tenant,
-- attached it to a REAL customer (picked as the first live portal token in the
-- book), and accepted it through that customer's own portal door. `quotes` going
-- to 'accepted' fires trg_notify_quote_accepted, which inserts a row in
-- `notifications` for the quote's user_id. Forty-five runs in two hours put forty-
-- five "Automated guard fixture — safe to delete accepted a quote" alerts in the
-- owner's bell, each pointing at a quote the guard had already deleted. A real
-- customer's portal, meanwhile, showed a $5,550 job at "1 Verification Way".
--
-- WHY THE TRIGGER IS NOT THE BUG. notify_quote_accepted is unconditional and
-- correct: a quote reaching 'accepted' is exactly what an owner must be told about.
-- Adding an "unless it's a test" branch to it would put a suppression switch on a
-- production notification path, which is how real alerts go missing. The trigger
-- stays exactly as it is.
--
-- THE BOUNDARY IS THE TENANT. Every notification, every message and every RLS
-- policy in this schema is scoped by user_id. So a fixture that belongs to a
-- DIFFERENT user_id cannot reach the owner: the trigger still fires, and it
-- notifies the fixture tenant, whose bell nobody is looking at. No production code
-- changes, no suppression, no test-only branch in a business rule.
--
-- WHAT THIS MIGRATION ADDS is the machine-readable proof of which tenant that is,
-- so a guard can REFUSE TO WRITE unless it is provably signed in as one.
--
-- ⛔ THIS MARKER GRANTS NOTHING. It is not consulted by any trigger, policy, RPC,
-- API route or UI. It changes no business rule, relaxes no constraint, and skips
-- no security check. It exists solely so `scripts/` can assert "I am not in the
-- real book" before it writes a row. A tenant marked here behaves in every way
-- like any other tenant — which is the point: the guard must exercise the real
-- rules, or it proves nothing.
--
-- ⛔ AND IT CANNOT BE SELF-ASSIGNED. The table has RLS on and NO policies, and its
-- privileges are revoked from anon and authenticated — so no signed-in user and no
-- public caller can read it, insert into it, or nominate themselves. Rows arrive
-- only by migration or service_role. There is deliberately no header, no query
-- flag and no request parameter anywhere in this design: nothing a caller sends
-- can make the application treat them as a test.

create table if not exists public.verify_fixture_tenants (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  note       text
);

comment on table public.verify_fixture_tenants is
  'Tenants whose data is created by scripts/verify-*.ts. Marker only — grants nothing, '
  'relaxes nothing. Guards read it through is_verify_fixture_tenant() and refuse to write '
  'when it answers false. Writable only by migration/service_role.';

alter table public.verify_fixture_tenants enable row level security;
-- No policies at all. With RLS on and none defined, authenticated and anon see and
-- do nothing here — the deny is structural rather than a rule someone could edit.
revoke all on table public.verify_fixture_tenants from anon, authenticated;

-- The only way a caller learns anything about this table, and it can only ever ask
-- about ITSELF: no arguments, and auth.uid() is the sole input. There is no shape
-- of this call that enumerates the table or probes another tenant, so publishing it
-- to `authenticated` leaks nothing — the answer is already known to the caller.
create or replace function public.is_verify_fixture_tenant()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.verify_fixture_tenants t where t.user_id = auth.uid()
  );
$$;

comment on function public.is_verify_fixture_tenant() is
  'True when the CALLER is a verification fixture tenant. Answers only about auth.uid(); '
  'takes no arguments so it cannot be used to enumerate or probe. Consulted by scripts/ '
  'only — no trigger, policy or application path reads it.';

-- ⚠️ `revoke from public` alone has not been enough in this database before: a
-- default-privileges grant survives it, so the ACL is read back after this runs
-- (see the quote-options audit). Both revokes, then the one grant that is wanted.
revoke all on function public.is_verify_fixture_tenant() from public;
revoke all on function public.is_verify_fixture_tenant() from anon;
grant execute on function public.is_verify_fixture_tenant() to authenticated;
