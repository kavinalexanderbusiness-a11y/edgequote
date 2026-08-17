# Tips + Gratuity V1 — deployment handoff

A customer paying an invoice through the portal may add a voluntary tip before
Stripe Checkout. The tip rides inside **one** Stripe charge with the invoice
payment and is recorded as a **separate ledger row**, so the invoice's total,
amount paid, balance and status read exactly as they would have with no tip.

**The app half is committed and safe to deploy on its own, in either order.**
Until the migration is applied the three `business_settings` tip columns do not
exist, so both routes that read them degrade to `TIPS_OFF`: no tip section
renders anywhere and no existing behaviour changes.

That order-independence is deliberate and cost one design decision. PostgREST
fails the **whole** select on a column it does not know, so folding the tip
columns into `/api/portal/pay`'s existing `gst_percent` read would have made
every payment attempt 502 in the window between deploy and migration — the Pay
button dead for a feature nobody had switched on. The tip config is therefore a
**separate** read, and its failure refuses only when a tip was actually
requested:

- no tip requested → an unreadable tip config changes nothing; proceed exactly
  as today;
- a tip requested → we cannot confirm the customer was allowed to give it, or
  what the ceiling was, so refuse (502) rather than charge an unverified
  gratuity.

`verify:tips` §11 pins both halves.

---

## 1 · The accounting model, once

```
invoice total          $500      invoices.amount           ← never touched
applied to invoice     $500      payments.amount, kind='payment'
tip                     $75      payments.amount, kind='tip'
gross Stripe charge    $575      applied + tip, ONE charge
invoice amount_paid    $500
invoice balance          $0
invoice status         paid
```

The separation is a **mechanism, not a discipline**. `recompute_invoice_paid_for()`
— the trigger that owns `amount_paid`, `paid_at` and `status` — sums only
`kind = 'payment'`:

```sql
select coalesce(sum(p.amount), 0) into v_paid
from public.payments p
where p.invoice_id = p_invoice_id and p.kind = 'payment' and p.status = 'paid';
```

No application code maintains those columns, so no application code can leak a
tip into them. The same `kind = 'payment'` filter already keeps tips out of
`isCashRow` (every collected/revenue figure), `collectedBetween`,
`capture_integration_event`'s outbound `payment.recorded` webhook, and the
webhook's own `paymentForIntent` refund/dispute lookup.

`verify:tips` §2 and §9 transcribe those filters out of the generated baseline,
so an edit that drops one fails on a laptop rather than on an owner's books.

---

## 2 · SQL migration — RUN ONCE

`supabase/migrations/20260816120000_tips_gratuity_v1.sql` (~110 lines). It is in
the apply path, per `docs/MIGRATIONS.md`, and it:

- widens `payments_kind_check` to `('payment','credit','refund','tip')` —
  **additive**; every existing row stays valid;
- adds three `business_settings` columns: `tips_enabled boolean default false`,
  `tip_presets integer[] default '{10,15,20}'`, `tip_custom_enabled boolean
  default true`, plus a CHECK bounding presets to ≤3 values in 1..100;
- adds two partial indexes on `payments where kind = 'tip'`.

It creates **no table**, so there is no grants trap. Every statement is
`if not exists` / `drop … if exists` — safe to re-run. It sorts after the
current generated baseline (`20260816020001_baseline.sql`).

**It reconciles with S75's tenant welds** (landed on main as
`20260816020000_tenant_weld_portal_payments_storage.sql`). `payments.invoice_id`
is now welded composite — `(user_id, invoice_id) → invoices(user_id, id)` — and a
tip row carries both keys, taken from the same verified Stripe metadata as its
payment row. So the cross-tenant wall S75 built covers tips **identically and for
free**: a forged or mismatched tenant/invoice pair is refused by Postgres, not by
a code path. `verify:tips` §11 asserts the weld is still there, precisely because
a tip is a *second* row shape on that ledger and must never be the one that
lets a single-column FK back in.

### After it succeeds — same sitting

```bash
npm run schema:contract      # re-capture production's catalogue
npm run schema:baseline      # fold the change into the generated baseline
npm run verify:rebuild       # empty Postgres + repo == production
npm run verify:schema        # production and the repo agree
```

Then move `20260816120000_tips_gratuity_v1.sql` into `supabase/archive/ledger/`
and commit.

### It has been proven to apply — and to do nothing else

