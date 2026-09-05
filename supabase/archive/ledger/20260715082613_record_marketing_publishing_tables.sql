-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715082613
--   name    : record_marketing_publishing_tables
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Repo record for social_connections + publish_jobs. Transcribed from the live objects.
-- Additive and idempotent — intended as a verified no-op against the current database.

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function public.set_updated_at() returns trigger language plpgsql as $fn$
    begin new.updated_at = now(); return new; end $fn$;
  end if;
end $$;

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
create unique index if not exists social_connections_unique_idx
  on public.social_connections (user_id, platform, coalesce(account_id, account_name));

alter table public.social_connections enable row level security;

create table if not exists public.publish_jobs (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_piece_id uuid not null references public.content_pieces(id) on delete cascade,
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
  idempotency_key text not null unique,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists publish_jobs_user_idx on public.publish_jobs (user_id, created_at desc);
create index if not exists publish_jobs_status_idx on public.publish_jobs (user_id, status);
create index if not exists publish_jobs_piece_idx on public.publish_jobs (content_piece_id);
create index if not exists publish_jobs_due_idx on public.publish_jobs (status, scheduled_for);

alter table public.publish_jobs enable row level security;

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

drop trigger if exists trg_social_connections_updated on public.social_connections;
create trigger trg_social_connections_updated before update on public.social_connections
  for each row execute function public.set_updated_at();

drop trigger if exists trg_publish_jobs_updated on public.publish_jobs;
create trigger trg_publish_jobs_updated before update on public.publish_jobs
  for each row execute function public.set_updated_at();