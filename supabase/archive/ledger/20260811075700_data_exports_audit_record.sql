-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811075700
--   name    : data_exports_audit_record
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A record that a business exported its own data ──────────────────────────
-- ONE table, not an audit system. A bulk export is the single most sensitive
-- read in the product (every customer, every price, every address in one file),
-- and it was the only such action leaving no trace at all: integration_events is
-- a webhook outbox fed by triggers on entity tables, with a fixed public event
-- registry, so an export event there would either become a customer-facing API
-- surface or be dead data. This is the export's own record.
--
-- It is also what lets the settings screen say "last exported on ..." truthfully,
-- and is the foundation an "export before you close your account" flow needs.

create table if not exists public.data_exports (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  format_version integer     not null,
  total_rows     integer     not null,
  bytes          bigint      not null,
  -- Per-file row counts, exactly as handed to the owner.
  files          jsonb       not null default '[]'::jsonb
);

create index if not exists data_exports_user_created_idx
  on public.data_exports (user_id, created_at desc);

alter table public.data_exports enable row level security;

-- SELECT and INSERT own, and deliberately NO update or delete policy: a record
-- its own subject can rewrite is not a record of anything. RLS denies by
-- default, so the absence of a policy IS the lock.
do $$
begin
  if not exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                 where c.relname = 'data_exports' and p.polname = 'data_exports: select own') then
    create policy "data_exports: select own" on public.data_exports
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                 where c.relname = 'data_exports' and p.polname = 'data_exports: insert own') then
    create policy "data_exports: insert own" on public.data_exports
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

-- Nothing anonymous has any business here. Supabase's default privileges grant
-- anon on every new public table; revoke by NAME AND from public, because the
-- leading "=X/postgres"-style grant to PUBLIC survives a revoke aimed only at a
-- role name (learned the hard way in the tenant-boundary audit).
revoke all on public.data_exports from public, anon;

-- ── Prove it, in the same transaction that made the claim ───────────────────
do $$
declare n int;
begin
  if not exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace
                 where s.nspname = 'public' and c.relname = 'data_exports' and c.relrowsecurity) then
    raise exception 'data_exports: RLS is not enabled';
  end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'data_exports';
  if n <> 2 then
    raise exception 'data_exports: expected exactly 2 policies (select own, insert own), found %', n;
  end if;

  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
             where c.relname = 'data_exports' and p.polcmd in ('w', 'd')) then
    raise exception 'data_exports: an UPDATE or DELETE policy exists — audit rows must not be editable';
  end if;

  if has_table_privilege('anon', 'public.data_exports', 'SELECT')
     or has_table_privilege('anon', 'public.data_exports', 'INSERT') then
    raise exception 'data_exports: anon still holds table privileges';
  end if;
end $$;