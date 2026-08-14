# Database migrations

**The rule: production changes only through a file in this repository.**

Everything below exists to make that rule true and to make breaking it visible.

---

## What went wrong, so the process makes sense

Before 2026-08-14 there was no migration system — there was a convention, and the
convention decayed:

- `supabase/schema.sql` was a snapshot from 2026-06-25, seven weeks behind production.
  Running it did not error; it just produced a schema the app fails against.
- `supabase/RUN-*.sql` grew to 120 files applied "in filename order". Close to a
  complete history, but not equal to it: **eight applied migrations had no repo file
  creating any of their objects**, including the entire `change_orders` feature that
  production had been serving to customers since 05:33 that morning.
- `get_portal_data` had been defined in nine RUN files *and* eleven times inside
  `schema.sql` — every copy a complete runnable body. Applying an older one silently
  replaced the live function with an earlier version. No error; the customer portal
  simply started showing less. That happened twice — and came within a deploy of a
  third: on 2026-08-14 `CANONICAL-get_portal_data.sql` was missing `change_orders`
  while this checklist still said to run it **last, so it wins**.
- Nothing could detect any of it. The drift was found by hand-comparing the live
  catalogue to the repo, which is not a process anyone repeats weekly.

The fix is not "be more careful". It is: one generated baseline, an archive that
cannot be applied, and guards that fail loudly.

---

## Layout

```
supabase/
  migrations/          ← THE APPLY PATH. Run these, in filename order, and nothing else.
    20260814060714_baseline.sql
  archive/             ← history. NEVER applied. Kept so "why is this column here?" is answerable.
    ledger/            ← the 133 migrations production actually ran, recovered from its ledger
    run/               ← the 99 legacy RUN-*.sql files
    schema-2026-06-25-snapshot.sql
    CANONICAL-get_portal_data.sql
  contract/            ← machine-readable snapshot of production's schema
    *.json             ← what the baseline is generated FROM
    fingerprint.json   ← hashes verify:schema compares production against
scripts/schema/
  capture-contract.mts ← npm run schema:contract
  generate-baseline.ts ← npm run schema:baseline
  rebuild-test.mts     ← npm run verify:rebuild
  platform-prelude.sql ← what Supabase provides and we assume
```

### The baseline

`supabase/migrations/*_baseline.sql` is **generated from the live catalogue**, not
written by hand. That is what makes it trustworthy: it cannot describe a database
that does not exist. It is a *consolidation*, not a rewritten history — everything
that ever ran is preserved under `archive/ledger/`.

Its version (`20260814060000`) sorts **after** every migration folded into it, so a
fresh database applies the baseline and then only genuinely newer migrations. The
generator refuses to write a baseline that would violate this.

**Never hand-edit the baseline.** Regenerating discards your edit without a word.

---

## Shipping a schema change

```bash
# 1. Write the migration. Timestamp_snake_name.sql, UTC, 14 digits.
#    supabase/migrations/20260815093000_add_invoice_late_fee.sql

# 2. Prove it applies to an empty database, on top of the baseline.
npm run verify:rebuild

# 3. Apply it to production (Supabase MCP apply_migration, or the SQL editor).
#    This records it in supabase_migrations.schema_migrations automatically.

# 4. Resync the repo to what production now is.
npm run schema:contract    # re-read production
npm run schema:baseline    # fold the change into the baseline
npm run verify:rebuild     # prove the new baseline still builds from zero
npm run verify:schema      # confirm production and the repo agree

# 5. Move the shipped migration into the archive and commit everything under supabase/.
```

After step 4 the change lives in the baseline, so the standalone file moves to
`archive/ledger/` alongside the rest of history. The apply path stays: **one
baseline, plus anything not yet folded in.**

### Rules

