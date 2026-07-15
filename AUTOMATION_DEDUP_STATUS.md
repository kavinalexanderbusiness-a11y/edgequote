# Phase 1 — de-duplication status (architecture only)

Companion to `AUTOMATION_ARCHITECTURE.md` / `AUTOMATION_REMEDIATION_PLAN.md`.
Branch `guardian-2`. Behaviour-preserving unless noted. No new automations.

---

## DONE — one rule, one home

| Rule | Was | Now |
|---|---|---|
| VIP threshold | `1500` hardcoded ×4 | `signals.VIP_LTV` |
| Cadence interval days | 4 byte-identical copies | `signals.cadenceDays` |
| Lifetime value | 5 recomputations | `signals.lifetimeValue` / `visitValue` |
| Seasonal dormancy | inline ×4 | `signals.isSeasonallyDormant` |
| Recurring ran-out | 5 derivations | `signals.ranOut` |
| Lapsed | inline ×2 | `signals.isLapsed` |
| Churn risk | 4 engines, 4 thresholds | `signals.churnRisk` |
| Quote staleness | 2 forks | `followup.quoteIsQuiet` (clock injectable) |
| **Chase policy resolve** | **`resolveFollowUpPolicy` ≡ `resolveReminderPolicy`** | **`automation/policy.resolveChasePolicy`** |

Verified: `tsc` clean; `scripts/verify-automations.ts` **96/96 PASS** (it imports the
real chaser functions, so it proves the policy extraction changed no decision).

### Where follow-up lives, and why not in `signals/`
`lib/followup.ts` owns the whole follow-up domain — the staleness rule, the owner's
chase policy, the exhaustion gate, the DB patches. It already satisfies the signals
contract (`quoteIsQuiet` takes an injectable clock, no DOM), so mirroring it into
`signals/` would just be a second name for the same thing. `signals/index.ts` says so.

**Load-bearing detail:** `needsFollowUp(q)` is deliberately **one argument**. Callers
do `quotes.filter(needsFollowUp)`, so an optional 2nd parameter would silently receive
filter's *index*. The parameterised form is the separately-named `quoteIsQuiet`.

---

## Dispatch pipeline — who is on it

| Sender | Kind | On `dispatchToCustomer`? |
|---|---|---|
| `cron/campaigns` | automation | ✅ |
| `cron/quote-followup` | automation | ✅ |
| `cron/invoice-reminders` | automation | ✅ |
| **`cron/notifications`** (reminders + review requests) | automation | ✅ **this pass** |
| `lib/comms/receipt.ts` | automation (webhook) | ❌ — deliberate, see below |
| `api/comms/send/route.ts` | manual | ❌ — see below |

`cron/notifications` was converted with `thread: false`, preserving the fact that
reminders/review requests have never written a conversation bubble. Verified by
`scripts/verify-automations.ts` **96/96**.

### `receipt.ts` — a different rule, not a duplicate (OWNER DECISION)
It cannot go on the shared pipeline without changing behaviour, because its consent
model is **deliberately different**:

1. **Email is transactional** — it does NOT check `email_opt_in`. `dispatchToCustomer`
   does. Converting as-is would **stop sending receipts to customers who opted out of
   email** — for money they just paid. Almost certainly wrong.
2. **No `prefAllows`** — dispatch checks the category. Converting would suppress
   receipts for anyone opted out of the `invoices` category.
3. **Channel order** — receipt sends **email first**, dispatch hardcodes **sms first**,
   and the threaded bubble records the first-sent channel. The bubble's channel would
   flip.
4. **Skips are logged only for live channels** (`commsEnabled()`); dispatch/logDispatch
   would log `disabled` rows too.

**To do this safely dispatch needs two additions:** a `transactional?: boolean` that
bypasses `email_opt_in` + `prefAllows`, and iteration in the caller's `channels` order
rather than hardcoded sms→email. Both touch every existing sender. Also in the frozen
invoice/payment domain. **Question for the owner: should a receipt ignore `email_opt_in`?**
(Today it does. That looks correct — but it should be a stated decision, not an
accident of a separate code path.)

