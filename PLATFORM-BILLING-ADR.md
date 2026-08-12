# ADR-003 — Platform billing (EdgeQuote → the business owner)

**Status: ACCEPTED (architecture) / DEFERRED (implementation).**
Nothing in this document has been applied. No table, route, env var or migration
from it exists. Do not run the SQL until decisions **D1–D4** below are answered.

Session 28, 2026-08-11. Supersedes nothing.

---

## 0. The distinction this document exists to protect

Two payment systems, same product, and they must never touch:

| | **MERCHANT PAYMENTS** (exists, mature) | **PLATFORM BILLING** (this ADR, not built) |
|---|---|---|
| Money flows | customer → service business | service business → EdgeQuote |
| Stripe account | deployment-global, `STRIPE_SECRET_KEY` | **a different Stripe account** |
| Webhook | `/api/stripe/webhook` | `/api/platform/billing/webhook` |
| Engine | `src/lib/stripe/config.ts` | `src/lib/billing/*` |
| Stripe Customer means | one of the *business's* customers | one *business owner* |
| Tables | `payments`, `payment_methods`, `invoices` | `platform_subscriptions`, `platform_billing_events` |

**Rule 0 — the merchant payment path must never read platform billing state.**
A customer paying a lapsed business's invoice is still recorded, in full, always.
We do not corrupt a tenant's financial ledger over our own billing dispute.

---

## 1. The billing subject

`business_settings.user_id` carries a **UNIQUE** index
(`business_settings_user_id_key`), and possessing that row is literally the
definition of being an owner — `current_app_role()` returns `'owner'` iff a
`business_settings` row exists for `auth.uid()`.

So: **the billing subject is the owner's `auth.users.id`.** It is already the
tenant key on every table in the schema. One auth user ≈ one business remains
absolute; there is no organization or membership table, and none should be
invented for billing (that would be a second tenant identity — see
`engineering-principles` §3).

**Crew users are never billing subjects.** A crew member is an `auth.users` row
with no `business_settings` row. Their entitlement is their employer's,
resolved through the existing `crew_employer()`. A crew session must never be
able to create, read or affect a subscription.

---

## 2. Product constraints already locked (these are not mine to change)

The live marketing site (`edgequote-web`) makes public promises that constrain
this architecture more than any technical consideration:

- **Contact-for-pricing. No public numbers.** (`memory/edgequote-web-marketing-site.md`)
- **One plan, everything in it** — *"No paywalled 'pro' features, no add-on for
  the portal or the analytics."*
- **No per-seat pricing** — *"no per-seat traps"*, *"no seat-count games"*.
- **Price set per operation, on a demo call** — *"A one-person crew and a
  ten-truck operation don't have the same needs — or the same bill."*
- **Onboarding one business at a time.** Primary CTA is *Book a demo*.

Three consequences follow directly, and they shrink this system dramatically:

1. **There is no feature gating to build, ever.** Tier-gated features would
   contradict live public copy. The entitlement primitive must therefore exist
   in exactly one place and gate *nothing* by plan.
2. **There is no self-serve checkout to build.** There is no price to put on a
   checkout page. `/login` has no `signUp` — accounts are owner-provisioned
   already, exactly like crew invites.
3. **Per-operation amounts mean fixed Stripe Price IDs in env are wrong.** Each
   business gets its own negotiated amount.

**EdgeQuote's billing system is therefore a STATUS MIRROR, not a billing
engine.** The owner sells on a call and provisions the subscription in the
Stripe dashboard. The app reflects what Stripe says and never decides anything
commercial itself.

---

## 3. Data model

Two tables. Both **server-authoritative**: no user may write either one.

> ### Why not columns on `business_settings`
> `business_settings` carries a full owner **UPDATE** policy
> (`settings: update own`, `qual: auth.uid() = user_id`). A `plan` or `status`
> column there would be writable from the browser via PostgREST — a business
> could PATCH itself to `active` forever. Subscription state must live in a
> table with **no write policy at all.**

