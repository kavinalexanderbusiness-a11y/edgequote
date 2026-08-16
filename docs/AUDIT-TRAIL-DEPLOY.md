# Audit Trail + Accountability V1 — deployment handoff

The app half is committed and safe to deploy on its own. **Until the migration is
applied, every History surface reports "the history could not be loaded" and
offers Try again** — that is the honest failure state, not a broken page, and it
is deliberate: an unreadable history must never render as "nothing happened".

---

## 1 · SQL migration — RUN ONCE

The full statement is `supabase/pending/2026-08-15-audit-trail-v1.sql`. It is
long (≈46 KB) and is **run-once** — it creates one table, 13 functions and 29
triggers (28 capture triggers across 10 tables, plus the immutability trigger on
`audit_events` itself). Do not paste a partial copy.

**Apply it as a single migration** named `audit_trail_v1`, either through the
Supabase SQL Editor (paste the whole file) or via MCP `apply_migration`.

It ends with a `do $$ … $$` block that proves its own privileges and raises if
anything is wrong, so a silent partial apply is not possible.

⚠️ **It is NOT in `supabase/migrations/`, on purpose.** A migration sitting in the
apply path that production has not run turns `verify:rebuild` red by design.

### After it succeeds — three steps, same sitting

```bash
npm run schema:contract      # re-capture production's catalogue
npm run schema:baseline      # fold audit_events into the generated baseline
npm run verify:rebuild       # empty Postgres + repo == production
```

Then **delete `supabase/pending/2026-08-15-audit-trail-v1.sql` and commit**. Once
the baseline carries the objects, a second copy of live DDL is the retired
`CANONICAL-get_portal_data.sql` mistake — the one that nearly deleted a live
portal projection. `verify:audit-trail` §1 fails if both files define
`audit_events`, and also if neither does.

---

## 2 · Environment variables

**None.** No new variables, no new secrets, no third-party service.

(For running the guard locally only: `npm i -D --no-save @electric-sql/pglite`.
⛔ Never add PGlite to `package.json` — Vercel builds already OOM.)

---

## 3 · Manual setup

**None.** No storage buckets, no auth settings, no cron entries, no dashboard
toggles. The Activity page appears in the sidebar and ⌘K automatically because it
is registered in `src/lib/modules.ts`.

---

## 4 · Deployment steps

1. Merge the branch to `main`.
2. Wait for CI green and Vercel **Ready**.
3. Confirm production is serving the exact SHA: `curl https://edgehq.ca/api/health`
4. Apply the SQL migration (section 1).
5. Run the three schema commands and commit the baseline + the deleted pending file.

Order matters only in that the app tolerates the table being absent, not the
reverse — deploying the app first is safe, applying the SQL first is also safe.

---

## 5 · Verification checklist

### Confirm the migration landed

```sql
-- 1. the table, its indexes and its immutability trigger
select count(*) as tbl from pg_class where relname = 'audit_events';                  -- 1
select count(*) as idx from pg_indexes where tablename = 'audit_events';              -- 5
select tgname from pg_trigger t join pg_class c on t.tgrelid = c.oid
 where c.relname = 'audit_events' and not t.tgisinternal;                             -- audit_events_no_mutate

-- 2. the capture triggers (10 tables)
select c.relname, count(*) from pg_trigger t join pg_class c on t.tgrelid = c.oid
 where t.tgname like 'trg_audit_%' and not t.tgisinternal
 group by c.relname order by c.relname;
-- change_orders 2 · customers 3 · invoices 3 · job_recurrences 3 · job_work_sessions 3
-- jobs 3 · payments 3 · quotes 3 · service_requests 2 · technicians 3

-- 3. nobody can write it
select has_table_privilege('anon','public.audit_events','select')          as anon_read,    -- f
       has_table_privilege('authenticated','public.audit_events','insert') as client_write, -- f
       has_function_privilege('authenticated',
         'public.audit_log(uuid,text,text,uuid,text,uuid,jsonb,jsonb,jsonb)','execute')     -- f
       as client_can_log;

-- 4. it is genuinely append-only (BOTH should ERROR)
update public.audit_events set action = 'x' where id = (select id from public.audit_events limit 1);
delete from public.audit_events where id = (select id from public.audit_events limit 1);
```

### Confirm it records reality

```sql
-- after moving one visit in the app:
select occurred_at, actor_type, actor_label, action, entity_label, before, after
  from public.audit_events order by seq desc limit 5;
```

Expect `actor_type = 'owner'`, and `before`/`after` naming the two dates.

### What to test in-app

| Where | Do this | Expect |
|---|---|---|
| Schedule | drag a visit to another day | Activity shows "rescheduled visit", `Aug 18, 10:00 AM → Aug 20, 1:00 PM` |
| Quote detail | send, then mark accepted | two rows, in order, under History at the bottom of the page |
| Customer → More about this customer | open the disclosure | "Change history" listing that customer's changes |
| Invoices | record a cash payment | ONE row for the payment; the invoice reaching paid appears folded under its Detail, not as a second act |
| Workforce | disable a worker | "disabled access · Active → Disabled" |
| Portal (as a customer) | approve a quote | the row says **the customer**, not you |
| `/dashboard/activity` | filter Who / What / When | filters apply server-side; "Show earlier history" pages back |
| Any phone (375–430) | open History | rows readable, no sideways scrolling, whole row tappable to expand |

### Guards

```bash
npm run verify:audit-trail        # 115 checks; builds an empty Postgres and drives it
node scripts/mutate-audit-trail.mjs   # 12 deliberate breaches, all must be caught
npm run verify                    # the whole suite
```

`verify:audit-trail` needs **no credentials** — its behavioural half runs entirely
in PGlite, so it is fully meaningful in CI where the live halves of other guards
skip. Its §4 (live, over HTTP) skips cleanly without `VERIFY_FIXTURE_*`.

---

## 6 · What this does NOT do

- It does not price, bill or move money. Every figure in `before`/`after` is a
  descriptive snapshot; the quote/invoice/payment/ledger engines remain the
  financial truth and were not modified.
- It does not log wages, consent, message contents, measurements or UI activity.
  Each of those already has its own record (`wage_history`, `consent_changes`,
  `notification_log`, `property_measurement_events`) — one engine per
  responsibility.
- It does not expose anything to customers. `src/lib/audit/customerProjection.ts`
  exists for that and is an allow-list, but **no portal surface consumes it yet**;
  the customer-facing projection is available, not shipped.
- Workers get no business-wide audit access: their uid is nobody's tenant key, so
  RLS returns them nothing.