| Rule | Why |
|---|---|
| **Ordered** — 14-digit UTC timestamp prefix, sorted lexicographically | Filename order must equal apply order, with no ambiguity |
| **Immutable once shipped** | A database that ran the old text will never run the new. Amend by adding a migration, never by editing one. `verify:migrations` hashes archived files against what production actually ran |
| **Idempotent where it is cheap** | `create table if not exists`, `drop policy if exists` before `create policy`, `create or replace function`. The baseline is fully idempotent. `alter table … add column` is not, and that is fine — it runs once |
| **Explicit about grants and RLS** | A new table on Supabase inherits full grants for `anon`/`authenticated`/`service_role` from `ALTER DEFAULT PRIVILEGES`. Say `revoke` then `grant` explicitly, or you ship an open table believing it closed |
| **Represented in the repo** | No silent manual SQL. `verify:migrations` fails when the ledger knows a migration the repo does not |

### The grants trap, concretely

```sql
create table if not exists public.thing (...);
alter table public.thing enable row level security;

-- NOT optional. Without these, anon and authenticated already have full
-- table privileges through default privileges, and RLS is the only thing
-- standing between a bug in one policy and the whole table.
revoke all on table public.thing from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.thing to authenticated;
grant all on table public.thing to service_role;
```

Same for functions — `revoke all on function … from public, anon, authenticated;`
then grant only what must execute it. Reading `pg_proc.proacl` **back** after
applying is the only way to be sure; `revoke from public` does not remove a grant
that default privileges handed to a named role.

---

## The two guards

| Command | Compares | Catches |
|---|---|---|
| `npm run verify:schema` | production ↔ `contract/fingerprint.json` | **the database moved** — someone applied SQL the repo does not have |
| `npm run verify:rebuild` | the baseline ↔ `contract/*.json` | **the repo moved** — the baseline no longer builds what was captured |
| `npm run verify:migrations` | repo ↔ itself + ledger | missing files, duplicate versions, edited history, two baselines |

Both green means the repository can rebuild what is actually running.

`verify:schema` calls `public.schema_fingerprint()` — counts and md5s only, no
names and no data, so it is safe to grant to any signed-in caller. The full
catalogue comes from `public.schema_contract()`, which returns every RLS predicate
and `SECURITY DEFINER` body and is therefore **`service_role` only**. A crew
session is `authenticated`; it must never read that.

### When `verify:schema` reports drift

Do not edit `fingerprint.json`. The hash is the only thing standing between a
silent production change and a rebuild that quietly omits it.

```bash
# First: find out what changed and who applied it.
select version, name from supabase_migrations.schema_migrations order by version desc limit 5;

# Then resync.
npm run schema:contract && npm run schema:baseline && npm run verify:rebuild
```

Then recover the SQL of any migration that has no file and archive it:

```sql
select array_to_string(statements, E'\n')
from supabase_migrations.schema_migrations where version = '…';
```

---

## The rebuild test

`npm run verify:rebuild` builds a real Postgres in memory (PGlite), applies the
platform prelude and every migration, and diffs the result against
`supabase/contract/*.json` — tables, columns, constraints, indexes, function
bodies, **function EXECUTE grants**, table grants, RLS, policy predicates,
triggers, buckets and storage policies.

```bash
npm i -D @electric-sql/pglite   # ~100 MB, deliberately not a committed dependency
npm run verify:rebuild
```

It **skips clean** when PGlite is absent so the suite stays green on a machine that
has not opted in — which means *someone has to run it deliberately before a
release*. It is the only check that proves the recovery procedure works.

Two declared, printed substitutions are made, because these are platform objects
this repo does not own: `pg_net` (the prelude stubs `net.http_post`) and
`pg_stat_statements`. Nothing else is skipped, and skips are never silent.

Production is PostgreSQL 17; PGlite is 18. Postgres 18 records `NOT NULL` as a
`pg_constraint` row, which 17 does not, so those are excluded from the constraint
comparison and checked through column nullability instead — where the two agree.

---

## What the repository cannot rebuild

Say this plainly, because assuming otherwise is how a recovery fails at 3am:

- **No data.** Not one row. Schema only.
- **No auth users.** `auth.users` is platform-owned; the baseline only references it.
- **No storage objects.** Buckets and their policies are recreated; the files are not.
- **No platform config** — API keys, SMTP, OAuth providers, cron secrets, role
  timeouts (`authenticated` 8s, `anon` 3s).

See [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) for the full order of operations.
