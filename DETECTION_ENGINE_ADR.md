# ADR: one detection engine — `lib/signals/*` is canonical

**Status:** **ACCEPTED AS COMPLETE** (owner, 2026-07-17). **Design only — nothing
implemented.** Every open question is closed; the cadence-precedence rule is
decided (§Stage 0). **Not blocked — scheduled.** Implementation begins when the
owner schedules it, under the acceptance criteria below. Until then this document
is final: no further design work on it.

> Owner: *"lib/signals/* becomes the canonical detection engine. lib/reactivation.ts
> survives only as a consumer/report built on top of signals. I do not want two
> competing detection systems long-term."*

## ⛔ ACCEPTANCE CRITERIA — the owner's five conditions on implementation

Final as of 2026-07-17, when the ADR was accepted as complete. **These are the gate,
not advice.** Each already has a home below; they are restated here because they are
the terms the work is accepted on. A change that misses any of them is not "a first
pass" — it is not done.

| # | Condition | Where it lives | What "met" looks like |
|---|---|---|---|
| 1 | **Preserve backwards compatibility** | §3 | `computeReactivation` / `loadReactivation` / every exported type keep their exact signatures. Both consumers (`dashboard/data.ts`, `dashboard/priorities.ts`) need **zero edits**. signals' 9 consumers are untouched. No DB change. |
| 2 | **Use differential testing** | §5a | Old vs new run over the **live book**, deep-equalled. Both engines are pure → no DB, no mocks. The old implementation stays until the harness is green; that is what makes Stage 1 revertible. |
| 3 | **Identical behaviour on all production-valid data** | §3, §5a | Not "close" — **identical**: same `ranOuts` (membership, order, `daysSince`, `perVisit`, `cadence`, `isVip`), same lapse buckets, same `potentialRecovery` / `atRisk` / `reactivated`. **Any diff is a bug in the refactor, never an improvement to the report.** "Production-valid" is the precise scope, and it is not a loophole — it is bounded by #5: the only permitted difference is an invalid config (named cadence contradicting its recurrence row), of which there are **zero** today. On every row that exists, a correct migration changes nothing an owner can see. |
| 4 | **Eliminate duplicated thresholds — via alias → deprecate → delete** | Stage 2, §4 | The one that actually kills the second engine — Stage 1 alone leaves it dormant. The path is mandated, not optional: `VIP_THRESHOLD` becomes an alias of `VIP_LTV` in Stage 1, is marked deprecated, and is deleted in Stage 2 once no caller names it. Same for `reactivation.daysBetween`. End state: **zero** lifecycle constants and zero cadence maths in `reactivation.ts`, enforced by the §4 import-shape assertion, not by a comment. |
| 5 | **Document the intentional cadence change for invalid configs** | §Stage 0, §5d | #3 is "identical on production-valid data" — **not** "identical always", and the difference must be written down rather than discovered. A row whose named cadence contradicts its recurrence interval is an **invalid/mismatched config**; under the canonical rule its answer changes (`weekly`+`month/1`: 30 → **7**). Zero such rows exist today. Required: the change is stated in the migration's commit message and in `reactivation.ts`, and §5d asserts the rule in **both** directions so a future row cannot silently flip it. An intentional behaviour change that nobody wrote down is indistinguishable from a bug six months later. |

⚠️ **1 and 4 pull against each other, deliberately.** #1 says don't break callers;
#4 says delete the public `VIP_THRESHOLD`. The reconciliation is the alias →
deprecate → delete sequence in §3 — not a reason to skip #4. Nothing outside
`reactivation.ts` imports it today, so the cost is zero and the alias is a formality.

⚠️ **#3 has exactly one exception, and #5 is what keeps it honest.** The
cadence-precedence inversion (§Risks #2) is **decided, not open** — signals' rule
is canonical (§Stage 0). Adopting it *will* change the answer for a
`weekly`+`month/1` series: 7 days instead of 30. **No such row exists in
production**, which is why #3 ("all production-valid data") holds without
qualification on every row that exists. #5 bounds the exception rather than
excusing it: the change is written down, and §5d asserts the rule in both
directions so a future mismatched row gets an intentional answer, not a silent one.

---

## Context

Two engines answer "is this customer at risk / did they run out?", built in parallel
by two sessions, each believing it was the de-duplication:

- **`lib/signals/*`** — five modules (`cadence` · `constants` · `lifecycle` ·
  `value` · `index`). Shipped as *"one canonical detector engine (Phase 1
  de-duplication)"*.
- **`lib/reactivation.ts`** — a single file. Shipped as the engine that *"killed 4
  competing 'at risk' definitions"*.

