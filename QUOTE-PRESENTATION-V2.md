# Quote Presentation V2 — the Phase 6 specification

**Status:** SPEC ONLY. No code written, none to be written yet.
**Place:** this is **Phase 6 ("The document")** of [Pricing V2](../memory/pricing-v2-roadmap-2026-07-16.md).
The roadmap defines Phase 6 in one line — *`quotes.viewed_at`, PDF accept link, good/better/best,
revisions fork*. This document is that line, specified.
**Gate:** the owner's standing order is **Phase 0 only — do not skip phases**. Phase 0 is ~2 of 7.
**This spec is redesign input. It is not a licence to build.** Build it when Phases 1–5 have landed.
**Date:** 2026-07-16, revised + APPROVED 2026-07-17 · **Code state:** `main` @ `f9014e1` ·
**Prod verified live.**

> ### 🔗 Read with — and not instead of — `quote-v2-spec-2026-07-17`
> A parallel session wrote **Quote Engine V2** ([[quote-v2-spec-2026-07-17]]), which maps the owner's
> 12 areas onto the roadmap's phases and tags **"Customer experience" as Phase 6** — this document.
> **They are a map and a territory, not rivals:** that spec answers *which phase owns what*; this one
> is the Phase 6 detail. They agree on the finding, independently — it reached *"quotes have no
> `viewed_at`; invoices DO"* by its own route, which is corroboration, not duplication.
> ⚠️ **Whoever implements Phase 6 must read both.** Two documents describing one phase is exactly the
> species the roadmap exists to kill; the mitigation is this cross-link and the fact that only one of
> them (this one) is the implementation spec. **If they ever disagree, this document is wrong until
> proven otherwise — the map was written against the whole plan; this was written against the code.**
> 📌 Its *"accept or nothing → every hesitation becomes a ghost"* is the origin of `counter_offered`
> in §5.0's taxonomy.

Every claim below was verified by reading code or querying production. Where a claim could not be
verified it is marked **[UNVERIFIED]** rather than asserted.

---

## §0 · The evidence, and its limits

| Probe (production, live) | Result |
|---|---|
| Quotes | **55** |
| Distinct customers ever sent a quote | **8** |
| Quote notifications sent (19 SMS + 11 email) | **30** |
| Quote notifications **confirmed delivered** | **1** |
| Quote notifications **ever opened** | **0** |
| ALL notifications ever (any type) | 189 → **5 delivered · 0 opened** |
| Invoices ever viewed in the portal | **3 of 25 (12%)** — the only real "a customer looked" signal |
| Quotes with `valid_until` set | **0 of 55** — expiry is inert |
| Quotes with an accept snapshot | **0** (columns live; nothing accepted since) |
| Quotes offering cadence options | **35 of 55 (64%)** |
| `quote_services` lines in existence | **2** |
| Of the 8 quotes that reached accept/decline | **5 were never marked sent · 7 had zero notifications** |

**The limit — read this before citing any number above.** One tenant (`select count(distinct user_id)
from quotes` = 1): the owner's own lawn company, an owner-operator selling face-to-face (13 quotes
were decided the same day they were created). These are single-tenant numbers.

They therefore **cannot** tell us customers don't want a premium quote. They tell us something
narrower and more useful: **the product has never once observed a customer look at a quote.** That is
a fact about our instrumentation, not about the market — and it is true regardless of tenant count.

---

## §1 · The finding

**The quote isn't unpolished. It's unseen — and nothing in the product would tell you either way.**

The request was "make the quote feel premium." The evidence says the quote is a document that,
as far as this system can prove, **no customer has ever opened**. 189 notifications produced 5
confirmed deliveries and **zero** opens. Quotes have no `viewed_at` at all — invoices do.

So Phase 6's first job is not typography. It is to make the document **observable**, then make it
**arrive**, then make it beautiful. In that order — and that order is not a preference, it is the
roadmap's own law applied one level up:

> **Sensors before the brain.** (roadmap, §Sequencing law)

Ship presentation without telemetry and the honest report afterwards is: *"we redesigned the quote;
we have no idea if it changed anything."* That is the same species the roadmap exists to kill — a
confident artefact with nothing underneath it.

**The premium feeling is not a skin. It is:** the customer receives it · it opens instantly on a
phone · it is obviously *about them and their property* · it answers "what am I buying, what does it
cost, what happens next" without a question · deciding takes one tap · and the business knows all of
that happened.

---

## §2 · What exists today (verified, `main` @ `f9014e1`)