`npm run verify:rebuild` was run against an empty PGlite Postgres with the
baseline + this migration. It applies cleanly from zero, and the **entire** diff
against production's contract is the six objects this migration declares:

```
columns      UNEXPECTED 3:  business_settings.tips_enabled       boolean NN
                            business_settings.tip_presets        integer[] NN
                            business_settings.tip_custom_enabled boolean NN
constraints  UNEXPECTED 1:  business_settings_tip_presets_check
constraint definitions:     payments_kind_check
               prod: ('payment','credit','refund')
               got : ('payment','credit','refund','tip')
indexes      UNEXPECTED 2:  payments_tip_intent_idx, payments_tip_user_paid_at_idx
```

Everything else was byte-identical: **131 functions, all function bodies, every
EXECUTE grant, every table grant, RLS on every table, 359 policies and their
predicates, 93 triggers, 7 buckets, 20 storage policies.** `get_portal_data` and
`search_records` still execute against the rebuilt database.

> ⚠️ **So `verify:rebuild` is RED between merge and apply, by design** — that
> drift *is* the report that production has not run this yet. It goes green after
> step 4 below. Note `@electric-sql/pglite` is now a devDependency (S75 added it
> for `verify:tenant-weld`, which hard-fails without it rather than skipping), so
> `npm run verify` **will** show this. Do not merge and walk away.

---

## 3 · Environment variables

**None.** No new variables, no new secrets, no third-party service. Tips use the
existing `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` rail.

---

## 4 · Turning it on

Two gates, both required, both fail closed:

| Gate | Where | Default |
|---|---|---|
| `platform_capabilities.online_payments` | platform-managed, no app write path | **false** (missing row = no capabilities) |
| `business_settings.tips_enabled` | Settings → Pricing & Fees → Tips | **false** |

No fifth capability column was added: a tip settles into the same Stripe account
`online_payments` already governs, so it cannot outlive that grant. A tenant
without the grant gets `TIPS_OFF` from `/api/payments/status` **and** a 503 from
`/api/portal/pay` — the portal's answer is a convenience, the door is the rule.

The owner sets suggested percentages (up to three, default 10 / 15 / 20) and
whether a custom amount is allowed. Clearing the presets **and** disabling custom
collapses to tips-off rather than rendering an empty box.

There is deliberately **no industry heuristic** anywhere — no "cleaning gets
tips, electricians don't". `verify:tips` §11 asserts the absence.

---

## 5 · Decisions taken, and why

Each of these was a real fork. They are recorded here rather than left implicit.

### 5.1 A new `kind`, not a `tip_amount` column — DECIDED

A `payments.tip_amount` column on the payment row would have kept the trigger
correct for free. It was rejected because a tip must be independently
**refundable**: Stripe reports a cumulative refunded figure against one charge,
and with a separate row the reversal is just another signed row on the ledger the
invoice reversal already uses. It also keeps `paymentForIntent`'s
`kind='payment' AND amount > 0` filter resolving exactly one candidate per
PaymentIntent — the ambiguity the webhook already documents as fixed once.

`invoice_id` **is** set on the tip row. That buys the linkage that puts it on the
right invoice, the right portal row and the right customer timeline. The cost is
that it enters readers keyed on `invoice_id`; each one was found and named
(§5.5).

### 5.2 No tips on deposits or part payments — DECIDED, and it is a scope limit

Offered only when `depositChargeAmount().isDeposit === false` — i.e. on the
payment that **closes** the invoice, which includes the final instalment of a
part-paid one.

A deposit ask is a number the business has already communicated. Adding a tip
would make Stripe's total disagree with it at the exact moment the card is out —
the display-vs-charge split the whole deposit lane exists to prevent. AutoPay is
untippable for a simpler reason: nobody is present to choose. The pre-invoice
scheduling deposit (`/api/portal/quote-deposit`) is out of scope: that money has
no invoice to sit beside.

**The engine is correct on partials regardless.** `verify:tips` §3 proves the
specification's case — a $1,000 invoice with $400 applied and a $60 tip leaves
the balance at **$600, not $540** — because that is a money invariant, and the UI
rule above is a product decision layered on top of it. Lifting the restriction
later is a one-line change to `tippable:`, with no ledger consequence.

### 5.3 Refunds are apportioned TIP-FIRST — DECIDED, and it is a judgement call

**This one deserves the owner's eye.** It is one comparison in
`apportionRefund()` and trivially reversible.

