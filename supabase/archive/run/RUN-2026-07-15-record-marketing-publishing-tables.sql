-- ── Repo record: social_connections + publish_jobs ───────────────────────────
--
-- WHY THIS FILE EXISTS
-- These two tables are LIVE IN PRODUCTION and are read/written by Marketing Studio
-- (mktg-studio/src/lib/marketing/connections.ts, src/app/api/marketing/publish/*,
-- .../connect/callback). No .sql file in ANY branch of ANY clone creates them — they
-- were made directly against the database and never written down. Rebuild this schema
-- from the repo and the whole publishing pipeline dies on "relation does not exist".
--
-- This file changes NOTHING in production. It is transcribed from the live objects
-- (pg_attribute / pg_constraint / pg_indexes / pg_policies / pg_trigger) so that the
-- repo can finally reproduce what already exists. Every statement is guarded, so
-- running it against the current database is a verified no-op.
--
-- ONE DELIBERATE DIFFERENCE FROM PRODUCTION — read before "fixing" it:
-- Production carries EIGHT policies per table, not four: a terse set ("pj sel",
-- "sc upd") and a verbose set ("publish_jobs: select own"), applied twice under
-- different names. Both sets are PERMISSIVE, both target {public}, and both use the
-- identical expression `auth.uid() = user_id` — so Postgres ORs A with A and the
-- result is A. They are pure redundancy, evaluated twice on every row touched.
-- Only the VERBOSE set is declared here, because that matches the convention every
-- other table in this repo uses. The terse duplicates are left ALONE in production:
-- dropping them is safe but it is still a `drop policy`, and destructive DDL doesn't
-- happen here without the owner saying so. See the audit notes in the commit message.
--
-- SAFETY: additive and idempotent. No drops, no data movement, no behaviour change.

-- set_updated_at() already exists in this schema; the guard keeps this file
-- runnable stand-alone against a fresh database.
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end $fn$;
  end if;
end $$;

-- ── social_connections ───────────────────────────────────────────────────────
-- One row per connected (or manually-recorded) social account.
-- NOTE: access_token / refresh_token are stored in PLAINTEXT here. That is how the
-- live table is defined and this file only records it — but it is worth the owner's
-- attention. RLS keeps them from other tenants; it does not encrypt them at rest.
create table if not exists public.social_connections (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,
  provider text not null default 'manual',
  mode text not null default 'manual' check (mode in ('manual', 'api')),
  account_id text,
  account_name text not null,
  account_url text,
  avatar_url text,
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked')),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}'::text[],
  meta jsonb not null default '{}'::jsonb
);

create index if not exists social_connections_user_idx on public.social_connections (user_id, platform);
-- Re-connecting the same account must update the row, not mint a second one. COALESCE
-- because a manual connection has no account_id and is identified by its name.
create unique index if not exists social_connections_unique_idx
  on public.social_connections (user_id, platform, coalesce(account_id, account_name));

alter table public.social_connections enable row level security;

-- ── publish_jobs ─────────────────────────────────────────────────────────────
-- One row per attempt to put a content_piece on a platform. Retries live here
-- (attempts / max_attempts / last_attempt_at), which is why the publisher can be
-- re-driven without double-posting.
create table if not exists public.publish_jobs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_piece_id uuid not null references public.content_pieces(id) on delete cascade,
  -- set null, not cascade: disconnecting an account must not erase the history of
  -- what was already published through it.
  connection_id uuid references public.social_connections(id) on delete set null,
  platform text not null,
  mode text not null default 'manual' check (mode in ('manual', 'api')),
  status text not null default 'queued'
    check (status in ('draft', 'scheduled', 'queued', 'publishing', 'published', 'failed', 'canceled')),
  scheduled_for timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  last_attempt_at timestamptz,
  published_at timestamptz,
  external_post_id text,
  external_url text,
  error text,
  -- THE double-post guard: the unique constraint is what makes a retry safe.
  idempotency_key text not null unique,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists publish_jobs_user_idx on public.publish_jobs (user_id, created_at desc);
create index if not exists publish_jobs_status_idx on public.publish_jobs (user_id, status);
create index if not exists publish_jobs_piece_idx on public.publish_jobs (content_piece_id);
-- The queue drain reads (status, scheduled_for) — this is the index that keeps it cheap.
create index if not exists publish_jobs_due_idx on public.publish_jobs (status, scheduled_for);

alter table public.publish_jobs enable row level security;

-- ── Policies ─────────────────────────────────────────────────────────────────
-- Owner-only on both tables. drop-then-create is the repo's idempotency idiom for
-- policies (Postgres has no `create policy if not exists`); dropping by the exact
-- name this file owns is safe and re-runnable.
do $$
begin
  drop policy if exists "social_connections: select own" on public.social_connections;
  drop policy if exists "social_connections: insert own" on public.social_connections;
  drop policy if exists "social_connections: update own" on public.social_connections;
  drop policy if exists "social_connections: delete own" on public.social_connections;
  create policy "social_connections: select own" on public.social_connections for select using (auth.uid() = user_id);
  create policy "social_connections: insert own" on public.social_connections for insert with check (auth.uid() = user_id);
  create policy "social_connections: update own" on public.social_connections for update using (auth.uid() = user_id);
  create policy "social_connections: delete own" on public.social_connections for delete using (auth.uid() = user_id);

  drop policy if exists "publish_jobs: select own" on public.publish_jobs;
  drop policy if exists "publish_jobs: insert own" on public.publish_jobs;
  drop policy if exists "publish_jobs: update own" on public.publish_jobs;
  drop policy if exists "publish_jobs: delete own" on public.publish_jobs;
  create policy "publish_jobs: select own" on public.publish_jobs for select using (auth.uid() = user_id);
  create policy "publish_jobs: insert own" on public.publish_jobs for insert with check (auth.uid() = user_id);
  create policy "publish_jobs: update own" on public.publish_jobs for update using (auth.uid() = user_id);
  create policy "publish_jobs: delete own" on public.publish_jobs for delete using (auth.uid() = user_id);
end $$;

-- ── updated_at ───────────────────────────────────────────────────────────────
drop trigger if exists trg_social_connections_updated on public.social_connections;
create trigger trg_social_connections_updated before update on public.social_connections
  for each row execute function public.set_updated_at();

drop trigger if exists trg_publish_jobs_updated on public.publish_jobs;
create trigger trg_publish_jobs_updated before update on public.publish_jobs
  for each row execute function public.set_updated_at();
