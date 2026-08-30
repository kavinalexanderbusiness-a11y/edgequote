# Quote-number integrity — the cutover

**For S106, at landing time.** Session 123. Branch `session123/quote-number-integrity`.

⛔ Nothing in this document has been executed. No schema is applied, no production
row has been written, and no historical quote has been renumbered.

---

## The one-line version

**Schema first, app second, and there is no window in between** — because the
schema change is backward-compatible with the currently-deployed app, and the
moment it commits it is already protecting every write the old app makes.

---

## Why there is no write window

The obvious worry with a schema-first landing is the interval between "the
barrier exists" and "the app uses the new allocator". During that interval the
**old** app is still deployed and still mints numbers with `MAX()+1` in the
browser. Three things make that interval safe rather than merely short:

1. **The old app's inserts are protected, not broken.** The claim registry's
   trigger fires on every insert regardless of who wrote it. If the old app's
   `MAX()+1` produces a number the tenant has already used, the insert is
   **refused** instead of silently duplicating. That is a strictly better outcome
   than today, where it succeeds and nobody notices.
2. **The old app's inserts keep the counter ahead of the data.** The same trigger
   performs the *watermark bump*: any number that arrives from outside the
   allocator pushes the counter past it. So the first call the **new** app makes
   cannot land on a number the old app just used. Without this the counter would
   fall behind during the interval and the first new-app allocation would collide.
3. **`allocate_quote_number()` exists before anything calls it.** The new app
   cannot be deployed first — it would call a function that does not exist yet.
   Schema-first is therefore mandatory, not preferred.

The reverse order is unsafe and the middle ground does not exist.

---

## Why the cutover itself has no window

Inside the migration there is a second, smaller version of the same problem: the
interval between *seeding* the claim registry from history and *installing* the
trigger that enforces it. A quote created in that interval would be claimed by
nothing.

§7 of `supabase/proposals/quote_number_integrity_v1.sql` closes it by being **one
transaction** (a `DO` block is one statement, therefore one transaction, in every
apply path this repo uses):

| # | statement | why it is in this position |
| --- | --- | --- |
| 1 | `lock table public.quotes in share row exclusive mode` | conflicts with the `ROW EXCLUSIVE` lock every INSERT/UPDATE/DELETE holds, so it **waits for in-flight quote writes to finish** and blocks new ones. Reads are untouched — the app keeps rendering. |
| 2 | seed `document_number_claims` from `select distinct … from quotes` | no quote write can be in flight, so the snapshot is complete. `DISTINCT` collapses each duplicated pair into one claim and touches no row. |
| 3 | create the claim + release triggers | same transaction, so they are visible to every writer that was waiting on the lock. |
| 4 | `v_cutoff := clock_timestamp()`, then create the partial unique index | taken **after** the lock, so no row that could still be written predates it. |
| 5 | commit | releases the lock. The first write to proceed already fires the triggers. |

There is no gap between "seeded" and "enforced" because they are the same commit.

⚠️ **The lock is held for the length of a `SELECT DISTINCT` over `quotes` and an
index build over zero qualifying rows.** Production holds 114 quotes; this is
milliseconds. Stated because on a large table it would not be.

### The literal cutoff is gone

The previous draft created the partial index over `created_at >= '<some
timestamp>'` and asked S106 to edit that literal to the apply date. There is no
correct value for it:

- a cutoff **before** apply cannot be indexed — history violates it;
- a cutoff **after** apply leaves every row created in between unprotected.

So the literal was removed rather than documented. The cutoff is measured inside
the transaction, after the lock. **S106 edits nothing in this file except its
filename.**

---

## The sequence

```
1 · INSPECT THE LEDGER
    Read the live migration ledger and take the next version number from it.
    ⛔ The proposal carries no version stamp on purpose — a version invented in
       S123 would be a guess about what lands before it.

2 · STAMP
    git mv supabase/proposals/quote_number_integrity_v1.sql \
           supabase/migrations/<version>_quote_number_integrity.sql
    ⛔ Change NOTHING else in the file. It contains no placeholder, no literal
       cutoff and no value that depends on when it runs.

3 · APPLY (schema only — the app is still the OLD build)
    Apply the file. It will refuse rather than half-apply if:
      • book_service() or submit_booking() no longer contains the MAX()+1 text
        it expects  (re-measure before forcing anything)
      • any function still allocates quote numbers with MAX()+1
      • any existing quote is not in the claim registry
      • either claim trigger is missing
    A refusal here is recoverable. A silent partial apply is not.

4 · VERIFY ON THE LIVE DATABASE (read-only)
    npx tsx scripts/inventory-quote-numbers.ts
      → still 114 quotes, still exactly 2 duplicated numbers, still 2 malformed.
        ⭐ The count must be UNCHANGED. This migration renumbers nothing.

    select count(*) from public.document_number_claims;
      → one row per DISTINCT quote number: 114 quotes − 2 duplicate rows = 112.

    select * from public.document_number_counters;
      → one row per (tenant, prefix, year), next_value one past that series'
        highest well-formed number.

    ⚠️ Between steps 3 and 5 the OLD app is live against the NEW schema. That is
       the designed state, not a race: its inserts are claimed and they advance
       the counter. If a duplicate were attempted it is refused with
       "quote number … has already been used by this business" — visible to the
       owner as a failed save, which is the correct outcome.

5 · DEPLOY THE APP
    The six creation doors now call lib/quoteNumber.allocateQuoteNumber().
    The two undo-restore doors deliberately do NOT — they re-insert a row that
    keeps the number it was issued, and the release trigger is what lets that
    work.

6 · CONFIRM
    Create one quote in the deployed app. Its number must continue the existing
    series (next after the current maximum), not restart at 0001.
```

---

## Rollback

| step reached | how to undo |
| --- | --- |
| after 3, before 5 | Drop the two triggers. The old app is unaffected — it never called the allocator. The registry and counters can stay; they are inert without the triggers. |
| after 5 | Redeploy the previous app build. ⛔ Do **not** drop the triggers as well: the old build mints `MAX()+1`, and the triggers are the only thing stopping it duplicating again. |

⭐ The migration adds two tables, one column, four functions, two triggers and one
index. It **alters no existing column and rewrites no existing row**, so there is
nothing to restore from backup.

---

## What is NOT in this landing

**Stage 2 — the full `UNIQUE (user_id, quote_number)` — stays commented out.** It
cannot be created while production holds `EPS-2026-0008` ×2 and `EPS-2026-0009`
×2, and renumbering a customer-facing document is the owner's decision.

⭐ **Nothing is unprotected while it waits.** Stage 1 already refuses any new
quote that reuses any number the tenant has ever held, including the historical
duplicates and including a caller that backdates `created_at` to slip past the
partial index. Stage 2 only collapses two barriers into one.

The evidence for that decision is in
[`docs/quote-number-duplicate-decision.md`](./quote-number-duplicate-decision.md),
regenerated read-only by `scripts/report-duplicate-quote-numbers.ts`.

---

## Also untouched, deliberately

`src/lib/invoicing.ts nextInvoiceNumber()` carries the **identical defect** —
read every `invoice_number`, take the max trailing digits, add one, no year
scope — and `invoices` has no unique constraint either. Another session owns
invoicing, so it is out of scope here. `document_number_counters.kind` and
`document_number_claims.kind` exist so invoices can adopt this allocator without
a second counter engine; both currently `check (kind in ('quote'))`, which is one
line to widen.