EdgeHQ never calls Stripe's refund API — owners refund in the Stripe dashboard —
so no refund object exists that could carry our metadata, and Stripe tells us
only a cumulative amount. On a **full** refund every ordering gives the same
answer. They differ only on a **partial**, and the failure modes are asymmetric:

- *tip-first guesses wrong* → a tip is reversed that the owner meant to keep.
  Visible in the ledger, and **nobody is chased**.
- *invoice-first guesses wrong* → the invoice balance reopens past its due date,
  `dueForAutoReminder` goes true, and the chaser texts a customer who is square.
  That is precisely the outcome the dispute branch already refuses to risk.

So the cheap wrong answer is preferred to the expensive one, and the owner's
refund notification **names the split** ("$20 of that came off the tip") so a
wrong guess is correctable rather than silent.

Making the branch tip-aware at all is **not** optional: without it a full refund
of a $575 charge books −$575 against an invoice that received $500, driving
`amount_paid` to −$75 and reopening a $575 balance on a $500 invoice.

**Manual tip refunds do not exist in V1.** Card tips are refunded in Stripe only,
exactly like card payments — `removePayment` already refuses `provider='stripe'`
rows, and the tip row offers no revert affordance.

### 5.4 Tax — a seam is preserved, no opinion is encoded

Whether a voluntary gratuity is consideration for a taxable supply — and whether
a tip is the business's revenue or a liability owed to a worker — **is not
answered anywhere in this codebase and is not answered here.** It is an owner +
accountant question.

What the code does is keep the seam clean. Tax is computed from `invoices.amount`
in exactly two mirrored places (`invoiceTotals.ts` app-side, the trigger
DB-side), and a tip never touches that column, so:

- the invoice PDF, the GST return and the charge total are unaffected;
- `salesTaxWithin()` — which divides *all collected cash* by `(1 + rate)` to back
  GST out — never sees a tip, because `isCashRow` rejects it. Tips get **no
  imputed GST**, which is the tax-safe default;
- **no receipt document is generated for a tip row**, on either the owner or the
  portal side. `ReceiptPDF` backs GST *out* of `payment.amount` at the invoice's
  rate; on a gratuity that would print a tax figure for a supply that was never
  invoiced, and on a reversal it would issue a credit note claiming that tax back
  (ETA s.232(3)). The tip is named on the invoice payment's own receipt instead.

Stripe Tax is not in use anywhere in this deployment and tips did not introduce
it. If it is ever adopted, Stripe's *Optional Gratuity* tax category is the seam
to reach for — but that is a decision for whoever builds the tax engine, not a
side effect of this lane.

### 5.5 Where "tips are excluded" is a deliberate divergence

`profitAndLoss.cashCollected` and `balanceSheet.cashAsAt` are `isCashRow` sums,
so they **exclude tips** — while Stripe deposits the **gross**. Those two figures
will therefore differ from the bank statement by the tip total.

That is the correct behaviour under "expose the figures separately rather than
pretending a tip is service revenue", and it is the direct consequence of not
answering 5.4. It is stated here so it is not later mistaken for a bug. The tip
total is reported beside the cash figures on the Payments page (a `Tips` tile,
`summarizeTips`, rendered only when non-zero) and in both CSV exports as its own
column.

Readers that were changed so a tip is named rather than mis-typed:
`ledgerRowType` (→ `Tip` / `Tip refunded`, inherited free by the portal list, the
payments table and both exports), the customer timeline (its own event **and**
the deposit-coverage walk, which now counts `kind === 'payment'` rather than
excluding `'credit'`), `InvoicePaymentControls` (`lastMoneyIn` likewise), the
Payments page filter, the portal's `recentPayments`, and the owner's invoice
payment list.

### 5.6 Attribution — context, never payroll

A tip is welded to the invoice, and `payments.invoice_id → invoices.job_id` is
therefore the whole attribution. **No new column, and no claim about people.**

V1 builds no payroll, no tip splitting, no employee payout, no tip pooling. There
is no mechanism to pay a tip out to anyone, so the product does not imply one.
`verify:tips` §14 asserts the absence — no tip surface reads `technician_id`,
`hourly_wage`, `pay_run*`, or crew membership, and no payroll table gains a tip
column.

Worth stating plainly if this is revisited: **crew membership is not proof anyone
worked.** `jobs.crew_id` is a *planned* assignment, `job_work_sessions.workers` is
a head count with no route back to a person, and the only per-person record is
`time_entries` — which had zero rows in production when the job-cost engine
shipped. Any future distribution feature must treat "unknown" as a first-class
answer.

