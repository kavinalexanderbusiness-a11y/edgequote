# Disaster recovery

Rebuilding EdgeQuote from nothing.

> ## Read this first
>
> **A schema rebuild is not a restore.** This repository can reconstruct the *shape*
> of the database — every table, function, policy, grant, trigger, index and bucket.
> It contains **no customer data whatsoever**: no customers, quotes, invoices,
> payments, jobs, messages or photos.
>
> Those come from a **Supabase backup**, and only from there. If backups are gone,
> the data is gone, and no amount of this document changes that.
>
> The two are separate operations and they happen in a specific order. Doing them
> out of order — restoring a backup over a freshly built schema — will fail or, worse,
> half-succeed.

---

## What you need before starting

| | |
|---|---|
| This repository | at the commit you intend to run |
| A Supabase backup | PITR or a daily snapshot. **Verify it exists before dropping anything** |
| Supabase account access | to create a project and restore |
| The env vars | see §5 — recovery stalls here more often than anywhere else |
| Stripe / Twilio / Resend credentials | the app boots without them and then silently cannot take money or send anything |

---

## Decide which situation you are in

| Situation | Do this |
|---|---|
| Database intact, schema damaged (bad migration, dropped object) | **Do not rebuild.** Restore PITR to just before the damage. §7 |
| Project or database lost entirely | Full rebuild: §1 → §6 |
| Standing up a second environment (staging) | §1 → §5, skip §2 (no data to restore) |
| Only Vercel is broken | Nothing here applies. §6 alone |

---

## 1. Database schema

Create a fresh Supabase project (PostgreSQL 17), then:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260814060714_baseline.sql
# then every later file in supabase/migrations/, in filename order
```

That is the whole schema step. One file, plus anything shipped after it.

**Do not run anything from `supabase/archive/`.** It holds ~10 older bodies of
`get_portal_data`; applying one replaces the live function with an earlier version
silently, and the customer portal starts returning less with no error. The archive
exists to answer "why is this column here?", nothing more.

Verify before continuing:

```sql
select count(*) from pg_class c join pg_namespace n on c.relnamespace=n.oid
  where n.nspname='public' and c.relkind='r';        -- expect 103
select count(*) from pg_policies where schemaname='public';  -- expect 332
select public.schema_fingerprint();                  -- compare to supabase/contract/fingerprint.json
```

If the fingerprint matches, the schema is right. If it does not, stop — do not
restore data onto a schema you have not confirmed.

### What the baseline assumes the platform provides

A fresh Supabase project supplies all of this. Anywhere else, it is your bill —
`scripts/schema/platform-prelude.sql` is the executable statement of it:

- roles `anon`, `authenticated`, `service_role`, `authenticator`
- schemas `auth`, `storage`, `extensions`, `net`, `supabase_migrations`
- `auth.uid()`, `auth.jwt()`, `auth.role()`, and the `auth.users` table (93 FKs point at it)
- `storage.buckets`, `storage.objects`, `storage.foldername()`
- extensions `pg_net`, `pg_stat_statements` (the rest the baseline creates itself)
- `search_path` including `extensions` — 73 column defaults call `uuid_generate_v4()`
  unqualified and resolve through it
- role statement timeouts: `authenticated` 8s, `anon` 3s

---

## 2. Data

**From a Supabase backup. There is no other source.**

- **PITR** — restore to a timestamp. Preferred: it brings `auth.users` and storage
  metadata with it.
- **Daily snapshot** — restore the whole project.

If the backup restores the schema too, §1 was unnecessary — that is fine and
expected. §1 is for the case where you have data to bring into a *new* project, or
no data at all.

**Never** reconstruct invoices, payments or quotes from application logic. The
money ledger is authoritative; anything derived is a fabrication.

---

## 3. Auth

Not rebuildable from this repository, by design.

- `auth.users` comes from the backup. Restoring the public schema without it leaves
  every `user_id` foreign key dangling.
- **The owner account is the tenant.** Every row is scoped by `user_id`. A new owner
  account with a new UUID owns nothing — the data is present and invisible.
- Re-set in the dashboard: email/SMTP provider, redirect URLs, JWT expiry
  (`app.settings.jwt_exp=3600`), and any OAuth providers.
- Crew logins are rows in `public.technicians.auth_user_id` pointing at `auth.users`.
  They survive a backup restore and die with a fresh auth schema.

---

## 4. Storage

The baseline recreates the seven buckets and all 21 policies. **It does not
recreate the files.**

| Bucket | Public | Holds |
|---|---|---|
| `booking-uploads` | yes | customer photos from the booking form |
| `branding` | yes | business logo (used in PDFs) |
| `crew-media` | **no** | office → field reference photos, never customer-facing |
| `equipment-docs` | **no** | manuals, warranties |
| `expense-receipts` | **no** | receipts |
| `job-photos` | yes | proof of work, shown in the portal |
| `lead-uploads` | yes | public lead-form uploads |

The private ones are private deliberately. `crew-media` exists as its own private
bucket precisely because `job-photos` is public. **If you recreate buckets by hand,
re-check every `public` flag** — a private bucket recreated as public exposes
receipts and internal site photos.

Files themselves restore from the Supabase storage backup, or are gone. A missing
file renders as a broken image; it does not break the app.

---

## 5. Environment configuration

Recovery stalls here more than anywhere else. Set on Vercel *and* in `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY        # crew provisioning + npm run schema:contract
CRON_SECRET                      # unset ⇒ every cron returns 403, silently
ANTHROPIC_API_KEY
GOOGLE_MAPS_API_KEY
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
```

Plus, for anything that touches money or messaging: Stripe keys **and the webhook
secret**, Twilio credentials, Resend key and verified sending domain. The app runs
without them and simply cannot charge or send.

⚠️ **Cron on Vercel Hobby: any sub-daily schedule fails the entire deploy, silently.**
Keep every cron at daily or coarser.

---

## 6. Application

```bash
npm ci
npm run build          # the real gate; tsc alone does not catch what next build does
npm run verify         # every guard
```

Deploy to Vercel. Confirm afterwards by asking the deployments API, **not** commit
status — commit status has reported "pending" for deployments that were never created.

---

## 7. Point-in-time restore (the common case)

For a bad migration or a dropped object, **do not rebuild** — restore PITR to just
before the change. Then:

```bash
npm run schema:contract    # re-read what production now is
npm run schema:baseline    # regenerate
npm run verify:rebuild     # prove it still builds
npm run verify:schema      # confirm repo and production agree
```

A PITR rewinds `supabase_migrations.schema_migrations` too, so the repo will
legitimately be *ahead* of production afterwards. Reconcile deliberately rather
than reapplying everything and hoping.

---

## Rehearsal

An untested recovery procedure is a hypothesis. `npm run verify:rebuild` executes
§1 against a real Postgres every time it runs and diffs the result against
production's contract — that is the only part of this document that is continuously
proven. **§2, §3 and §4 are not.** Restoring a backup into a scratch project is the
only way to know those work, and it has not been done.
