# Quote Presentation V2 — the Phase 6 specification

**Status:** SPEC ONLY. No code written, none to be written yet.
**Place:** this is **Phase 6 ("The document")** of [Pricing V2](../memory/pricing-v2-roadmap-2026-07-16.md).
The roadmap defines Phase 6 in one line — *`quotes.viewed_at`, PDF accept link, good/better/best,
revisions fork*. This document is that line, specified.
**Gate:** the owner's standing order is **Phase 0 only — do not skip phases**. Phase 0 is ~2 of 7.
**This spec is redesign input. It is not a licence to build.** Build it when Phases 1–5 have landed.
**Date:** 2026-07-16 · **Code state:** `main` @ `f9014e1` · **Prod verified live.**

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

From the owner, 2026-07-16 ([[pricing-v2-phase0-2026-07-16]]):

1. **Revisions ALWAYS create a new revision.** Never mutate a quote the customer already received.
   → `parent_quote_id` + version. **This resolves the revisions fork. §5.3 implements it; it does not reopen it.**
2. **Expired quotes do NOT count toward acceptance metrics**, and a `sent` quote past its date
   auto-reads Expired. (Supersedes [[quote-expiry-decisions]]'s display-only rule.)
3. **Units and Dimensions stay separate.** `units.ts`'s "a unit is a LABEL, never arithmetic" holds.
4. **Grandfather all existing recurring customers.** V2 prices NEW quotes only.
5. **Unknown stays unknown**, and lowers confidence — never a placeholder (margin.ts's rule,
   promoted). **§5 obeys this everywhere.**

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

### 5.1 · Observability — `quotes.viewed_at` (**ships first, alone**)
**Why first:** the roadmap already calls it *"cheapest + highest impact"*. §0 explains why: we have
never observed a single quote view. Everything else in Phase 6 is unmeasurable until this exists.

- `quotes.viewed_at timestamptz` + `portal_mark_quote_viewed(p_token, p_quote_id)` — **mirror
  `portal_mark_invoice_viewed` exactly**; it already exists and works. Do not invent a second shape.
- Derived `'viewed'` display status, mirroring `InvoiceDisplayStatus`.
- **First view only** (`coalesce`), like the invoice RPC — idempotent, and "when did they first see
  it" is the question.
- ⚠️ **This is a sensor, not a feature.** It must not change what the customer sees. No read receipts
  shown to the customer, no "seen" ticks.
- **Also fix delivery truth:** `notification_log.delivered_at`/`opened_at` exist and are ~dead
  (5/189, 0/189). A document that can't be proven delivered can't be improved. **[UNVERIFIED]**
  whether this is a provider-webhook gap or a write-path gap — diagnose before speccing.

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

### 5.6 · Signatures
Genuinely absent. This is the clearest *additive* piece in Phase 6 — no pricing dependency, no
roadmap conflict, no existing engine to reconcile.

- **Draw-or-type, on the document, on a phone.** `signed_name`, `signed_at`, `signed_ip`,
  `signature_svg`, `signed_document` (the §5.2 snapshot).
- **A signature is evidence, so it must be immutable and complete.** Sign the *document*, not the
  row: store what was on screen. A signature over a mutable `quotes` row proves nothing.
- ⚠️ **Do not make it mandatory by default.** Today acceptance is one tap and the copy explicitly
  de-risks it. A signature wall in front of "yes" converts worse. Make it **the owner's choice per
  quote**, defaulted OFF, and let the value (a contract) justify the friction where it matters.
- **[UNVERIFIED] — legal weight.** e-signature validity (PIPEDA/provincial ESA in Canada; ESIGN/UETA
  in the US) is a question for a person, not a commit. Spec the capture; do not claim enforceability.

### 5.7 · Financing (future-ready)
**Nothing here ships in Phase 6.** The instruction is *future-ready*, and the honest reading is:
**leave a seam, make no promise.**

- The **only** thing to do now: ensure `quoteDocument` can carry a `payment_terms` fact (deposit %,
  instalments, "financing available") that renderers display and the accept snapshot records. That
  is a data shape, not a feature.
- ⚠️ **Payments has four deliberate non-features** ([[payments-trust-decisions-2026-07-15]]) and a
  one-writer law for money-out. Financing touches all of it. **Do not "complete" any of them.**
- ⚠️ Real financing = a lender integration (Affirm/Klarna/Financeit), underwriting, disclosure and
  regulated language. That is a project with a compliance surface, not a Phase 6 bullet.
- **Deposits are the honest first step** and already half-exist: `recordDeposit()` writes a proper
  double-entry pair but is **owner-only**. "Accept + pay a deposit now" is a real, small, useful
  feature — and it is the one that would tell us whether customers will pay from a quote at all.

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

## §6 · Sequencing within Phase 6

The order is forced by dependency, not taste:

1. **`viewed_at` + delivery truth** (§5.1) — alone, first. It is the only way to know if anything
   after it worked. Ships without touching a single price.
2. **The quote page + `quoteDocument` seam** (§5.8, §4) — the surface everything else attaches to.
3. **Acceptance: snapshot the document · decline · question** (§5.2) — needs the seam from 2.
4. **Signatures** (§5.6) — needs the document snapshot from 3 to sign.
5. **Revisions** (§5.3) — needs 3, because a revision supersedes an accepted-or-not document.
6. **PDF accept link + signature block** (§5.5) — renderer work over a settled model.
7. **Options / good-better-best** (§5.4) — **only after Phase 3**.
8. **Financing seam** (§5.7) — data shape only.

**Steps 1–2 are independently valuable and carry no pricing dependency.** If Phase 6 is ever pulled
forward in part, pull those.

---

## §7 · Open decisions — need the owner, not code

1. **Is the signature mandatory, optional-per-quote, or off?** Affects conversion directly. My
   recommendation: per-quote, default OFF.
2. **Deposit-on-accept — yes or no?** The only financing step that is real, small and answerable now.
   It also answers "will a customer pay from a quote?", which nothing currently can.
3. **Do revisions show the customer what changed?** A diff is an argument; a clean current document
   is a sale. Recommendation: no diff, just an honest "Revised {date}".
4. **`quote_options` vs the four frozen cadence columns** — a schema decision that Phase 3 will force
   anyway. Deciding it early costs nothing and unblocks §5.4's design.
5. **Legal weight of the signature** — a person, not a commit.

---

## §8 · DO NOT BUILD

- ❌ **Good/better/best before Phase 3.** The engine prices 1 of 27 services. It would be a prettier
  wrong answer, and it would be the second implementation of the thing Phase 3 is building.
- ❌ **Presentation before `viewed_at`.** Ship it and the honest post-mortem is "we don't know."
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
- **`viewed_at` is a sensor:** assert it changes no customer-visible output.

---

## §10 · What this spec deliberately does not do

It does not reopen the five settled decisions (§3). It does not price anything. It does not touch
Booking ([[booking-redesign-deferred]] — its own project). It does not schedule itself: Phase 6 opens
when Phases 1–5 land, and the owner's *"do not skip phases"* stands.

**One prediction to hold me to:** if Phase 6 ships §5.1 first and the numbers still read *0 opens*,
then the problem was never the document — it is delivery (§0: 5 of 189 delivered), and the whole
premium project should stop and fix that instead. That would be the cheapest finding in this
document, and it costs one column to learn.