```sql
-- ⚠️ NOT APPLIED. Answer D1–D4 first.

-- ── The subscription mirror ──────────────────────────────────────────────────
create table public.platform_subscriptions (
  user_id uuid primary key
    references auth.users(id) on delete cascade,

  -- Lifecycle. The ONLY values app code may branch on.
  status text not null default 'trialing'
    check (status in ('trialing','active','past_due','canceled')),

  -- One plan today. The column exists so a second is a value, not a migration.
  plan_key text not null default 'standard',

  -- Trial. OURS when there is no Stripe subscription yet; mirrored when there is.
  trial_started_at timestamptz not null default now(),
  trial_ends_at    timestamptz not null,

  -- Stripe — the PLATFORM account, never the merchant one.
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,

  -- Ordering guard: Stripe does NOT guarantee event order.
  last_event_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger platform_subscriptions_updated_at
  before update on public.platform_subscriptions
  for each row execute function public.handle_updated_at();   -- the canonical one

alter table public.platform_subscriptions enable row level security;

-- Read your own. That is the ENTIRE policy set: with no INSERT/UPDATE/DELETE
-- policy, RLS denies every write to every non-service-role caller.
create policy "subscription: read own" on public.platform_subscriptions
  for select using (auth.uid() = user_id);

-- Belt and braces. Supabase's ALTER DEFAULT PRIVILEGES grants table DML to
-- anon/authenticated at CREATE time, and `revoke ... from public` does NOT
-- remove it — revoke by role name. (Learned twice: crew-mode, quote-options.)
revoke insert, update, delete on public.platform_subscriptions from anon, authenticated;

-- ── Webhook idempotency / replay log ─────────────────────────────────────────
create table public.platform_billing_events (
  event_id     text primary key,        -- Stripe evt_...
  type         text not null,
  user_id      uuid,
  event_at     timestamptz not null,    -- Stripe's event.created
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.platform_billing_events enable row level security;
-- Deliberately ZERO policies: not even the owner reads this. Service role only.
revoke all on public.platform_billing_events from anon, authenticated;
```

### Plans live in code, not in a table

`src/lib/billing/plans.ts`, mirroring the existing `src/lib/modules.ts`
registry. Rationale: a DB-editable limits blob is a privilege-escalation
surface, and this codebase's established pattern is *registry in code, config in
DB* (`FEATURE_MODULES` + `business_settings.enabled_modules`, guarded by
`verify:modules`). V1 contains exactly one entry and gates nothing.

---

## 4. Trial semantics

**Start.** A trial begins when the *business* is created, not when the account
is. `/setup` upserts `business_settings`; an `after insert` trigger there
inserts the `platform_subscriptions` row. A DB trigger rather than app code, so
the row can never be missing (`engineering-principles` §4).

**End.** `trial_ends_at = trial_started_at + <D2>`.

**Expiry is DERIVED, never stamped.** There is no cron that flips a row to
expired. The resolver compares `trial_ends_at` to `now()` at read time. A cron
can fail to run; a comparison cannot. (Same principle that fixed the day-status
and portal-money-honesty bugs: don't store what you can derive, and never let a
missed job turn into a wrong answer.)

Consequently `'expired'` is **not** a stored status — it is a *derived access
level*. The stored status stays `'trialing'`.

**At expiry: `read_only`. Never a lockout.** See §6.

---

## 5. Lifecycle

Stored `status` is a pure mirror of Stripe, with one exception (`trialing`
before a Stripe subscription exists).

```
        business created (DB trigger)
                 │
                 ▼
           ┌───────────┐   owner provisions sub in Stripe
           │ trialing  │──────────────────────────────────┐
           └───────────┘                                  │
                 │ trial_ends_at passes                    ▼
                 │ (derived only — no write)         ┌──────────┐
                 ▼                                   │  active  │
        access = read_only ◄───────────────┐         └──────────┘
                                            │           │      ▲
                                            │  payment  │      │ payment
                                            │  fails    ▼      │ recovers
                                            │      ┌──────────┐│
                                            │      │ past_due ├┘
                                            │      └──────────┘
                                            │           │ Stripe gives up
                                            │           ▼
                                            │     ┌──────────┐
                                            └─────┤ canceled │
                     (only once current_period_end └──────────┘
                      has passed — they paid for it)
```