| | Today |
|---|---|
| **Quote document** | No dedicated page. A **row in a shared "Documents" tab** with invoices ([PortalClient.tsx:898-1152](src/app/portal/[token]/PortalClient.tsx#L898-L1152)). No `/portal/[token]/quotes/[id]` route. |
| **First impression** | Amber signpost on Home: *"Your {service} quote is ready — {total} — review and approve when you're ready"* ([:580-587](src/app/portal/[token]/PortalClient.tsx#L580-L587)). Pure prospects get the hero suppressed so the quote is their whole visit ([:557](src/app/portal/[token]/PortalClient.tsx#L557)). **This part is good.** |
| **"What's behind this price"** | Real explain bullets — *"Priced for your measured {sqft} sq ft — measured, not guessed"*, travel, crew, *"Nothing is charged when you approve"* ([:949-959](src/app/portal/[token]/PortalClient.tsx#L949-L959)). **Also good. Keep.** |
| **Acceptance** | Tap → confirm dialog (*"Approve {amount}?"*) → `portal_accept_quote`. |
| **What accept writes** | **main:** a 1-line `status='accepted'` UPDATE. **PROD (live, ahead of main):** also `accepted_price = coalesce(accepted_price, total)`. Cadence deliberately NOT written. |
| **Decline** | ❌ **No self-serve decline.** No `portal_decline_quote` RPC exists. `declined` is owner-set only. |
| **Ask a question** | ❌ Not quote-scoped. Only the generic Request tab or replying to the SMS. |
| **Signature** | ❌ **Absent.** Full-repo grep: every hit is webhook/Stripe/Twilio request signing. |
| **Financing** | ❌ **Absent.** Deposits exist but are an **owner-only** ledger action ([ledger.ts:154-172](src/lib/payments/ledger.ts#L154-L172)), unreachable from the portal. Stripe checkout is full-amount only. |
| **`viewed_at`** | ❌ **Quotes have none.** Invoices do, with a `portal_mark_invoice_viewed` RPC and a `'viewed'` display status. |
| **Optional services** | ❌ Read-only breakdown. **Accept is all-or-nothing** — one RPC, one quote row. No per-line toggle. |
| **Cadence choice** | ❌ Reference text only (*"Weekly plan (per visit)"*). The customer picks nothing; the owner configures recurrence manually after. |
| **PDF** | Static. **No accept link, no signature area.** Never emailed — the template sends a **portal link**; the PDF renders **client-side on demand** ([portalPdf.ts:153-179](src/lib/portalPdf.ts#L153-L179)). |
| **Expiry** | Shown honestly when set (*"This quote has expired"*, neutral grey not red — a deliberate, good call at [:1746-1749](src/app/portal/[token]/PortalClient.tsx#L1746-L1749)). But **0 of 55 quotes have `valid_until`**, so it never fires. |
| **Mobile** | Genuinely good: `max-w-lg` phone-first, sticky scrollable tabs, `w-full sm:w-auto` CTAs, `text-base sm:text-sm` (defeats iOS zoom), safe-area insets, and a documented iframe-print fallback for mobile PDF. **Do not spend here.** |

### ⚠️ Prod is ahead of main — do not "fix" this by reverting
The **live** `portal_accept_quote` snapshots `accepted_price`; `main` has no such column. Phase 0's
code is on **`pricing/phase0` @ `0404781`, committed and NOT pushed**, while its migrations
(`RUN-2026-07-16c`, `RUN-2026-07-16d`) are **already applied to production**. A session reading only
`main` will conclude the snapshot doesn't exist — the audit for this spec did exactly that, and was
right about the repo and wrong about reality. See [[prod-schema-exceeds-main]]. **Pull
`pg_get_functiondef` before touching this RPC.**

---

## §3 · Settled decisions this spec inherits (do NOT re-litigate)

### 3a · From Pricing V2 Phase 0, owner 2026-07-16 ([[pricing-v2-phase0-2026-07-16]])

1. **Revisions ALWAYS create a new revision.** Never mutate a quote the customer already received.
   → `parent_quote_id` + version. **This resolves the revisions fork. §5.3 implements it; it does not reopen it.**
2. **Expired quotes do NOT count toward acceptance metrics**, and a `sent` quote past its date
   auto-reads Expired. (Supersedes [[quote-expiry-decisions]]'s display-only rule.)
3. **Units and Dimensions stay separate.** `units.ts`'s "a unit is a LABEL, never arithmetic" holds.
4. **Grandfather all existing recurring customers.** V2 prices NEW quotes only.
5. **Unknown stays unknown**, and lowers confidence — never a placeholder (margin.ts's rule,
   promoted). **§5 obeys this everywhere.**

### 3b · ⭐ From the owner accepting THIS spec, 2026-07-17 — these are settled

6. **Sequencing accepted, and it is an ORDER, not a preference:**
   **observable → delivery → presentation.**
7. **`viewed_at` ships BEFORE any presentation redesign.** *"We need real engagement data before
   optimizing the quote experience."* §6 step 1 is therefore a gate, not a suggestion — no
   presentation work starts until engagement data exists.
8. **Signature is OPTIONAL by default and configurable PER QUOTE.** Never mandatory.
   → answers §7.1. §5.6 is now settled: `settings` default OFF + a per-quote toggle.
9. **Deposit collection is NOT in Phase 6. No financing or deposit workflow.** Architecture stays
   **future-ready only.** → answers §7.2, and **overrides my own recommendation** — I proposed
   deposit-on-accept as the one real financing step; the owner declined it for Phase 6.
   §5.7 is now: a `payment_terms` data shape and nothing else. ⛔ Do not build a deposit flow.
10. **Good/Better/Best stays BLOCKED until Pricing V2 Phase 3.** Confirms §5.4.
11. **Keep the existing mobile experience and portal structure. Polish, do not rebuild.**
    Confirms §5.8/§5.9.
12. **Every customer interaction must be measurable.** → the new §5.0. This is the requirement that
    changed the architecture of this spec; read §5.0 before §5.1.

### 3c · ⭐ Owner accepted the `quote_events` architecture, 2026-07-17

13. **`quote_events` is THE canonical engagement event log.** All aggregates — `viewed_at`,
    `view_count`, et al — are **derived from it**. *"This matches the architecture we already use for
    payments and avoids multiple sources of truth."* → §5.0 is now settled architecture, not a proposal.
14. **The taxonomy is a stable vocabulary** so future features **extend this stream rather than
    inventing parallel tracking**. → §5.0's taxonomy table + naming laws. `option_selected` is the
    owner's name (an earlier draft said `option_accepted`); `counter_offered` and `question_asked`
    are theirs and are now reserved.
15. **Re-confirmed, and now hard constraints:** `time_to_first_view` stays blocked until Phase 0
    consolidates `markQuoteSent()` — ⛔ **do not introduce another `sent_at` writer**; `expired` stays
    **derived** — ⛔ **do not persist an `expired` event that could go stale when a quote is
    extended**; optional-service engagement stays deferred to Phase 3; deposit-on-accept stays out.

And Phase 0's harness-pinned rule, which §5.2 must not break:

> **RECORD TRUTH OR NOTHING.** An unknown cadence is OMITTED, never defaulted. Inferring one from a
> populated price column IS the bug those columns kill. ⛔ Do not "improve" it with a fallback.

---

## §4 · Architecture — the seams

**One document engine, three renderers.** Today `QuotePDF` is already shared by owner + portal via
`renderPortalQuoteBlob` (*"One PDF system, no second copy"*). **Preserve that.** V2 adds a web
renderer; it must not fork the content.

```
                 ┌─────────────────────────────┐
   quotes row ──▶│  lib/quoteDocument.ts       │  THE document model (new seam)
   quote_services│  → sections, totals,        │  Pure. No React, no PDF, no fetch.
   settings      │    explain bullets, options │  ONE place that decides WHAT a quote says.
   Phase 1-3 ────│                             │
   engine output └──────────┬──────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   Portal (web)        QuotePDF (print)    Email/SMS summary
   interactive         static, signed      the arrival
```

**Rules:**
- `lib/quoteDocument.ts` is the **only** place that decides what a quote says. Three renderers, one
  truth. The moment the PDF says something the portal doesn't, we have the species again.
- It **consumes** Phase 1–3's engine output. It never prices. It never imports `lib/pricing`.
- The explain bullets that exist today ([:949-959](src/app/portal/[token]/PortalClient.tsx#L949-L959))
  move **into** this seam — they are document content, currently trapped in a React component.
- **Financing, signatures and options are document *facts*, not renderer features.** If only the web
  renderer knows a signature exists, the PDF is a lie.

---

## §5 · The nine areas

### 5.0 · ⭐ The measurement model — `quote_events` (owner requirement, 2026-07-17)

> *"Every customer interaction should be measurable."* — the owner's added requirement, and the one
> that changed this spec's architecture. Read this before §5.1.

**The requirement breaks my own §5.1 design, and that is the useful part.** §5.1 originally said:
mirror `portal_mark_invoice_viewed` exactly — a single `viewed_at` timestamp, first-view-only,
`coalesce`'d. **A timestamp cannot produce "total view count."** One column answers *when*, never
*how many*. The required list needs an append-only log, not a field.

#### THE SEAM: an events ledger, and we already have the pattern
Do **not** invent a telemetry system. This app already runs exactly this shape for money:
`payments` rows are the truth and `invoices.amount_paid`/`status` are **trigger-derived** from them
([[payment-ledger-2026-06-27]]). Engagement is the same problem — an append-only fact stream with
derived convenience columns — so it gets the same architecture.

```
  quote_events  (append-only; ONE writer; the truth)
    quote_id · type · at · actor · meta jsonb
        │
        └── trigger ──▶  quotes.viewed_at        (= min(at) where type='viewed')
                         quotes.view_count       (= count where type='viewed')
                         quotes.first_viewed_at  (same as viewed_at; ONE of the two names ships — see below)
```

**Laws (all inherited, none new):**
- **ONE writer.** Every event goes through `lib/quoteEvents.ts`. Mirrors `lib/comms/log.ts`'s
  one-log-writer rule ([[comms-one-log-writer]]) — which exists because a second writer is how a log
  starts lying.
- **Append-only. Never update, never delete.** An event is evidence.
- **Derived columns are trigger-maintained, never hand-written.** Same rule as `amount_paid`.
  ⛔ If app code ever writes `quotes.view_count`, we have two truths and the ledger is decorative.
- **Record truth or nothing.** Phase 0's rule, unchanged. No inferred events, no backfill — see below.
- **A sensor must not change what the customer sees.** No read-receipts, no "seen" ticks.

#### ⭐ THE EVENT TAXONOMY (owner requirement, 2026-07-17)

> *"The `quote_events` specification should include a stable event taxonomy … so future features
> extend the same event stream rather than inventing parallel tracking."*

**This is the point of the whole section.** A ledger without a fixed vocabulary becomes
`notification_log.template` — free text that drifts until nobody can query it. The taxonomy is the
mechanism that makes *extending this stream* the path of least resistance, and inventing a parallel
tracker the expensive one.

**The vocabulary — v1. Reserved in full at step 1; emitted as each feature lands.**

| `type` | Meaning (a FACT, never a UI label) | Emitted by | Ships |
|---|---|---|---|
| `viewed` | the customer opened the quote document | portal quote view | **Step 1** |
| `pdf_downloaded` | they took the document away (download/print/share) | client — see §5.0 note | Step 6 |
| `question_asked` | they asked something about this quote | §5.2 | Step 3 |
| `accepted` | they agreed to it | `portal_accept_quote` | Step 3 |
| `declined` | they said no (`meta.reason`) | `portal_decline_quote` (§5.2) | Step 3 |
| `counter_offered` | they proposed different terms (`meta.amount`, `meta.note`) | ⚠️ not yet a feature — see below | ⛔ reserved |
| `option_viewed` | they looked at a plan option (`meta.option_key`) | §5.4 | ⛔ Phase 3 |
| `option_selected` | they chose a plan option (`meta.option_key`) | §5.4 | ⛔ Phase 3 |

**Naming laws — the taxonomy is only "stable" if these hold:**
- **Past-tense, snake_case, and a FACT about what happened.** Not a UI label, not a status.
  Renaming a button must never imply renaming an event.
- ⛔ **NEVER rename or re-use a type.** A rename orphans every historical row and silently changes
  what past data means. **Deprecate, never delete** — an append-only log's vocabulary is append-only too.
- **Additive only.** New feature → new type, appended here. That is the whole contract.
- **`meta jsonb` carries the specifics; the `type` never encodes them.** `option_selected` +
  `meta.option_key`, never `option_selected_weekly`. A type-per-value is how a vocabulary explodes.
- **One vocabulary, two enforcers** — mirror the existing `SYSTEM_UNITS` pattern exactly:
  `QUOTE_EVENT_TYPES` in `lib/quoteEvents.ts` is the source, a **DB CHECK** enforces it, and
  `verify:quote-events` pins that **the const and the CHECK agree** (as `verify:pricing` §14 already
  fingerprints `SYSTEM_UNITS` against the seeded rows, and as Phase 0 CHECK-pinned the 4-cadence
  vocabulary with a negative test proving the DB rejects a 5th).
  → The CHECK is deliberate friction: adding an event is a one-line migration; inventing a parallel
  table is a week. That asymmetry is the requirement, implemented.
- **Reserved ≠ built.** `counter_offered` is in the vocabulary and has no producer. Reserving costs
  nothing and prevents the next session inventing `quote_counters`. **It is not permission to build
  counter-offers.**

**⚠️ `counter_offered` is a new product concept this spec does not otherwise cover.** Nothing in the
app lets a customer propose terms today, and it raises a real question decision #5 already answers:
**a counter the owner accepts is a REVISION, not an edit** — never mutate the quote the customer
holds (§5.3). So the event is reserved, the feature is unspecified, and the architecture is already
decided if it's ever built. **[UNVERIFIED]** whether owners want this at all — it is a haggling
surface, and some trades price firm on purpose.

**Two events are deliberately NOT in the vocabulary:**
- ❌ `expired` — **derived, never stored** (decision #2). A stored `expired` goes stale the instant
  the owner extends `valid_until`, which is exactly the bug `quoteStatus.ts` already avoids.
  The metric is a query.
- ❌ `sent` — that fact belongs to **Phase 0's `markQuoteSent()`**, the one seam. An event here would
  be a **5th writer** of "sent" (§6). Phase 6 consumes; it does not compete.

#### The ten required interactions, mapped honestly

| # | Required (owner's words) | Model | Ships |
|---|---|---|---|
| 1 | **viewed** | event `viewed`, one row per view | **Step 1** |
| 2 | **first viewed** | derived `min(at)` — the column §5.1 wanted | **Step 1** |
| 3 | **total view count** | derived `count(*)` — **needs the ledger; a column can't do this** | **Step 1** |
| 4 | **time to first view** | derived `first_viewed_at − sent_at` | **Step 1**, ⚠️ reads *unknown* until Phase 0 |
| 5 | **accepted** | event `accepted`, beside `portal_accept_quote`'s existing snapshot | Step 3 |
| 6 | **declined** | event `declined` + `meta.reason` — **needs §5.2's `portal_decline_quote`, which does not exist** | Step 3 |
| 7 | **expired** | ⚠️ **NOT an event — derived.** Decision #2. | ⚠️ blocked on Phase 0's `valid_until` |
| 8 | **PDF downloaded** | event `pdf_downloaded` — the PDF renders **client-side**, so this is an explicit client call, not a server-observable fact | Step 6 |
| 9 | **optional services viewed** | event `option_viewed` (`meta.option_key`) | ⛔ **Phase 3** |
| 10 | **optional services accepted** | event **`option_selected`** (`meta.option_key`) — the owner's name; an earlier draft said `option_accepted`, and one name per fact is the rule | ⛔ **Phase 3** |

#### Three honest caveats on that list — none of them are reasons not to do it

- **#4 "time to first view" is currently unmeasurable, and not for a reason Phase 6 can fix.**
  It is `first_viewed_at − sent_at`, and **`sent_at` is unreliable today**: 5 of the 8 quotes that
  reached a decision were never marked sent, because there are **4 writers of "sent" with 4
  behaviours**. The fix is **Phase 0's `markQuoteSent()` seam** — already scoped there, explicitly
  called *"the species fix"*. **Phase 6 consumes that seam; it must not build a 5th writer.**
  → Until Phase 0 lands, ship the event and let the metric read *unknown*. Unknown stays unknown.
- **#7 "expired" cannot fire at all today.** `expired` is **derived**, never stored (decision #2,
  and `quoteStatus.ts` already does it right: *"a quote un-expires the instant the owner extends its
  date"*). But **0 of 55 quotes have `valid_until`**, so nothing can ever expire. Same root cause,
  same fix: `markQuoteSent()` writes `valid_until`. **Do not add an `expired` event** — that would
  store a derived state and re-break decision #2. The metric is a query, not a row.
- **#9/#10 are blocked with Good/Better/Best (decision #10).** You cannot measure a customer viewing
  options that don't exist. **Reserve the event types now, collect from Phase 3.** Reserving costs
  nothing; pretending to measure would produce a zero that reads like a finding.

#### Why an events table and not more columns
Ten interactions is not "a few flags". Columns would mean a migration per metric, no history (only
the latest), and no way to answer *"they opened it four times and never accepted"* — which is the
single most actionable sales signal in the list. The ledger answers questions we haven't thought of
yet; columns only answer the ones we thought of today.

⚠️ **Retention/consent is a real question this spec does not answer.** View counts are behavioural
data about a named person. First-party engagement on your own document is ordinary, but a retention
window and whether this ever appears in an export are **[UNVERIFIED]** and belong to a person, not a
commit. Flagged in §7.

---

### 5.1 · Observability — the first shipment (**ships first, alone — decision #7**)
**Why first:** the roadmap already calls it *"cheapest + highest impact"*. §0 explains why: we have
never observed a single quote view. Everything else in Phase 6 is unmeasurable until this exists.

**Scope of step 1** — the ledger (§5.0) plus the view event, and nothing else. It changes no pricing,
no copy, and nothing the customer sees.

- **`quote_events`** + `lib/quoteEvents.ts` (the one writer) + `portal_mark_quote_viewed(p_token,
  p_quote_id)` — the RPC **signature** mirrors `portal_mark_invoice_viewed`, which already exists and
  works. ⚠️ **Its BODY does not:** the invoice RPC `coalesce`s a first-view timestamp and is
  therefore idempotent by design. **The quote RPC must append every view** — `view_count` is a
  required metric and idempotency would silently destroy it. *This is the one place this spec
  deliberately diverges from the invoice precedent, and §5.0 explains why.* An earlier draft of this
  spec said "mirror it exactly"; the owner's requirement proved that wrong.
- **Derived, trigger-maintained:** `quotes.viewed_at` (first view) + `quotes.view_count`.
  A derived `'viewed'` display status mirroring `InvoiceDisplayStatus`.
  → Pick **one** name for first-view and use it everywhere. `viewed_at` matches invoices; the
  requirement's word is "first viewed". **Recommendation: `viewed_at`**, documented as first-view —
  a second name for one fact is how two truths start.
- ⚠️ **This is a sensor, not a feature.** No read receipts, no "seen" ticks, no customer-visible
  change whatsoever. Pinned in §9.
- **No backfill.** 55 quotes have no view history and never will. Inventing one from `sent_at` or
  status would launder a guess into the record — the same reasoning that stopped Phase 0
  backfilling `accepted_price`. **Unknown stays unknown.**
- **Also fix delivery truth** (this is the "improve delivery" step, and §0 says it may be the whole
  ballgame): `notification_log.delivered_at`/`opened_at` exist and are ~dead — **5 of 189 delivered,
  0 of 189 opened**. **[UNVERIFIED]** whether that is a provider-webhook gap (Twilio/Resend status
  callbacks never wired) or a write-path gap. **Diagnose before speccing** — it is one query against
  the provider dashboards, and it decides whether "0 opens" means *nobody read it* or *we never
  asked*. Those imply opposite work.

### 5.2 · Online acceptance
Today: tap → confirm → 1-line UPDATE (+ `accepted_price` in prod). The confirm copy is **genuinely
good** — *"Approving doesn't charge you"* removes the exact fear that stalls a signature. **Keep the
words.**

Build:
- **Record what they agreed to, not just that they agreed.** Today the confirm dialog is the only
  statement of terms and it is never persisted. Accept must snapshot the **document**, not just the
  price: the rendered `quoteDocument` model (jsonb), the GST %, the option chosen, the terms text.
  A quote row stays editable after acceptance — so today the record of the deal can change after the
  deal.
- **Keep Phase 0's rule.** Snapshot from the row inside the UPDATE — never a client parameter (a
  token-holder must never tell the server what it agreed to pay). `coalesce()` = idempotent.
- **Cadence: still record truth or nothing.** If §5.4 lands, the customer's *chosen option* becomes
  known at accept time and **may** be written. Until then, omit.
- **Self-serve decline + "I have a question"** — `portal_decline_quote(p_token, p_quote_id, reason)`.
  Two reasons: (1) a customer with no way to say no just goes silent, and silence is what the
  follow-up cron then chases; (2) **decline reason is the input `quoteLearning.priceLossShare`
  starves on** — today it's captured on an unrelated Grow tab, so the pricing learner is fed by
  whether the owner remembered to visit a page.

### 5.3 · Revisions
**Decision #5 is made: always a new revision, never mutate.** This spec implements, not debates.

- `quotes.parent_quote_id uuid` + `quotes.revision int` (1-based). The chain is the history.
- **Superseding is explicit:** issuing revision N+1 moves N to a terminal `superseded` state.
  A customer must never hold two live quotes for one job and be able to accept the cheaper one.
- **The old link keeps working** and says so: *"This quote was updated — here's the current one."*
  A dead link is how a premium document becomes a support call.
- The customer sees **one** current quote plus an honest "Revised {date}" marker. Not a diff — a diff
  is an argument, not a document. **[UNVERIFIED]** whether owners want a customer-visible change
  summary; ask before building one.
- ⚠️ **`accepted_price` is per-revision.** Acceptance attaches to the revision that was accepted.
- ⚠️ **Quote numbering:** `EPS-2026-0059` is generated from `maxNumericSuffix` today. A revision must
  **not** consume a new number — it is `EPS-2026-0059 rev 2`, or the owner's books gain phantom quotes.

### 5.4 · Optional services / good-better-best
**⛔ BLOCKED ON PHASE 3. This is the one area that cannot be built early**, and the reason is
arithmetic, not process: the engine today prices **1 of 27 services** correctly. A premium
Good/Better/Best selector over that is a *prettier wrong answer*, and Phase 3's bar is *"all 48
mowing quotes reprice byte-identically; then Landscape Bed Cleanup lands near $669.50, not $65."*

When Phase 3 lands:
- **The cadence tiles are already Good/Better/Best in disguise** — 64% of quotes (35/55) already
  carry cadence options; the UI, engine and accept-flow exist. They are hardcoded to mean *how often
  we mow your grass*. Generalizing them is the feature, not a rebuild.
- Model as **options on the document**, not columns on the row. `quotes.weekly_price/biweekly_price/
  monthly_price` is a four-cadence vocabulary frozen into the schema (there's a DB CHECK pinning it).
  Snow's `{per visit, seasonal}` and HVAC's `{tune-up, service, membership}` have nowhere to go.
  → `quote_options` (quote_id, key, label, price, is_recommended, sort_order).
- **Per-line opt-in for add-ons** (`quote_services` lines) is a *separate* question from
  *which plan*. One is "and also", the other is "instead of". Don't merge them into one control.
- **The accepted option is the record.** This is what makes §5.2's cadence snapshot knowable.
- **The two option metrics ship with this phase, not before** (§5.0 #9/#10): `option_viewed` and
  `option_selected`. Reserved in the taxonomy at step 1; **collected here.** Measuring options that
  don't exist would produce a zero that reads like a finding.
- ⚠️ Only **2 `quote_services` lines exist in production.** Before building rich per-line UX, ask why
  multi-service is unused — the answer may be that it's the wrong model, not that it needs polish.

### 5.5 · Premium PDF
Today: a clean, static, correct document with **no accept link and no signature area**, never
attached to an email, rendered client-side on demand.

- **Add the accept link** (roadmap names it explicitly). A PDF that has travelled — forwarded to a
  spouse, printed on a kitchen table — is where the decision often happens. A QR + short URL makes
  the paper actionable.
- **Signature block** (§5.6) rendered as part of the document, not bolted on.
- **Keep the one-PDF-system rule.** `renderPortalQuoteBlob` already proves it. Content comes from
  `quoteDocument`; the PDF is a renderer.
- **Property photo / measurement visual.** The single strongest "this is about *your* home" signal
  and we already have the traced polygon. Today the portal shows one aggregate `lawn_sqft` number
  and no image. ⚠️ **Blocked on Phase 4** for anything non-lawn (`0 of 61 properties have ever been
  traced` — a measurement image can't be shown for a measurement nobody took).
- **[UNVERIFIED]** whether a server-rendered PDF is needed for email attachment. Client-side render
  is deliberate and works; do not migrate it without a reason.

### 5.6 · Signatures — ✅ SETTLED: optional by default, per quote (decision #8)
Genuinely absent. The clearest *additive* piece in Phase 6 — no pricing dependency, no roadmap
conflict, no existing engine to reconcile.

**The owner's decision (2026-07-17), now settled:** *"Signature is optional by default. A signature
should be configurable per quote, not mandatory."*

- **`business_settings.require_signature_default boolean NOT NULL DEFAULT false`** + a **per-quote
  override** (`quotes.signature_required`). ⛔ **Never mandatory app-wide, and never default ON.**
  → **The default is load-bearing, not timidity.** Today acceptance is one tap and the copy
  explicitly de-risks it (*"Approving doesn't charge you"*). A signature wall in front of "yes"
  converts worse. Let the value (a contract on a $4k job) justify the friction where it earns it.
  A per-quote toggle is exactly the right granularity: the $65 mow and the $4k install are not the
  same sale.
- **Draw-or-type, on the document, on a phone.** `signed_name`, `signed_at`, `signed_ip`,
  `signature_svg`, `signed_document` (the §5.2 snapshot).
- **A signature is evidence, so it must be immutable and complete.** Sign the *document*, not the
  row: store what was on screen. A signature over a mutable `quotes` row proves nothing.
- **The unsigned path stays first-class.** With the toggle OFF the accept flow is exactly today's —
  unchanged, not a degraded variant. Pin it (§9).
- **[UNVERIFIED] — legal weight.** e-signature validity (PIPEDA/provincial ESA in Canada; ESIGN/UETA
  in the US) is a question for a person, not a commit. Spec the capture; do not claim enforceability.
  **Still open — §7.**

### 5.7 · Financing — ✅ SETTLED: architecture only, no workflow (decision #9)
**Nothing here ships in Phase 6, and that now includes deposits.**

**The owner's decision (2026-07-17):** *"Deposit collection is NOT part of Phase 6. Keep the
architecture future-ready only. No financing or deposit workflow yet."*

⚠️ **This overrides my own recommendation.** The first draft argued deposit-on-accept was the one
real financing step and the only thing that could answer *"will a customer pay from a quote?"*
**The owner declined it, and the sequencing makes that right:** §0 says we have never observed a
customer *open* a quote. Asking one to *pay* from a document we can't prove they've read is
optimizing step three while step one is unmeasured. Revisit only when §5.1's data exists.

- **The only thing to do:** ensure `quoteDocument` can carry a `payment_terms` fact (deposit %,
  instalments, "financing available") that renderers display and the accept snapshot records.
  **A data shape, not a feature.** It costs nothing now and prevents a schema migration later.
- ⛔ **Do NOT build:** a deposit flow, a Stripe partial/split payment, an instalment plan, a lender
  integration, or any customer-facing "pay now" on a quote.
- ⚠️ **Payments has four deliberate non-features** ([[payments-trust-decisions-2026-07-15]]) and a
  one-writer law for money-out. Financing touches all of it. **Do not "complete" any of them.**
- ⚠️ Real financing = a lender integration (Affirm/Klarna/Financeit), underwriting, disclosure and
  regulated language. A project with a compliance surface, not a Phase 6 bullet.
- 📌 **Deposits already half-exist** and stay owner-only: `recordDeposit()` writes a proper
  double-entry pair from the dashboard. Recorded here so a later session doesn't "discover" it and
  wire it to the portal — that is the deferred workflow, not a gap.

### 5.8 · Customer portal presentation
The bones are better than expected. **This is a polish pass, not a rebuild** — say so plainly rather
than inventing work.

- **Give a quote its own page.** `/portal/[token]/quotes/[id]` — currently a row in a shared list.
  A premium document is not a table row. This also gives the accept link, the PDF QR and the
  revision link something to point at.
- **Keep** the signpost banner, the prospect-only hero suppression, the explain bullets, the neutral
  (not red) Expired treatment, and *"Nothing is charged when you approve"*. These are already right.
- **The `Leaf` fallback icon** is the portal's default branding when a business has no logo
  ([:404](src/app/portal/[token]/PortalClient.tsx#L404)) — a leaf on a furnace company's portal.
  Trivial, real, and safe to fix independently of everything else.
- ⚠️ **Customer Journey is frozen** at `7573dd9` ([[customer-journey-frozen]]) — portal + comms
  templates. Phase 6 is the explicit owner request that lifts it **for this work only**.

### 5.9 · Mobile
**Do not spend here.** Verified good: phone-first `max-w-lg`, sticky scrollable tabs, full-width
CTAs, 16px inputs (defeats iOS auto-zoom), safe-area insets, focus-trapped dialogs, and a documented
mobile fallback for iframe-print. Two real nits only:
- The PDF opens in the native viewer via a blob URL — fine, but a first-class **web** quote page
  (§5.8) makes the PDF the fallback rather than the destination on a phone.
- **[UNVERIFIED]** blob-URL PDF behaviour in the in-app browsers customers actually arrive from
  (Facebook/Messenger — and §0 of [[customer-experience-2026-07-16]] says 44% of this book is
  Facebook-sourced with SMS the only channel). **Test there before claiming mobile is solved.**

---

## §6 · Sequencing within Phase 6 — ✅ ACCEPTED by the owner (decisions #6, #7)

> **observable → delivery → presentation.** *"Implement `viewed_at` before any presentation redesign.
> We need real engagement data before optimizing the quote experience."*

**Step 1 is a GATE, not a first task.** Nothing in steps 2–8 starts until engagement data exists.
The order is forced by dependency, not taste:

| # | Step | Depends on | Gate |
|---|---|---|---|
| **1** | **`quote_events` ledger + view event + delivery truth** (§5.0, §5.1) | — | **⛔ GATE: no presentation work before this reports real data** |
| 2 | The quote page + `quoteDocument` seam (§5.8, §4) | 1 | |
| 3 | Acceptance: snapshot the document · decline (+reason) · question (§5.2) | 2 | |
| 4 | Signatures — optional, per quote (§5.6) | 3 (needs a document to sign) | |
| 5 | Revisions (§5.3) | 3 (a revision supersedes an accepted-or-not document) | |
| 6 | PDF accept link + signature block + `pdf_downloaded` event (§5.5) | 4 | |
| 7 | Options / good-better-best + its 2 metrics (§5.4) | **Pricing V2 Phase 3** | ⛔ blocked |
| 8 | Financing: `payment_terms` data shape only (§5.7) | — | ⛔ no workflow |

**Cross-phase dependencies — Phase 6 cannot fix these itself:**
- **`time to first view` and `expired` both need Phase 0's `markQuoteSent()` seam.** `sent_at` is
  written by 4 writers with 4 behaviours (5 of 8 decided quotes were never marked sent), and
  `valid_until` is set on **0 of 55** quotes. Phase 6 **consumes** that seam — it must not build a
  5th writer. Until then, both metrics read *unknown*, honestly.
- **Options metrics need Phase 3.** Reserve the event types; collect later.

**Steps 1–2 carry no pricing dependency.** If Phase 6 is ever pulled forward in part, pull those —
and step 1 alone may end the project early, on purpose (§10).

---

## §7 · Open decisions — need the owner, not code

### ✅ Answered 2026-07-17 — closed, do not reopen
- ~~**1. Signature mandatory / optional-per-quote / off?**~~ → **Optional by default, configurable
  per quote, never mandatory.** (§5.6, decision #8. Matched the recommendation.)
- ~~**2. Deposit-on-accept?**~~ → **NO. Not in Phase 6.** Architecture future-ready only, no deposit
  or financing workflow. (§5.7, decision #9. **Overrode my recommendation** — and §5.7 explains why
  the owner is right: we can't prove a customer has ever *opened* a quote, so asking one to *pay*
  from it optimizes step three while step one is unmeasured.)

### Still open
1. **Do revisions show the customer what changed?** A diff is an argument; a clean current document
   is a sale. **Recommendation: no diff — just an honest "Revised {date}".** (§5.3)
2. **`quote_options` vs the four frozen cadence columns.** A schema decision Phase 3 forces anyway;
   deciding early costs nothing and unblocks §5.4's design. (§5.4)
3. **Legal weight of a signature** — PIPEDA/provincial ESA (CA), ESIGN/UETA (US). A person, not a
   commit. Does not block building the capture; blocks *claiming enforceability*. (§5.6)
4. **⭐ NEW — engagement data retention + visibility.** `quote_events` is behavioural data about a
   named person (view counts, timestamps). First-party engagement on your own document is ordinary,
   but three things need a human answer: how long do we keep it · does it ever leave the app
   (export/API/integrations) · does the customer ever see it. **[UNVERIFIED]** — raised by the
   owner's own "every interaction should be measurable" requirement. Not a blocker for step 1
   (retention can be set later); is a blocker before it reaches any export surface.

---

## §8 · DO NOT BUILD

- ❌ **Good/better/best before Phase 3.** The engine prices 1 of 27 services. It would be a prettier
  wrong answer, and it would be the second implementation of the thing Phase 3 is building.
  *(Decision #10 — re-confirmed by the owner 2026-07-17.)*
- ❌ **Presentation before the ledger reports real data.** Ship it and the honest post-mortem is
  "we don't know." *(Decision #7 — this is now a gate, not advice.)*
- ❌ **A deposit or financing workflow.** *(Decision #9.)* `payment_terms` is a data shape; that's all.
  ⛔ `recordDeposit()` exists and is owner-only **on purpose** — do not wire it to the portal.
- ❌ **A mandatory signature, or one defaulted ON.** *(Decision #8.)* The unsigned one-tap path stays
  first-class.
- ❌ **An `expired` event row.** `expired` is DERIVED (decisions #2, #15) — storing it re-breaks the
  rule that a quote un-expires the moment the owner extends the date. The metric is a query.
- ❌ **A parallel tracking table.** That is what the taxonomy exists to prevent (decision #14).
  New interaction → **new `type` in `QUOTE_EVENT_TYPES`**, appended. Never a second log.
- ❌ **Renaming or re-using an event type.** It orphans history and silently changes what past rows
  mean. Deprecate, never delete (§5.0).
- ❌ **Encoding specifics in the type** (`option_selected_weekly`). `meta` carries them.
- ❌ **Building counter-offers** because `counter_offered` is reserved. Reserved ≠ built.
- ❌ **App code writing `quotes.view_count` / `viewed_at`.** Trigger-derived from `quote_events`, like
  `invoices.amount_paid` from `payments`. Two writers = the ledger is decorative.
- ❌ **Backfilling any engagement history.** 55 quotes have none. Inventing it from `sent_at` launders
  a guess into the record — the reasoning that stopped Phase 0 backfilling `accepted_price`.
- ❌ **A 5th "sent" writer.** `time to first view` needs Phase 0's `markQuoteSent()`; consume it.
- ❌ **A second document/PDF system.** `renderPortalQuoteBlob` is the rule already.
- ❌ **A cadence fallback in the accept snapshot.** Phase 0 pinned this in a harness on purpose.
- ❌ **Mutating an accepted quote.** Decision #5.
- ❌ **Mobile rework.** It's good. §5.9.
- ❌ **"Completing" any of the four deliberate payment non-features** while adding financing.
- ❌ **Measurement imagery for non-lawn trades** before Phase 4 — 0 of 61 properties are traced.

---

## §9 · Verification strategy

Match the standard Phase 0 set, because a document is as falsifiable as a price:

- **`verify:quote-document`** — the `quoteDocument` seam is pure and deterministic, so pin it: the
  same quote renders the same sections/totals/bullets for web, PDF and summary. **Any divergence is
  the species.** Walk all 12 trade packs, as `verify:pricing` §11 does.
- **Pin the snapshot's immutability:** an accepted document does not change when its `quotes` row is
  edited afterwards. This is the single most important assertion in Phase 6.
- **Pin "record truth or nothing"** for cadence — extend Phase 0's existing assertions rather than
  writing a second set.
- **Pin revision integrity:** exactly one live quote per chain; a superseded quote can't be accepted;
  a revision consumes no new quote number.
- **Lawn stays byte-identical.** Non-negotiable, as everywhere else.
- **The ledger is a sensor:** assert step 1 changes **no** customer-visible output. A sensor that
  alters the thing it measures isn't one.
- **⭐ Pin the derived columns against the ledger** (`verify:quote-events`): `viewed_at ===
  min(at)` and `view_count === count(*)` over `quote_events`, for every fixture. This is the
  `amount_paid` assertion applied to engagement — and it is what stops a second writer appearing.
- **⭐ Pin the taxonomy against the DB** — the `SYSTEM_UNITS` fingerprint pattern (`verify:pricing`
  §14) applied to events: `QUOTE_EVENT_TYPES` and the DB CHECK must agree **exactly**, and a
  negative test must prove the DB **rejects an unknown type** (as Phase 0 proved it rejects a 5th
  cadence and rolls back clean). Two vocabularies that disagree is a second source of truth wearing
  one name.
- **⭐ Pin the taxonomy against renames:** assert the v1 type strings **literally**. A rename must
  break this file loudly — that is the entire value of calling the vocabulary "stable".
- **Pin that no `expired` or `sent` type exists** in `QUOTE_EVENT_TYPES`. Both are bans with a
  reason (decision #15); a test is how a ban survives a well-meaning session.
- **Pin that a view is NOT idempotent** — two views produce two rows and `view_count = 2`. This is
  the deliberate divergence from `portal_mark_invoice_viewed`; assert it, or a future session will
  "fix" it back into a `coalesce` and silently destroy the metric.
- **Pin the unsigned path** (decision #8): with `signature_required = false` the accept flow is
  byte-identical to today's. The default must not be a degraded variant.
- **Pin that unknown reads unknown:** with no `sent_at`, `time to first view` is null — never 0.
  A zero here would read as "instant", which is the same species as a 100% margin on an unknown cost.

---

## §10 · What this spec deliberately does not do

It does not reopen the twelve settled decisions (§3). It does not price anything. It does not build a
deposit, a signature wall, or good/better/best. It does not touch Booking
([[booking-redesign-deferred]] — its own project). It does not schedule itself: **Phase 6 opens when
Phases 1–5 land**, and the owner's *"do not skip phases"* stands.

**One prediction to hold me to:** ship step 1 first and if the ledger still reads **0 opens**, then
the problem was never the document — it is delivery (§0: **5 of 189 ever delivered**) — and the whole
premium project should stop and fix that instead. That is the cheapest finding available here, and
it costs one table to learn.

**And one thing this spec got wrong, kept on the record:** the first draft recommended
deposit-on-accept as the one financing step worth building, on the grounds that it would answer
*"will a customer pay from a quote?"*. The owner declined it. They were right, and the reason is this
document's own thesis: we cannot yet prove a customer has ever **opened** a quote, so asking one to
**pay** from it is optimizing step three while step one is unmeasured. The argument for deposits
survives — it is just waiting on step 1's data, like everything else here.

---

## Revision history

- **2026-07-16 · `3152927`** — first draft. Accepted as the foundation for Quote Presentation V2.
- **2026-07-17 · `749ab06`** — owner adopted 5 product decisions (§3b #6–#11) and added the
  measurability requirement (#12). Changes: **new §5.0** (`quote_events` ledger — the requirement
  broke the original single-column `viewed_at` design, because a timestamp cannot count views);
  §5.1 rewritten (the view RPC is deliberately **not** idempotent, diverging from the invoice
  precedent this spec previously told you to copy exactly); §5.6 + §5.7 settled; §6 is now a gate
  with a dependency table; §7 closed 2 of 5 and added retention/consent; §8 and §9 extended.
- **2026-07-17 · this revision — SPEC APPROVED.** Owner **accepted the `quote_events` architecture**
  as the canonical engagement log with all aggregates derived from it (§3c #13), and required a
  **stable event taxonomy** (#14) so future features extend this stream instead of inventing
  parallel tracking. Changes: §5.0 gains the **v1 taxonomy** (8 types, naming laws, one vocabulary
  enforced in two places via the `SYSTEM_UNITS` mirror pattern); `option_accepted` → **`option_selected`**
  (the owner's name — one name per fact); **`question_asked` + `counter_offered` reserved**
  (⚠️ `counter_offered` is a product concept this spec does not otherwise cover — reserved, not
  authorized); `expired` and `sent` explicitly **excluded from the vocabulary** with reasons; §8 and
  §9 gained the bans and pins that make "stable" and "no parallel tracking" enforceable rather than
  aspirational. **§3 now carries 15 settled decisions.**