### 5.7 Also deliberately not built

- **Tips on the owner-minted payment link** (`/api/payments/checkout`). The owner
  sending a link or taking a card in person is not a tipping moment. The webhook
  split is shared, so such a session simply never carries `tip_cents` — enabling
  it later is additive, with **zero** webhook change.
- **Stripe's "customer chooses price" Checkout mode.** It carries documented
  restrictions when combined with other line items, and the tip is chosen before
  the redirect anyway.
- **A mandatory service charge.** That is a different product concept and must
  not be mislabelled as a tip.

---

## 6 · How the money moves, end to end

1. **Portal** (`BillingTab` → `TipSelector`) shows *No tip* first, nothing
   pre-selected, presets and an optional custom field. It posts `{ token,
   invoiceId, tipCents }` — an **intent**, and the only client field this route
   has ever accepted.
2. **`/api/portal/pay`** re-derives everything: the capability, the owner's tip
   config, the charge (`depositChargeAmount`), and then `resolveTipCents()` —
   which bounds the tip to `min(charge, $1,000)` and **rejects** rather than
   clamping, because a customer charged $1,000 after asking for $5,000 has been
   overcharged from where they sit. A rejection is a 400.
3. **`createInvoiceCheckoutSession`** adds `line_items[1]` named *Tip* — so the
   split appears on Stripe's page and Stripe's receipt email — and writes
   `metadata[tip_cents]` on both the session and the PaymentIntent.
4. **Webhook** verifies the signature, then `splitGrossCents(amount_total,
   metadata.tip_cents)`, clamped to the gross so the invoice half can never go
   negative. It writes the invoice row at the invoice half and, if there is a
   tip, a second row `kind='tip'` keyed `tip:<session>`. The DB trigger derives
   `amount_paid` / `status` from the first row alone.
5. **Idempotency** is the existing `payments_stripe_session_id_key` UNIQUE plus
   `onConflict: 'stripe_session_id', ignoreDuplicates: true`. Seven distinct key
   namespaces now exist and `verify:tips` §9 proves they cannot collide —
   including that `refund-tip:` is not matched by the `refund:<charge>:%` LIKE
   lookup. Receipt/notification side effects stay gated on the **invoice** row's
   insert.

---

## 7 · Verification

```bash
npm run verify:tips          # 241 assertions — the money boundaries
node scripts/mutate-tips.mjs # 36 mutations, all must be caught (needs a clean tree)
npm run verify               # every guard + the file↔script parity contract
npm run typecheck && npm run lint && npm run build
```

`scripts/mutate-tips.mjs` is **not** a `verify:` entry — it edits source files and
reverts with `git checkout --`, so it refuses to run on a dirty tree.

### Stripe test-mode end-to-end — NOT YET RUN

This requires `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` and
`SUPABASE_SERVICE_ROLE_KEY`, all of which are **deliberately absent** from
`.env.local` and require owner action. The sequence to run once they are present:

1. Enable `tips_enabled` for the fixture tenant; confirm it holds
   `platform_capabilities.online_payments`.
2. Open a fixture invoice in the portal → the tip section appears, nothing
   pre-selected.
3. Choose 15% on a $500 invoice → the button reads **Pay $575.00**, the
   breakdown reads 500 / 75 / 575.
4. Continue → Stripe Checkout shows **two** line items, `Invoice INV-… $500.00`
   and `Tip $75.00`, total `$575.00`.
5. Pay with `4242 4242 4242 4242`.
6. Assert in the ledger: **exactly two** rows for that session —
   `kind='payment' amount=500 stripe_session_id='cs_…'` and
   `kind='tip' amount=75 stripe_session_id='tip:cs_…'`.
7. Assert on the invoice: `amount = 500`, `amount_paid = 500`, `status = 'paid'`,
   balance `$0`.
8. **Replay the webhook** from the Stripe dashboard → still exactly two rows, one
   receipt, one `tip_received` notification.
9. Refund `$25` in Stripe → one `kind='tip' amount=-25` row keyed
   `refund-tip:<charge>:2500`; `amount_paid` still `500`; the invoice stays
   **paid**; the notification names the tip portion.
10. Refund the remaining `$550` → `kind='tip' -50` and `kind='payment' -500`;
    `amount_paid` reaches `0`, never negative.
11. Delete the fixture rows; confirm zero residue.

Do **not** run this against a real customer, and do not create an unreconciled
real charge to test it.