**Upgrade / downgrade / plan change** need no code. There is one plan, and the
amount is per-operation. The owner edits the subscription in Stripe;
`customer.subscription.updated` arrives; the mirror updates. Proration is
Stripe's job.

**Cancellation.** `cancel_at_period_end = true` keeps `status = 'active'` and
full access until `current_period_end`. They paid for the period. Only after it
passes does access drop to `read_only`.

---

## 6. Entitlement architecture

**One resolver. Server-side. Fails closed to the *generous* side.**

```ts
// src/lib/billing/entitlements.ts — THE only place billing state becomes a decision.
export type AccessLevel = 'full' | 'read_only'

export interface Entitlements {
  access: AccessLevel
  status: 'trialing' | 'active' | 'past_due' | 'canceled'
  /** Days left in trial, when trialing. null otherwise. */
  trialDaysLeft: number | null
  /** True when the owner should see a "sort your billing out" banner. */
  needsAttention: boolean
}

export function resolveEntitlements(
  row: PlatformSubscriptionRow | null,
  now: Date,
): Entitlements
```

Note the deliberate absence of `plan`, `features`, `limits` and `seats` from the
return type. Adding them is how `if (plan === 'pro')` gets scattered; the type
is the guard.

### Access matrix

| stored status | condition | access |
|---|---|---|
| `trialing` | `now < trial_ends_at` | **full** |
| `trialing` | `now ≥ trial_ends_at` | **read_only** |
| `active` | — | **full** |
| `past_due` | — | **full** ← deliberate |
| `canceled` | `now < current_period_end` | **full** |
| `canceled` | `now ≥ current_period_end` | **read_only** |
| *(no row)* | — | **full** ← deliberate |

Two entries are load-bearing and both err toward the customer:

- **`past_due` keeps full access.** Stripe is still retrying. Cutting a business
  off mid-season over a card that will succeed on retry two is far worse than a
  few days of unpaid use. They get a banner, not a wall.
- **A missing row grants full access.** If the trigger ever failed, or a
  backfill was missed, the failure mode must be "someone uses EdgeQuote free for
  a while", not "a paying business is locked out of their books by our bug."
  This is the one place in the codebase that deliberately fails *open*, and it
  does so because the thing on the other side is a real business's day.

### What `read_only` means

**Never a lockout. Never deletion. Never data loss.**

| always allowed, at every level | blocked in `read_only` |
|---|---|
| read every customer, quote, invoice, payment | create quotes / jobs / invoices / customers |
| **export everything** (CSV, PDF) | send SMS or email (real cost to us) |
| settings, billing page, Stripe portal | AI features (real cost to us) |
| **the merchant webhook recording a customer's payment** | automations, marketing sends |
| **crew read + visit status writes** | |

Two of those are hard rules, not preferences:

- **Rule 0 restated:** `/api/stripe/webhook` never consults this. A customer's
  money is recorded whatever the business's billing state.
- **Crew access is never cut.** A crew mid-route losing their day because the
  owner's card expired is a safety problem, not a billing lever.

### Where the check goes

Server-side, in the write paths — not in React. Client-side entitlement state is
**display-only**; every gated mutation re-resolves server-side. Precedent:
`resolveAppRole` in `src/lib/crewAccess.ts`, which the codebase already treats
as "routing is UX, the RPC surface is the boundary."

`src/lib/modules.ts:isEntitled()` already exists as the designated licensing
hook with a `TODO(licensing)`. It stays returning `true` for everything — no
module carries a `sku`, and per §2 none ever should.

---

## 7. Webhook model

`POST /api/platform/billing/webhook` — a **new route**, in a new lib, reading a
**different secret**.

**Order of operations, and it matters:**

1. **Verify the signature** against `PLATFORM_STRIPE_WEBHOOK_SECRET`. Trust
   nothing before this returns ok. Reuse the existing HMAC verifier by giving
   `constructWebhookEvent` an explicit secret parameter (defaulting to the
   merchant secret so the existing call site is untouched) — one verifier, two
   secrets, rather than a second copy of security code.