**Both are now on `main`.** `guardian/dedup-2026-07-14` merged via PR #33
(`b67840d`, 2026-07-17), which carried the CEO dashboard and `lib/reactivation.ts`
with it. This ADR was drafted while that branch was still held and unmerged; the
hold is what would have blocked Stage 0, and it no longer applies.

**That raises the stakes rather than lowering them.** The two engines are no longer
one-per-branch, kept apart by an accident of process. They are **side by side in the
shipped tree**, and the divergence in §Risks #2 is now a property of production
code — latent, but resident.

This is the codebase's recurring failure mode, stated in the Pricing V2 roadmap:
**"one concept, two implementations — and the second copy was always the one that
priced."** Same disease, different organ.

### They are not actually rivals

The decisive observation: **they sit at different layers, and only one of them knows
it.**

| | `lib/signals/*` | `lib/reactivation.ts` |
|---|---|---|
| Kind | **primitives** — predicates + constants | **an aggregate** — builds a report |
| Exports | `ranOut` `isLapsed` `churnRisk` `isVip` `isSeasonallyDormant` `lifetimeValue` `visitValue` `cadenceDays` `daysBetween`, + `VIP_LTV` `CHURN_RATIO_*` `RANOUT_URGENT_*` `LAPSE_BUCKET_DAYS` | `computeReactivation` `loadReactivation`, row/report types, `VIP_THRESHOLD`, `daysBetween` |
| Consumers | **9** — including `reactivation/page.tsx` itself | **2** — `lib/dashboard/data.ts`, `lib/dashboard/priorities.ts` |
| Has an aggregate? | no | **yes — the only one** |
| Home | `main` | `main` (arrived via PR #33) — **they are now neighbours** |

**signals already claims reactivation's ground, in its own source:**

- `constants.ts`: *"VIP_LTV … Was duplicated in suggestions, **reactivation**,
  customerHealth and revenueIntelligence."*
- `cadence.ts`: *"Previously four byte-identical copies: suggestions…,
  customerHealth…, revenueIntelligence… and **an inline block in the reactivation
  page**."*

It was **built to absorb reactivation** and names it as one of the four it
de-duplicated. Meanwhile `reactivation.ts` imports nothing from signals and
re-declares the same constants.

But deleting `reactivation.ts` would destroy the one thing signals lacks — the
report — plus its generic `<C extends {id:string}>` (count-only callers skip
fetching customers) and the quote-cadence-price-over-frozen-job-price rule.

---

## 1. Canonical architecture

**`lib/signals/*` is the vocabulary. `lib/reactivation.ts` is one report spoken in
it.** The duplication to delete lives *inside* reactivation.ts — its private copies
of primitives signals already owns.

```
  lib/signals/*            PRIMITIVES — the ONLY home for lifecycle
  ├── constants.ts         thresholds (VIP_LTV, CHURN_*, RANOUT_*, LAPSE_BUCKET_DAYS)
  ├── cadence.ts           cadenceDays()  — THE "days between visits" answer
  ├── lifecycle.ts         ranOut() isLapsed() churnRisk() isSeasonallyDormant()
  ├── value.ts             lifetimeValue() visitValue() isVip()
  └── index.ts             the public surface
        ▲                  pure · no I/O · no aggregates · imports nothing of ours
        │ consumes (one direction, always)
  lib/reactivation.ts      THE REACTIVATION REPORT — an aggregate, not a detector
        │                  computeReactivation() = ranOuts + lapse buckets +
        │                  potentialRecovery + reactivated. Owns NO thresholds,
        │                  NO cadence maths, NO lifecycle predicates.
        │                  loadReactivation() = the loader (I/O lives here, not in signals)
        ▼
  consumers                dashboard/data.ts · dashboard/priorities.ts · pages
```

This is the repo's established shape — `lib/timeline.ts` (pure engine) +
`timelineData.ts` (loader) + `TimelineCard` (UI), and `lib/comms/reach.ts` (pure,
owns the *reason*). Nothing new is invented here; a wrong layering is corrected.

**Rule of thumb for the future:** if it answers *"what is true about this
customer?"* it belongs in `signals`. If it answers *"what should this screen
show?"* it belongs in a report.

---

## 2. Migration sequence

Four stages. Each is independently verifiable and independently revertible.

### Stage 0 — ✅ DECIDED (2026-07-17). No work remains here.

The CEO-dashboard hold no longer blocks this: PR #33 put `reactivation.ts` on
`main`, so Stage 1 refactors shipped code on a normal branch rather than rewriting
held work.

**THE CANONICAL CADENCE RULE — signals' precedence.** Owner, 2026-07-17:

> *"The named service cadence is the semantic source of truth. The recurrence row is
> the scheduling mechanism."*

That is the whole rule, and it decides §Risks #2's three divergent cases in signals'
favour: `weekly`+`month/1` → **7**, not 30. It is not a tie-break — it is a
statement about what the two fields *mean*. A cadence names the deal the customer
agreed to; a recurrence row is the machinery that materialises visits from it. When
they disagree, the machinery is what drifted — so the name wins, and the row is the
thing to go fix.

**This rule is now load-bearing beyond this ADR.** Any future code answering "how
often does this customer get served?" reads `cadenceDays(cadence, rec)` and inherits
it. A second answer is a second engine.

### Stage 1 — reactivation consumes signals (behaviour-preserving)

Replace each private copy with the canonical import. `computeReactivation`'s
signature, types and output **do not move**.

| in `reactivation.ts` today | becomes |
|---|---|
| inline `cadDays` ternary chain (`:169-172`) | `cadenceDays(freq, rec)` |
| inline ran-out block (`:157-186`) | `ranOut({...})` filtered on `.isUrgent` |
| `VIP_THRESHOLD` | `VIP_LTV` |
| local `daysBetween` | signals' `daysBetween` |
| `seasonForService` + `isWithinSeason` pair (`:146-148`) | `isSeasonallyDormant(...)` |

**Gate:** the differential harness (§5) reports an identical report on live data.
A diff is a bug in the refactor, not an improvement to the report.

### Stage 2 — delete the second system

Stage 1 leaves the duplicates dormant; **this is the stage that actually kills
them.** Remove `VIP_THRESHOLD` (aliased in Stage 1 → deleted here once no caller
names it) and `reactivation.daysBetween`. `grep -rn "VIP_THRESHOLD\|LAPSE_BUCKET\|
interval_unit === 'week'" src/lib/reactivation.ts` must return **zero**.

### Stage 3 — make regression impossible

Add the import-shape assertion (§4) to the verify suite. Without it, copy #3
appears the next time someone is in a hurry — which is precisely how copy #2 got
here.

---

## 3. Compatibility plan

**The migration is invisible to every consumer. That is the acceptance bar.**

- **`reactivation.ts`'s public API is unchanged**: `computeReactivation`,
  `loadReactivation`, `RJob`, `RQuote`, `RRecurrence`, `RanOutCustomer`,
  `RiskCustomer`, `Bucket`, `ReactivationReport` keep their exact signatures. Its
  two consumers (`dashboard/data.ts`, `dashboard/priorities.ts`) need **zero edits**.
- **`lib/signals/*` does not change at all.** Its 9 consumers are untouched. This
  ADR changes *who calls it*, never *what it does*.
- **No DB change, no migration, no new columns.** Both engines are pure functions
  over rows already fetched.
- **Only `VIP_THRESHOLD` leaves the public surface**, via alias → deprecate →
  delete. Nothing outside `reactivation.ts` imports it today.
- **Output is byte-identical on live data by construction.** Production's 15
  recurrences are exactly two shapes — `weekly/week/1` and `biweekly/week/2` — both
  of which the two engines already agree on. A correct Stage 1 changes nothing an
  owner can see.

---

## 4. Import rules

These are the rules that keep the layering from inverting again.

1. **`lib/signals/*` MUST NOT import from `lib/reactivation.ts`.** It would be
   circular and would invert the layering. signals imports nothing of ours beyond
   leaf utilities.
2. **`lib/reactivation.ts` MAY import from `lib/signals`** — and must import
   *every* lifecycle predicate, threshold and cadence answer it needs. It may not
   define its own.
3. **`lib/reactivation.ts` declares NO lifecycle constants and NO cadence maths.**
   Not a threshold, not a ratio, not a day-count ternary. If a number describes
   *when a customer is at risk*, its only home is `signals/constants.ts`.
4. **No surface (page, component, route) may reimplement a lifecycle predicate.**
   Import `signals`, or import a report that did. This is the rule the four
   original copies broke.
5. **I/O stays out of `signals`.** It is pure and client-safe. Loaders
   (`loadReactivation`) live with their report.
6. **One aggregate per question.** If a second "at risk" report is ever needed, it
   composes `signals` — it does not fork `reactivation`.

**Enforcement is mechanical, not cultural.** `verify-trades` already proves this
pattern works: it asserts `lib/trades` imports nothing and that nothing outside an
allowlist imports it. Rule 3 gets the same treatment (§5) — a comment asking people
to be careful is what we have now, and it produced two engines.

---

## 5. Differential testing strategy

**The bar: prove the refactor changed nothing, on real data, before it lands.**

### 5a. The differential harness (Stage 1's gate — the load-bearing one)

Run **old vs new `computeReactivation` over the live book** and diff the whole
report, not a summary:

- same `ranOuts` — same customers, same order, same `daysSince`, `perVisit`,
  `cadence`, `isVip`
- same lapse buckets (`3+` / `6+` / `12+`) — same membership
- same `potentialRecovery`, `atRisk`, `reactivated`

Both implementations are **pure**, so this needs no database and no mocks: fetch
the rows once, call both, deep-equal the results. **Any diff fails the stage.**
Keep the old implementation until this is green — that is what makes Stage 1
revertible.

### 5b. Pin the agreements that make this safe (they are load-bearing)

These already hold and are *why* the migration is mechanical. Pin them so they
cannot rot:

- the ran-out window is `max(21, cadenceDays × 3)` on **both** sides
- `VIP_THRESHOLD` ≡ `VIP_LTV` ≡ 1500
- `cadenceDays` agrees for every shape live data contains

### 5c. Pin the trap (§Risks #1)

`reactivation.ranOuts` ≡ `ranOut(...).isRanOut && .isUrgent`. Assert that a
long-dead series (`daysSince > max(21, cad×3)`) is **`isRanOut: true` but NOT in
`ranOuts`** — it belongs in the lapse buckets. This is the assertion that catches
the most likely mistake in the whole migration.

### 5d. Pin the divergence (Stage 0's decision)

Once precedence is chosen, assert it directly: `cadenceDays('weekly', {month/1})`
returns the decided value, and `computeReactivation` agrees. Both sides of the
inversion get a case, so a future edit can't silently flip it back.

### 5e. The import-shape assertion (Stage 3)

Static, no execution: `lib/reactivation.ts` contains no lifecycle constant and no
cadence ternary; `lib/signals/*` imports nothing from `lib/reactivation`. Model it
on `verify-trades`' closure test.

**Style note:** every check states *why it exists*, in the house style — a test
that fails without explaining what it protects gets deleted by the next person in a
hurry.

---

## Risks

1. **⚠️ Ran-out semantics are NOT 1:1 — the most likely mistake.** signals separates
   `isRanOut` from `isUrgent` (a long-dead series is still ran-out, just not
   urgent). `reactivation` **conflates** them: its `ranOuts` are only the urgent
   ones, and the rest deliberately fall through to lapse buckets. Miss the
   `.isUrgent` filter and every long-dead series floods the red queue. Pinned by 5c.
2. **✅ Cadence precedence — DECIDED (2026-07-17); the risk is now managed, not
   open.** signals checks the named cadence first, then the recurrence row;
   reactivation checked the row first. Measured: 3 of 13 cases diverge —
   `weekly`+`month/1` → **7 vs 30**; `monthly`+`week/1` → **30 vs 7**;
   `biweekly`+`day/3` → **14 vs 3**. **Not live**: production has 15 recurrences in
   two shapes with **zero** mismatches, and `freq` is derived from the row via
   `effectiveFreq`, so they normally cannot disagree.
   **Resolution: signals' rule is canonical** (§Stage 0) — the name is the deal, the
   row is the machinery. The residual risk is no longer "which is right?" but "does
   anyone notice when it fires?", and that is what criterion #5 exists for: the
   change is documented and §5d asserts the rule in both directions, so the day a
   mismatched config appears its answer is intentional and traceable rather than a
   silent shift in who sits in the red queue.
3. **~~The hold~~ — RESOLVED, and it inverts.** This ADR was drafted while
   `reactivation.ts` lived only on held work. PR #33 (`b67840d`) merged that branch,
   so the file is now on `main`. Stage 1 is unblocked — **and the duplication is now
   shipped rather than quarantined.** The reason to act went up, not down.
4. **Two `daysBetween`.** Trivial, and literally the species.
5. **Sequencing vs Pricing V2.** Phase 0 sensors are in flight on `pricing/phase0`.
   This ADR touches neither pricing nor those sensors, so it can run in parallel —
   but it must not preempt Phase 0.
6. **The precedent.** The roadmap records that `labor.ts` already *is* four of the
   nine pricing engines and pricing ignores it. Same disease, same cure: promote the
   good engine, delete the copies, and do **not** invent a third home.

---

## Consequences

**Accepted:** one detection vocabulary; the reactivation report keeps its shape and
its callers; no user-visible change; a mechanical, revertible migration with a
byte-identical bar.

**Rejected — "delete `reactivation.ts`":** it holds the only aggregate, and signals
has no report. Deleting it removes real work and leaves the CEO dashboard with
nothing to call.

**Rejected — "merge them into one file":** that recreates the layering mistake in a
single module. Primitives and aggregates want different lifetimes, different tests
and different consumers.

**Rejected — "leave both, document the difference":** that is the status quo, and
the status quo is two engines that already disagree in three measured cases.

---

*Analysed on `guardian/dedup-2026-07-14` @ `5772167` — at the time, the only tree where both*
*engines coexisted; PR #33 (`b67840d`) has since put both on `main`. Every claim was verified by executing the real engines or*
querying production, not by reading. No code was changed to produce this document.*
