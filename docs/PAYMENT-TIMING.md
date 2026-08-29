# Payment timing — the canonical interpretation, and what comes after

Session 122. P0 trust repair. **This document describes what is supported today
and what is deliberately NOT built.** The engine is
[`src/lib/payments/paymentTiming.ts`](../src/lib/payments/paymentTiming.ts);
the guard is `npm run verify:payment-timing-copy`.

---

## The defect this closed

A production audit found the app telling one customer two different things about
their own money, twenty seconds apart:

1. The portal's quote card said, on **every** quote:
   *"Nothing is charged when you approve — you'll get an invoice once the work is
   done."*
2. The customer approved.
3. The approval dialog and the Billing panel then asked for a **50% deposit
   before we schedule**.

Both sentences were rendered by our own code. Neither was wrong about the
numbers — `lib/payments/depositGate` has always been the single arithmetic for
the scheduling deposit, and it was correct throughout. The **words** were
unowned: four surfaces each composed their own sentence about when money was
due, and only one of them had been taught that a deposit rule exists.

The lesson generalises past this bug: *a shared engine for the figures does not
protect you if every surface writes its own sentence about them.* Copy that
makes a factual claim about a configuration is part of that configuration's
contract and belongs behind the same door.

---

## Supported today — exactly two modes

`quotes.deposit_type` is `NULL`, `'percent'`, or `'fixed'`
(CHECK-constrained; `deposit_value` is pair-consistent with it). That is the
whole configuration space, so there are exactly two timings:

| Mode | Configuration | What the customer is told |
|---|---|---|
| `invoice_after_work` | `deposit_type IS NULL` | Nothing is charged on approval; one invoice follows the completed work. |
| `deposit_before_scheduling` | `deposit_type = 'percent' \| 'fixed'` | A deposit is required before the visit is scheduled; the remainder is invoiced after the work. |

Layered on top of the mode, from the **ledger** and never from a stored flag
(`lib/payments/depositGate`):

