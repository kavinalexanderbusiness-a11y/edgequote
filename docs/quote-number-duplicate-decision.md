# Duplicate and malformed quote numbers — decision report

_Read-only. Generated 2026-08-30 07:54:32Z against production, signed in as owner a12a0549… (RLS scopes every read to this tenant)._

⛔ **Nothing in this report has been changed.** No quote was renumbered, no row
was written, and no decision has been made. Stage 2 of
`supabase/proposals/quote_number_integrity_v1.sql` stays commented out until
the owner rules on each pair below.

**114** quotes visible. **2** duplicated number(s), **2** malformed number(s).

---

## Duplicated numbers

### `EPS-2026-0008` ×2

The two rows were created **71 minutes apart**, which is why this was a stale
read rather than a race: no two requests were ever in flight together.

#### FIRST (original) — quote `41259e2e…`

| field | value |
| --- | --- |
| quote id | `41259e2e-9254-4cdc-a622-a5243648ca5b` |
| quote number | `EPS-2026-0008` |
| created_at | 2026-06-09 23:28:47 |
| customer | Nicole Blackburn (`1a0ee43e…`) |
| address | 12808 Canso Crescent Southwest |
| service | Weekly Mowing |
| amount (total) | $75.00 |
| accepted amount | — |
| status | **scheduled** |
| issued / valid until | 2026-06-09 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-06-10 00:29:51 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | **none** |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** nothing the database can see — no customer acceptance, payment, invoice, job, sent message or portal token points at it.

#### LATER (#2) — quote `84e3176e…`

| field | value |
| --- | --- |
| quote id | `84e3176e-1295-4aa4-af69-7961e413c499` |
| quote number | `EPS-2026-0008` |
| created_at | 2026-06-10 00:40:01 |
| customer | Shaina (`8b8ae91b…`) |
| address | 276 Sandstone Place Northwest, Calgary, AB |
| service | Spring Cleanup |
| amount (total) | $225.00 |
| accepted amount | — |
| status | **completed** |
| issued / valid until | 2026-06-10 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-06-23 05:39:57 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | `45eeb39c…` completed on 2026-06-13 ($250.00) |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** 1 linked job.

**Options for `EPS-2026-0008`, and what each costs:**

1. **Leave both as they are.** Stage 1 already prevents any new quote from
   taking this number, including via a backdated `created_at`. The cost is
   that stage 2 (a full `UNIQUE (user_id, quote_number)`) can never be
   enabled, so the guarantee stays split across a registry and a partial
   index instead of one constraint.
2. **Renumber the later row to the next free number in its year series.**
   Cheapest in the database, and it unblocks stage 2. The cost is that any
   document or message already showing the old number now disagrees with
   the record — see the evidence rows above for how far that reaches.
3. **Renumber the later row and re-issue it to the customer** so the paper
   trail matches. Highest effort, lowest ambiguity.

⭐ Worth noting: exactly one of these two rows (`41259e2e…`, created
2026-06-09 23:28:47, Nicole Blackburn) has **nothing
downstream pointing at it** that the database can see — no customer acceptance,
payment, invoice, linked job, sent message or portal token. That makes it the
cheapest one to renumber if option 2 or 3 is chosen — but "cheapest" is an
input to the decision, not the decision. ⛔ This report does not choose.

### `EPS-2026-0009` ×2

The two rows were created **77 minutes apart**, which is why this was a stale
read rather than a race: no two requests were ever in flight together.

#### FIRST (original) — quote `638e99d2…`

| field | value |
| --- | --- |
| quote id | `638e99d2-9cb0-4072-b9e5-8182cc5bc6cb` |
| quote number | `EPS-2026-0009` |
| created_at | 2026-06-09 23:28:48 |
| customer | Sherryl (`85c8d958…`) |
| address | 192 Riverbend Drive Southeast |
| service | Lawn Mowing |
| amount (total) | $65.00 |
| accepted amount | — |
| status | **scheduled** |
| issued / valid until | 2026-06-09 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-06-14 02:05:40 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | `17810954…` completed on 2026-06-13; `23360017…` completed on 2026-06-19; `b9d339d2…` completed on 2026-07-04; `12e2a7df…` completed on 2026-07-10; `143755f4…` completed on 2026-07-24; `b12bf4e5…` completed on 2026-08-08 |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** 6 linked jobs.

#### LATER (#2) — quote `192cdcbc…`

