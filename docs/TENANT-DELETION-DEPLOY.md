# Tenant deletion — deployment handoff (Session 75 → Session 106)

**Status: BUILT AND PROVEN, NOT APPLIED.** Session 106 owns landing.

`supabase/migrations/20260817090000_tenant_deletion_v1.sql`

---

## Why this exists

Deleting a business was not merely unbuilt — it was **impossible**. Measured on
production, 2026-08-17:

```
delete from auth.users where id = <tenant>
  ERROR: insert or update on table "audit_events"
         violates foreign key constraint "audit_events_user_id_fkey"
```

The cascade reaches eight tables carrying audit DELETE triggers (`customers`,
`invoices`, `jobs`, `quotes`, `payments`, `technicians`, `job_recurrences`,
`job_work_sessions`). Each fires `audit_log()`, whose INSERT names the tenant —
while that tenant's `auth.users` row is disappearing.

## What it does

One transaction-local key, `edgehq.purging_tenant`, set only inside
`tenant_purge()` via `set_config(..., is_local => true)`. Two functions consult
it, and **both compare it to the row's own tenant**:

- `audit_log()` returns without inserting → the cascade mints no events
- `audit_events_immutable()` permits DELETE for that tenant's rows only

Immutability is not weakened, it is made precise. Audit rows stay append-only for
every caller in every session, except while the business those rows belong to is
being deleted. Setting the key by hand does not help: the comparison is per row,
which `verify:tenant-deletion` proves by trying exactly that.

## The state machine

| State | Meaning | Reversible |
|---|---|---|
| `active` | normal | — |
| `deactivated` | a pause | yes, `tenant_set_active(true)` |
| `deletion_requested` | grace period running | yes, `tenant_cancel_deletion()` |
| *(purged)* | rows gone, tombstone written | no |

`tenant_lifecycle` holds the state and is **read-own with no client write policy**
— every transition goes through an RPC. It is deliberately NOT a column on
`business_settings`, whose contract is upsert-only for settings: a settings write
must never be able to move a tenant toward deletion.

`tenant_deletions` is the platform tombstone. `tenant_user_id` is a bare uuid with
**no foreign key**, precisely so the row outlives the identity it names. It holds
who asked, when, what was removed and how much — never the tenant's business data.
`service_role` only; no client role reads the deletion ledger.

## Authorisation

Every RPC authorises on `auth.uid()` alone. `tenant_purge()` takes **no tenant
parameter**, so there is nothing to forge. There is no operator override and no
admin path: a business is deleted by the person who owns it, or not at all. A
worker holds a different uid and reaches none of it.

## What it deliberately does NOT do

Session 75's fixture cleanup reached for `session_replication_role = replica` and
learned why that is unsafe: it disables **FK triggers too**, so `ON DELETE CASCADE`
never fires and every tenant row is left orphaned behind a deleted identity. This
migration disables no triggers, touches no `session_replication_role`, and drops no
foreign key. `verify:tenant-deletion` asserts all three.

It also does not delete `auth.users`. That belongs to GoTrue, and doing it inside
the purge would put the cascade back in front of us. **Order: purge first, then
remove the identity** — by which point nothing references it.

## Ordering

Not a hand-maintained list, which would rot the week a table is added. The purge
deletes from every tenant-owned table and **retries** the ones a foreign key
refused, until a pass frees nothing. Intra-tenant references resolve themselves;
the bound is the table count. New tables are handled automatically.

## Apply steps

```bash
# 1. Prove it still builds from zero (it does today: 29 statements)
npm run verify:rebuild

# 2. Apply
#    supabase/migrations/20260817090000_tenant_deletion_v1.sql

# 3. Resync — the baseline is generated FROM production
npm run schema:contract
npm run schema:baseline
npm run verify:rebuild     # now faithful
npm run verify:schema      # production and repo agree

# 4. Move the shipped file to supabase/archive/ledger/
```

⚠️ **`verify:rebuild` is RED until step 2 runs, and that is expected, not a
regression.** The repo describes objects production has not created yet. Every diff
it reports is exactly this migration's own objects: two tables, three indexes, four
new functions, two changed function bodies (`audit_log`, `audit_events_immutable`),
one policy. Anything else in that diff is somebody else's drift, not this lane's.

⚠️ `audit_log` must keep its parameter default `p_meta jsonb default null::jsonb`.
Dropping it fails with *cannot remove parameter defaults from existing function* —
which is how the first draft of this migration failed.

## Proof

`npm run verify:tenant-deletion` — 38 checks, no credentials needed. It builds the
schema from the apply path in PGlite, seeds two tenants and a worker, then:

- reproduces the original defect (a naive identity delete is still refused)
- runs the attacks: foreign tenant, forged purge key, replay, retry after
  interruption, already-deleted, anonymous caller, worker-initiated deletion,
  purge-before-request, purge-during-grace
- proves **zero residue by captured uuid** across every tenant table, plus storage
  including the booking-token-keyed objects that carry no owner
- proves the bystander tenant is untouched — rows, audit history and storage
- proves the identity then deletes cleanly, which is the whole point
- proves immutability still refuses ordinary deletes and updates

⚠️⚠️ The residue check captures the uuids as **literals before deleting** and
searches by those literals. It never writes
`where user_id in (select id from auth.users where …)` — that live subquery through
deleted identities is what produced Session 75's vacuous zero-residue proof, and it
is the reason this guard exists in this shape.
