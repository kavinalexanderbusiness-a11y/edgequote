-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-08-11 — Customer CSV import: provenance.
--
-- One row per import RUN. Not an import-history product: the question this
-- answers is "did an import happen here, when, how big, and who did it" — the
-- question you ask six months later when a customer book looks unfamiliar.
-- It stores counts, not rows; the customers themselves are the record of what
-- was imported.
--
-- APPEND-ONLY BY CONSTRUCTION: there are SELECT and INSERT policies and there
-- are deliberately no UPDATE or DELETE policies, so an audit row cannot be
-- edited or erased through the API by the tenant it describes. RLS is the
-- enforcement, not app code.
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════
create table if not exists public.customer_imports (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  initiated_by          text,          -- owner email at the time of the run
  source_name           text,          -- uploaded filename, or 'Pasted CSV'
  rows_detected         integer not null default 0,
  customers_created     integer not null default 0,
  rows_skipped_existing integer not null default 0,
  rows_failed           integer not null default 0,
  properties_created    integer not null default 0,
  -- A negative count is not a smaller number, it is a broken writer. The audit
  -- refuses to record one rather than preserving nonsense for later reading.
  constraint customer_imports_counts_sane check (
    rows_detected >= 0 and customers_created >= 0 and rows_skipped_existing >= 0
    and rows_failed >= 0 and properties_created >= 0
  ),
  -- The filename is untrusted text off a file picker. Bounded here as well as in
  -- the app, because the app is not the only thing that could ever insert.
  constraint customer_imports_source_name_len check (source_name is null or char_length(source_name) <= 200),
  constraint customer_imports_initiated_by_len check (initiated_by is null or char_length(initiated_by) <= 200)
);

alter table public.customer_imports enable row level security;

drop policy if exists "customer_imports: select own" on public.customer_imports;
create policy "customer_imports: select own" on public.customer_imports
  for select using (auth.uid() = user_id);

drop policy if exists "customer_imports: insert own" on public.customer_imports;
create policy "customer_imports: insert own" on public.customer_imports
  for insert with check (auth.uid() = user_id);

-- No UPDATE / DELETE policy on purpose — see the header.

-- ⚠️ Supabase's ALTER DEFAULT PRIVILEGES hands `anon` full arwdDxtm on every new
-- public table. RLS already denies it every row (auth.uid() is null for anon, so
-- `auth.uid() = user_id` is never true), and that was PROVEN with a SET ROLE anon
-- probe before this line was written — but an import audit has no public surface
-- at all, so the grant itself goes too. One less thing depending on a policy
-- staying correct. See the tenant-boundary audit: every hole found there was on
-- a surface where RLS was not the thing doing the work.
revoke all on public.customer_imports from anon;

create index if not exists customer_imports_user_created_idx
  on public.customer_imports(user_id, created_at desc);