2. **Claim the event.** `insert into platform_billing_events (event_id, ...)
   on conflict do nothing`. Zero rows affected → already processed → return
   `200` immediately. This is the replay guard, and it is the same shape the
   merchant webhook already uses (`onConflict: 'stripe_session_id',
   ignoreDuplicates: true`).
3. **Map to a tenant — server-side only.** `stripe_customer_id` →
   `platform_subscriptions.user_id` (unique index). **Never** from a URL
   parameter, a request body field, or client-supplied metadata. If the customer
   maps to nothing, log and `200` — it is not our event.
4. **Re-fetch, don't trust the payload.** On any `customer.subscription.*`
   event, `GET /v1/subscriptions/{id}` and write *that*. Stripe's current state
   is authoritative; the event payload is a snapshot that may be stale. This is
   what makes out-of-order delivery safe without enumerating every transition.
5. **Guard the write.** `where user_id = $1 and (last_event_at is null or
   last_event_at <= $2)`. Belt and braces against two handlers racing.
6. **Stamp `processed_at`.** A row with `received_at` but no `processed_at` is a
   visible, queryable "we started and did not finish" — the failure this system
   would otherwise have no trace of.
7. **A failed DB write returns 500, never 200.** Let Stripe retry. Silently
   200-ing a write that failed is how state goes permanently wrong. (Exactly the
   discipline the merchant webhook already enforces.)

**Events consumed** — deliberately few:

| event | effect |
|---|---|
| `customer.subscription.created` / `.updated` | re-fetch → mirror `status`, `current_period_end`, `cancel_at_period_end` |
| `customer.subscription.deleted` | `status = 'canceled'` |
| `invoice.payment_failed` | `status = 'past_due'` + one in-app `notifications` row |
| `invoice.payment_succeeded` | `status = 'active'`, clear the attention flag |

Everything else: `200`, ignored.

**No cron.** Stripe owns dunning (Smart Retries and its own dunning emails). We
mirror outcomes. This is also the only design compatible with the Vercel
**Hobby** plan, where any sub-daily cron fails the entire deployment.

---

## 8. Failed payment & cancellation — the safety contract

1. **No tenant data is ever deleted, altered, anonymised or made unreadable by
   any billing transition.** Not at past_due, not at cancel, not ever.
2. **Export is available at every access level, including after cancellation.**
   A business that leaves takes its customers, invoices and payment history with
   it. This is also the honest answer to "what happens to my data" on a demo
   call.
3. **`past_due` does not restrict anything.** Banner only.
4. **Post-cancellation is `read_only`, indefinitely.** There is no purge job.
   Storage for a handful of lapsed beta businesses is not a problem worth
   risking data loss to solve.
5. Reactivation is: owner fixes it in Stripe → `invoice.payment_succeeded` →
   `active`. No re-onboarding, no data migration.

---

## 9. Separation from merchant Stripe — with evidence

**These must be a separate Stripe account, not merely separate keys.** The
decisive reason is a concrete, already-present cross-contamination path:

