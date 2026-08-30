-- ── RLS does not gate TRUNCATE ───────────────────────────────────────────────
-- Session 106, security correction. Measured on production before writing:
--
--     115 public tables, 115 of them with RLS enabled
--     anon          holds TRUNCATE on  90
--     authenticated holds TRUNCATE on 101  (99 of them tenant-owned)
--     only 14 tables were correctly shaped
--
-- ⛔⛔ RLS IS NOT A DEFENCE HERE. A policy constrains rows; TRUNCATE is not a row
-- operation, so a role holding it empties the whole table regardless of every
-- policy on it. `customers`, `invoices`, `api_keys` and `customer_portal_tokens`
-- were all in that set. The GRANT is the only thing that ever stood in the way,
-- and it was granted.
--
-- WHERE IT CAME FROM. Not a decision anyone made per table — Supabase's
-- create-time default privileges hand `arwdDxtm` to anon and authenticated for
-- every new table in `public`, from BOTH the `postgres` and `supabase_admin`
-- grantors. Every table inherited the full set on creation, including D
-- (TRUNCATE), x (REFERENCES) and t (TRIGGER), and every FUTURE table would too.
-- That is why this fixes the default as well as the existing tables: revoking
-- only what exists today means the next migration silently re-opens it.
--
-- ⚖️ EXPOSURE vs EXPLOITABILITY, stated honestly. This closes a missing last line
-- of defence, not a door that was standing open. Measured at the same time:
--     0 functions in `public` name TRUNCATE
--     0 SECURITY INVOKER functions a client may EXECUTE would use the caller's grant
--     0 client-callable functions build dynamic SQL
--     PostgREST maps HTTP to SELECT/INSERT/UPDATE/DELETE and RPC only — no verb
--       becomes TRUNCATE
-- So there is no measured path from a client to it today. The grant should still
-- not exist: it is the thing that would make the next mistake unrecoverable.
--
-- ⭐ CRUD IS UNTOUCHED. arwdDxtm → arwd + m. SELECT/INSERT/UPDATE/DELETE keep
-- working exactly as before on every table, and RLS keeps deciding which rows.
-- Only the three DDL-shaped privileges a client has no business holding go:
--     D  TRUNCATE   — empties a table, ignores RLS
--     t  TRIGGER    — attach a trigger to somebody else's table
--     x  REFERENCES — create a foreign key against it
-- Nothing in this codebase uses any of them from a client: `grep -rn truncate
-- src/ scripts/` finds only the CSS class.
--
-- ⛔ service_role and postgres are NOT touched. Server maintenance paths, the
-- schema tooling and every SECURITY DEFINER function keep exactly what they had.

-- ── 1. The tables that exist today ───────────────────────────────────────────
revoke truncate, trigger, references on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- ── 2. The tables that do not exist yet ──────────────────────────────────────
-- Without this, the next `create table` in public re-grants all three.
-- ⚠️ Written for BOTH grantors because production carries default ACLs from each;
-- a fix applied to only one leaves the other still handing them out.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon;
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from authenticated;

-- ⚠️ `supabase_admin` EXISTS IN PRODUCTION AND NOT IN PGlite, and verify:rebuild
-- replays this same apply path from zero into PGlite. Written unconditionally,
-- these two statements abort the rebuild with `role "supabase_admin" does not
-- exist` — a migration that cannot be replayed is a migration that cannot be
-- proven, and the guard that proves the repo can rebuild production would go red
-- on the very change meant to harden it. Caught by running the from-zero proof
-- BEFORE applying anything to production, which is the point of running it.
-- ⚠️⚠️ AND `supabase_admin`'s DEFAULTS CANNOT BE CHANGED FROM HERE. Measured:
-- the role this runs as is `postgres`, which is NOT a superuser on Supabase
-- (rolsuper = false) and is not a member of `supabase_admin` — `set role
-- supabase_admin` is refused, and so is altering its default privileges:
--     ERROR 42501: permission denied to change default privileges
-- Written unconditionally that error aborts the WHOLE migration, taking the
-- reachable half down with it. Attempted and caught rather than assumed.
--
-- ⚖️ WHAT THAT LEAVES. A default ACL only applies to tables created BY that role.
-- Every table in this schema is created by migrations running as `postgres`, so
-- the `postgres` defaults above are the ones that govern this application's
-- tables — that half is the one that matters and it IS applied. The
-- `supabase_admin` entry would only bite for a table supabase_admin itself
-- creates in `public`, which is Supabase-managed territory, not ours.
--
-- ⛔ RESIDUAL, recorded rather than hidden: closing that second entry needs a
-- superuser (Supabase dashboard or support). Until it is closed, a table created
-- in `public` BY supabase_admin would still inherit arwdDxtm.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public'
           || ' revoke truncate, trigger, references on tables from anon';
      execute 'alter default privileges for role supabase_admin in schema public'
           || ' revoke truncate, trigger, references on tables from authenticated';
      raise notice 'supabase_admin default privileges corrected';
    exception when insufficient_privilege then
      -- Not a failure of this migration: the reachable half is done, and the
      -- residual is named in the comment above and pinned by
      -- verify:client-privileges so it cannot be forgotten.
      raise notice 'supabase_admin default privileges NOT changed (insufficient privilege) — residual, see migration header';
    end;
  end if;
end $$;