### `api/comms/send/route.ts` — the 4th copy (manual)
Not an automation, so out of this pass's stated scope, but it is the last
re-implementation of the gate. It differs from dispatch in that it also stamps
`on_my_way_at` as a side-effect of sending and honours a `bodyOverride`. Converting it
is a bigger job than the crons and should be its own change with the harness extended
to cover the manual path first.

---

## NEEDS AN OWNER DECISION — documented, NOT changed

### 1. `is_initial_visit` — LTV disagrees by screen
`customerHealth` prices a first visit at the **initial** rate. `revenueIntelligence`,
`reactivation` and `suggestions` price it at the **recurring** rate — they route through
`profitability.jobValue`, which never passes the 4th argument.

The rest of the app honours it: `geo.ts:72`, `invoicing.ts:145,203`,
`schedule/page.tsx:170,1234`, `weatherImpact.ts:242`, `labor.ts:221`. So the three
that don't look like the outliers.

**Why not just fixed:** LTV gates the VIP flag, referral eligibility (`≥300`), the
`≥1000` bonus and every ltv-derived expected value — and aligning it properly means
changing `profitability.jobValue`, which the **route-profitability grading** engines
also use. BI additionally needs its `avgLifetimeValue` to reconcile with its own
`revenueYTD`/`grossProfitYTD`, which value via the same function. So this moves
revenue dashboards *and* route grades. Product call, not a refactor.

### 2. Churn boundary `>` vs `>=`
`customerHealth` used `>=`; `revenueIntelligence` used `>`. One shared rule can't be
both. `signals.churnRisk` uses `>=`. Affects only a customer sitting **exactly** on
1.25× or 1.6× cadence (e.g. monthly at exactly 48 days), who now takes the higher
tier. Revert = add a parameter, which re-forks the rule. Left as-is; flag if unwanted.

### 3. Cadence label fork (wording, not code)
The same recurrence reads **"Bi-Weekly"** on the quote (`PricePackagePanel.CADENCE_LABELS`)
and **"Every 2 weeks"** on the schedule (`types.RECUR_FREQ_LABELS`). Needs an owner
wording call before either is deleted.

---

## KNOWN DUPLICATION — deliberately not touched (collision risk)

Branch **`guardian/dedup-2026-07-14`** (parallel session, held for approval) already
has these queued. Doing them here would conflict:

- **Cron auth preamble copy-pasted ×7** (every cron route; non-constant-time compare —
  one fix in seven places) → `lib/cron/guard.ts requireCron()`
- **`runChaseCron`** — the quote chaser and the invoice chaser are the same loop twice.
  A third chaser will copy it again. *(This is the natural next home for
  `automation/policy` + `automation/types`: same policy resolve, same claim-then-send,
  same run log.)*
- `bizInfo`/`bizCache` ×4 + `'Edge Property Services'` ×5
- `money()` ×3, `dateStr()` ×3, PDF `COLORS` ×2
- `sms/inbound` hand-rolls an upsert instead of the one `getOrCreateConversation`
- `localTodayISO` — 5th copy in `schedule/page`

## NOT DUPLICATION — verified false positives (do not "fix")

- **Route density.** `suggestions.propertyStops` and `businessIntelligence` *both* call
  the shared `locatedStops`, which dedupes by rounded coordinate. There is no
  28-visit inflation bug. Both are correct.
- **`recurrence.paused`.** A factual "no future visits" label on a plan — not a risk
  signal. A snow plan in July genuinely *is* paused. It is not a 6th `ranOut` copy.

---

## Automation engine — prepared, NOT wired

- `lib/automation/types.ts` — contracts only. Modes (`off | suggest | auto`), the
  hold/undo window, dedupe key, run log with a **suppression reason**. No runtime.
- `lib/automation/policy.ts` — the first real shared piece, in use by both chasers.
- `lib/signals/*` — pure, clock-injected, DOM-free, primitive inputs. This is what
  lets a future `/api/cron/signals` evaluate detection server-side.

**The gap that still defines the product:** ~75 detectors exist and only 3 run without
a browser open. The two new chasers are the 4th and 5th. Closing that is Phase 1.6
(`/api/cron/signals`) — not started, and not startable until the owner rules on the
decisions above, since they'd drive real sends.