| field | value |
| --- | --- |
| quote id | `192cdcbc-2098-47f7-abd4-49ed911c8347` |
| quote number | `EPS-2026-0009` |
| created_at | 2026-06-10 00:45:30 |
| customer | Shanth Kumar  (`415a0274…`) |
| address | 162 Auburn Sound Circle Southeast, Calgary, AB |
| service | Lawn Mowing |
| amount (total) | $65.00 |
| accepted amount | — |
| status | **scheduled** |
| issued / valid until | 2026-06-10 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-08-11 07:51:24 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | **none** |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** nothing the database can see — no customer acceptance, payment, invoice, job, sent message or portal token points at it.

**Options for `EPS-2026-0009`, and what each costs:**

1. **Leave both as they are.** Stage 1 already prevents any new quote from
   taking this number, including via a backdated `created_at`. The cost is
   that stage 2 (a full `UNIQUE (user_id, quote_number)`) can never be
   enabled, so the guarantee stays split across a registry and a partial
   index instead of one constraint.
2. **Renumber the later row to the next free number in its year series.**
   Cheapest in the database, and it unblocks stage 2. The cost is that any
   document or message already showing the old number now disagrees with
   the record — see the evidence rows above for how far that reaches.
3. **Renumber the later row and re-issue it to the customer** so the paper
   trail matches. Highest effort, lowest ambiguity.

⭐ Worth noting: exactly one of these two rows (`192cdcbc…`, created
2026-06-10 00:45:30, Shanth Kumar ) has **nothing
downstream pointing at it** that the database can see — no customer acceptance,
payment, invoice, linked job, sent message or portal token. That makes it the
cheapest one to renumber if option 2 or 3 is chosen — but "cheapest" is an
input to the decision, not the decision. ⛔ This report does not choose.

---

## Malformed numbers (no year segment)

⛔ **These are not duplicates and nothing here proposes renaming them.** They are
reported because they belong to no year series, which is exactly why a counter
can never protect them and only the claim registry can: the registry claims the
literal string, so `EPS-0002` cannot be reissued even though no `EPS-<year>`
counter has ever heard of it. They do not block stage 2 — a full UNIQUE cares
about duplication, not about shape.

#### MALFORMED `EPS-0002` — quote `3b5b9075…`

| field | value |
| --- | --- |
| quote id | `3b5b9075-73df-409c-8582-db8a1c7dbc8e` |
| quote number | `EPS-0002` |
| created_at | 2026-06-05 21:13:40 |
| customer | Nicole (`1a0ee43e…`) |
| address | 12808 Canso Crescent Southwest, Calgary, AB |
| service | Weekly Mowing |
| amount (total) | $75.00 |
| accepted amount | — |
| status | **scheduled** |
| issued / valid until | 2026-06-05 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-07-17 06:00:07 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | **none** |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** nothing the database can see — no customer acceptance, payment, invoice, job, sent message or portal token points at it.

#### MALFORMED `EPS-0009` — quote `ab69a485…`

| field | value |
| --- | --- |
| quote id | `ab69a485-2d0a-4f2a-9dba-83e70839b351` |
| quote number | `EPS-0009` |
| created_at | 2026-06-06 18:42:33 |
| customer | Noor (`79d767d8…`) |
| address | 213 Hidden Hills Place Northwest, Calgary, AB |
| service | Lawn Mowing |
| amount (total) | $65.00 |
| accepted amount | — |
| status | **scheduled** |
| issued / valid until | 2026-06-06 / — |
| sent_at | — |
| acceptance evidence (customer) | **none** |
| acceptance rows written by a migration | legacy_unrecorded stamped 2026-08-11 07:51:24 (Recorded before EdgeHQ kept acceptance evidence) — ⚠️ **backfill, not customer evidence**: this records that the business treated the quote as accepted, not that a customer was ever shown this number |
| job linked | `b0ee0ac3…` scheduled on 2026-09-05; `60759e90…` scheduled on 2026-09-19; `23ae1a47…` completed on 2026-08-09; `93e677ad…` completed on 2026-08-27; `cc2fbf11…` scheduled on 2026-10-17; `b74b692c…` scheduled on 2026-10-03; `0dd29003…` completed on 2026-06-16 |
| invoice linked | **none** |
| payment linked | **none** |
| outcome recorded | — |
| change orders | — |
| line items / options / add-ons | 0 / 0 / 0 |
| follow-ups / measurements | 0 / 0 |
| message naming this number | none found in the message log |
| portal reachable | no portal token issued |
| PDF containing this number | ⚠️ **NOT MEASURABLE.** Quote PDFs are rendered on demand and never stored, so the database cannot say whether one was produced or downloaded. Treat `sent_at` and the message log above as the best available proxy. |

**What a renumber of this row would have to be chased through:** 7 linked jobs.

---

## What this report is for

Stage 2 of the migration is commented out and stays that way until each pair
above has an owner decision. Stage 1 is not waiting on any of this: it protects
every new quote the moment it is applied, without touching one historical row.