- **awaiting** — required, nothing received
- **partial** — some received, not enough (never satisfies)
- **satisfied** — the ask is covered; the money is held as customer credit
  (`ledger.recordDeposit`'s second leg) and comes off the final invoice
- **overridden** — `deposit_override_at` stamped: the owner scheduled anyway and
  the money is still owed. The copy says the visit is booked *and* that the
  deposit is outstanding — it never claims a gate that was waived.

### The one interpretation, and who reads it

`paymentTiming(quote)` → `PaymentTiming`, then one of four sentence builders:

| Builder | Moment | Surfaces |
|---|---|---|
| `quoteTimingLine` | before approval — the standing terms | portal quote card (`explain`), portal Home approve caption, **Quote PDF** |
| `approvalTimingLine` | at the instant of commitment | portal approval dialog |
| `approvedTimingLine` | after approval, against the ledger | portal Billing deposit panel |
| `depositCreditLine` | once satisfied | Billing "received" panel |

Every one of those surfaces reads a string produced here. The portal model
computes `paymentTimingLine` / `depositTimingLine` **once per quote** and carries
them on the `DocItem`, for the same reason it carries `payAmount`: a component
that needs to say when money is due renders the field, it does not compose a
sentence.

### The `basisSettled` rule

An options quote with no option chosen has **no settled price** for a percent
rule to be taken of. In that state the copy names the percentage and never a
dollar figure — printing one would quote the *recommended* option's deposit to
someone about to pick a different option. A fixed rule needs no basis ($500 is
$500 whichever option they take) and always states its dollars.

This mirrors the rule the Quote PDF's grand-total label already follows.

---

## Duplicate payment-timing sources found, and which one is canonical

Two separate kinds of duplication were found. They need different answers.

### A · Duplicate COPY sources — six, collapsed to one

Six places composed their own sentence about when money is due. None imported
from another; two had never heard of the deposit rule.

| # | Source | Said | Verdict |
|---|---|---|---|
| 1 | `portal/[token]/model.ts` quote `explain` | "Nothing is charged when you approve — you'll get an invoice once the work is done" — **unconditional** | ⛔ **the production defect** |
| 2 | `portal/[token]/components/HomeTab.tsx` approve caption | "Nothing is charged when you approve." — **unconditional** | ⛔ same claim, second surface |
| 3 | `portal/[token]/PortalClient.tsx` approval dialog | correct — branched on the deposit | ⚠️ correct **privately**; free to drift |
| 4 | `components/BillingTab.tsx` awaiting panel | "…confirmed after the required deposit is received" | ⚠️ correct privately |
| 5 | `components/BillingTab.tsx` satisfied panel | "Deposit received" — silent on where the money went | ⚠️ incomplete |
| 6 | `components/quotes/QuotePDF.tsx` | **nothing at all** | ⛔ silence is a source: the reader fills it |

> **Canonical: `lib/payments/paymentTiming.ts`.** ✅ Implemented — all six now
> derive from it. It owns the *words* and imports every *figure* from
> `depositGate`; it deliberately holds no arithmetic of its own.

### B · Duplicate CONFIGURATION sources — three, and they are not redundant

| Source | Scope | Verdict |
|---|---|---|
| `quotes.deposit_type` / `deposit_value` (→ `lib/payments/depositGate`) | **the quote** — money before a booking is confirmed; lands as customer credit | ✅ **canonical for a quote** |
| `invoices.deposit_amount` / `deposit_requested_at` (→ `lib/payments/deposit`) | **an invoice** — a partial payment of a bill that already exists | ✅ **canonical for an invoice** — a different question, keep separate |
| `business_settings.terms_text` | free text, printed on the quote **and** invoice PDF | ⚠️ **ungoverned — demote** |

**The recommendation, and the one thing still open.** The first two are *not* a
duplication to resolve: they answer different questions at different points in
the lifecycle, and merging them double-counts cash — the exact failure
`deposit-upfront-request` was built to avoid. Keep both; a future schedule engine
must declare which it generalises.

`terms_text` **is** a genuine third source of payment-timing truth, and it is
unconstrained: an owner who typed *"Payment due upon completion"* into it years
ago has that sentence printed on every quote, including a 50%-deposit quote,
where it flatly contradicts the configuration.

- **Done here:** the canonical timing line is printed **above** the Terms block
  on the Quote PDF, so ours is the statement of record and the owner's text
  reads as supplementary.
- **Still open (recommended, not built — needs an owner decision):** warn the
  owner in Settings when `terms_text` contains payment-timing language, the way
  the builder already warns on other conflicts. It cannot be auto-corrected —
  it is the owner's own legal text — so the honest fix is to surface the
  conflict, not to rewrite or suppress it. Deliberately out of P0 scope: it is a
  new owner-facing surface, not a copy contradiction we authored.

---

## NOT built — the future payment-schedule engine

**⛔ Do not implement any of these as part of a copy fix.** They are listed so
the boundary is explicit, not as a backlog to start from. Each needs schema that
does not exist; a mode string for one would be a promise the database cannot
keep, and `verify:payment-timing-copy` fails if any of these tokens appears in
the engine.

| Future mode | What it needs that does not exist | Why it is not a copy problem |
|---|---|---|
| **Full upfront** | Arguably expressible today as `percent = 100`, but the *scheduling* semantics differ: 100% before scheduling is a prepayment, and the "remainder invoiced after the work" sentence becomes false. Needs its own branch and its own copy, not a percent edge case. | Changes what the final invoice IS. |
| **Before appointment** | A due-date anchored to `jobs.scheduled_date`, which does not exist when the quote is approved. | The anchor is a different row, created later. |
| **Milestones** | A child table (`quote_payment_milestones`: label, trigger, amount) and a per-milestone ledger link. `payments.quote_id` is a single scalar weld. | Many asks per quote; the gate is boolean today. |
| **Installments** | A schedule generator + a due-date cursor + dunning per instalment. Collides with AutoPay's `autopay:<invoiceId>` one-charge-ever key (see [[deposit-upfront-request]]). | Recurring collection machinery. |
| **Net 7 / 15 / 30** | `invoices.due_date` exists, but "Net 30 **from what event**" is unmodelled, and the *quote* has no terms field at all. | Belongs to the invoice, not the quote. |
| **Recurring billing** | Reconciliation with `job_recurrences` / `service_pricing_plans` — and note those two already collide word-for-word on `freq` vs `term` (S111). | Plan-level, not quote-level. |

### The sequencing constraint

Two deposit engines already exist and must **not** be merged by a future
schedule engine:

- `lib/payments/depositGate` — the **quote-level** scheduling deposit (money
  before a booking is confirmed; lands as customer credit)
- `lib/payments/deposit` — the **invoice-level** deposit request (a partial
  payment of an invoice that already exists)

They answer different questions and a real job can carry both. Any future engine
must state which of the two it generalises before it writes a line of code —
merging them silently double-counts cash, which is the exact failure
[[deposit-upfront-request-2026-08-09]] was built to avoid.

---

## The rule, for anyone touching customer copy

> **Copy must never contradict canonical payment configuration.**

Concretely, enforced by `verify:payment-timing-copy`:

1. A surface that tells a customer when money is due renders a string from
   `lib/payments/paymentTiming`. It does not write its own.
2. No sentence may promise "nothing before the work" on a quote whose
   configuration requires money before scheduling.
3. No sentence may name a deposit on a quote that has no deposit rule.
4. The Quote PDF — the copy the customer keeps and forwards — states the timing
   explicitly. Silence is not neutral: the reader fills it with the ordinary
   case and we contradict them at the moment they commit.
