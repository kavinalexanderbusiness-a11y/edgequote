-- ═══════════════════════════════════════════════════════════════════════════
-- PLATFORM PRELUDE — the environment the baseline ASSUMES but does not own
--
-- ⛔ NEVER RUN THIS AGAINST A SUPABASE PROJECT. Supabase already provides every
--    object below, in richer and authoritative form. Running it there would at
--    best fail and at worst shadow real platform objects with these stubs.
--
-- WHAT IT IS FOR, exactly two things:
--   1. The rebuild test (scripts/schema/rebuild-test.ts) applies this to an empty
--      Postgres so the baseline can be proven to apply from zero. Without it the
--      test would be measuring "does Supabase exist", not "does our schema build".
--   2. It is the EXECUTABLE STATEMENT of our auth/storage assumptions. Every
--      object here is something production depends on and the repo does not
--      create. When recovering onto a fresh Supabase project you get all of it
--      for free; onto anything else, this list is the bill.
--
-- Derived from what the baseline actually references — not from guesswork:
--   auth.uid()          390 policy predicates
--   auth.users          93 foreign keys + crew_access_states reads last_sign_in_at
--   storage.objects     21 storage policies (bucket_id, name, owner)
--   storage.buckets     bucket rows
--   storage.foldername()20 policy predicates
--   net.http_post()     push_dispatch, nudge_webhook_deliveries
--   extensions.gen_random_bytes()  crew invite codes
--
-- The STUBS BELOW ARE NOT SECURITY. auth.uid() here returns a settable GUC so the
-- rebuild test can assert policies compile; it does not authenticate anything.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── roles ────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
end $$;

grant anon, authenticated, service_role to authenticator;

-- ── schemas ──────────────────────────────────────────────────────────────────
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create schema if not exists net;
create schema if not exists supabase_migrations;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;

-- ── auth ─────────────────────────────────────────────────────────────────────
-- Real Supabase reads the JWT from a request GUC. The stub keeps that SHAPE so a
-- policy predicate compiles and can be exercised, and nothing more.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;

create or replace function auth.email() returns text
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;

create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

-- ── storage ──────────────────────────────────────────────────────────────────
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  path_tokens text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);

alter table storage.objects enable row level security;

-- Supabase splits an object path into its directory segments; policies compare
-- foldername(name)[1] to a tenant id. Same semantics, so the predicates are real.
create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable
  as $$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end $$;

create or replace function storage.filename(name text) returns text
  language plpgsql immutable
  as $$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[array_length(parts, 1)];
end $$;

-- ── net (pg_net) ─────────────────────────────────────────────────────────────
-- pg_net is an async HTTP queue and cannot exist off-platform. The stub records
-- the call and returns a request id, so a trigger that fires it still commits.
create table if not exists net._stub_requests (
  id bigint generated always as identity primary key,
  url text, body jsonb, headers jsonb, created_at timestamptz default now()
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
  language sql
  as $$ insert into net._stub_requests (url, body, headers) values (url, body, headers) returning id $$;

-- ── extensions ───────────────────────────────────────────────────────────────
-- pgcrypto/pg_trgm/uuid-ossp are created by the baseline itself (section 1); the
-- rebuild harness pre-loads the binaries. Nothing to declare here.

-- ── migration ledger ─────────────────────────────────────────────────────────
-- Same shape Supabase uses, so a rebuilt database can record what it has applied.
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text,
  created_by text,
  idempotency_key text,
  rollback text
);