`src/lib/payments/reconcile.ts` powers the owner-facing "Check Stripe against
your books" panel. It calls `listSucceededPaymentIntents`, which lists
PaymentIntents **account-wide** (its own comment: *"the Stripe side is
account-wide, so a PaymentIntent without resolvable ownership is reported rather
than silently dropped"*), then subtracts only the intents recorded in **the
calling owner's** ledger and reports the remainder as money they should look at.

If EdgeQuote's subscription charges lived in the merchant account, **every
monthly subscription charge from every business would surface in every business
owner's reconciliation report as unrecorded revenue** — amount, date, intent id
and description included.

Required separation, each item independently checkable:

| # | Rule |
|---|---|
| S1 | Separate Stripe account. New env: `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET`. |
| S2 | `src/lib/billing/*` must not import `src/lib/stripe/config.ts` except the signature verifier, and must never read `STRIPE_SECRET_KEY`. |
| S3 | `src/app/api/stripe/webhook/route.ts` must never handle a `customer.subscription.*` or platform `invoice.*` event. |
| S4 | Platform Stripe Customers carry `metadata.platform_owner_user_id`; merchant ones carry `metadata.customer_id`. The two metadata shapes never overlap. |
| S5 | No platform module reads `payments`, `invoices`, `payment_methods`; no merchant module reads `platform_*`. |

A `scripts/verify-billing-separation.ts` guard should pin S2, S3 and S5 by
static import/identifier analysis, wired to `verify:billing-separation` (the
`verify-all` parity contract requires the npm entry, or the whole suite fails).

---

## 10. Security invariants

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Business A cannot alter B's subscription | No write policy exists; only service-role writes; tenant resolved from `stripe_customer_id`, never from client input |
| I2 | A user cannot self-assert entitlement | No INSERT/UPDATE policy → a browser PATCH affects 0 rows. Not a column on the owner-writable `business_settings` |
| I3 | Stale client state cannot grant access | Every gated write re-resolves server-side; client state is display-only |
| I4 | A forged webhook cannot change state | HMAC verified against the platform secret before anything is read |
| I5 | A replayed webhook is a no-op | `platform_billing_events.event_id` primary key |
| I6 | Out-of-order events cannot regress state | Re-fetch from Stripe + `last_event_at` monotonic guard |
| I7 | A crew session sees no billing surface | No `business_settings` row → not a billing subject; no read policy match |
| I8 | Our billing failure cannot corrupt tenant money | Rule 0 — merchant webhook never reads platform state |

---

## 11. Open decisions (blocking implementation)

| # | Decision | Why it blocks code, not just copy |
|---|---|---|
| **D1** | **Card up front, or trial first?** | The structural fork. *Trial first*: we own trial state, no Stripe object exists until they pay. *Card up front*: Stripe owns the trial (`trial_period_days`) and `status` mirrors from day one. The schema above supports both — but the provisioning flow and the trigger differ. |
| **D2** | **Trial length.** | A literal in the trigger. Cannot be defaulted safely: it decides when the *existing production business* (the owner's own) would flip to `read_only`. |
| **D3** | **Monthly, annual, or both?** | Only affects which Stripe price the owner picks per deal. No code impact — confirming this is genuinely free is the point. |
| **D4** | **Does an existing business get a trial, or immediate `active`?** | Backfill semantics for the one live business. Getting this wrong locks the owner out of production. |

Explicitly **not** open, because §2 already settled them: plan count (one),
feature gating (none), per-seat pricing (no), public prices (none).

---

## 12. Deliberately not built

- **No pricing page, no self-serve checkout.** There is no public price.
- **No plan-tier feature gating.** The marketing site promises against it.
- **No seat counting / quantity sync.** Same reason.
- **No custom card-management UI.** Stripe's hosted Customer Portal, created
  server-side from the session user's own `stripe_customer_id`. We do not build
  a fake card UI over someone else's PCI scope.
- **No dunning cron.** Stripe's Smart Retries. Also the only Hobby-safe design.
- **No usage metering.** Nothing is metered because nothing is limited.

---

## 13. Prerequisites before charging a single beta business

1. Answer **D1–D4**.
2. Create the **separate platform Stripe account**; set
   `PLATFORM_STRIPE_SECRET_KEY` + `PLATFORM_STRIPE_WEBHOOK_SECRET` in Vercel.
3. Apply the §3 migration + the `business_settings` insert trigger, and backfill
   the one existing business per **D4**.
4. Ship `src/lib/billing/{plans,entitlements,stripe}.ts` +
   `/api/platform/billing/webhook` + `verify:billing-separation`.
5. **Independent of billing — fix `POST /api/payments/reconcile`.** It
   authenticates with `auth.getUser()` only, never checking
   `current_app_role() === 'owner'`, and runs on the service role. Any signed-in
   user — including a **crew member**, whose `payments` ledger is empty — gets
   back every succeeded PaymentIntent in the whole merchant Stripe account for
   90 days. Harmless at one business; a cross-tenant disclosure at two. **This
   blocks onboarding business #2 whether or not billing ships.**
6. Confirm `STRIPE_WEBHOOK_SECRET` (merchant) is set in the Vercel project that
   actually serves production — still listed as outstanding in
   `memory/payments-trust-decisions`.
