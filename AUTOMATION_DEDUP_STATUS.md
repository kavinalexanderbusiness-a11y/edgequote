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
| **`lib/comms/receipt.ts`** | automation (webhook) | ✅ — via `transactional`, see below |
| **`api/comms/send/route.ts`** | manual | ✅ — the last one |

**Zero hand-rolled consent gates remain.** Every sender in the product — automated and
manual — decides opt-in, category consent, contact presence and skip reasons in exactly
one place: `dispatchToCustomer`.

`comms/send` kept its own API contract (the `results` map's legacy vocabulary:
`no-optin` / `no-phone` / `no-email`), translated by the pure, harness-pinned
`sendResultsFromAttempts`. Two traps found during the extraction, both of which would
have been silent behaviour changes:
- **`push` was nested inside the `else` of the category gate** — so a category-blocked
  customer requesting push got `no-optin`, not `disabled`. Lifting the block out
  "unchanged" would have flipped that.
- **The raw `SendResult` omits absent keys** (`{sent,reason,id}` on success,
  `{sent,reason,error}` on failure). Emitting `error:null`/`id:null` would have changed
  `'error' in r` for all 9 callers. Null fields are omitted; the harness pins it.

`cron/notifications` was converted with `thread: false`, preserving the fact that
reminders/review requests have never written a conversation bubble. Verified by
`scripts/verify-automations.ts` **96/96**.

### `receipt.ts` — now on the pipeline, its rule made explicit
Dispatch gained exactly what receipt's semantics required, so the rule is now *stated*
instead of living in a separate code path:

- **`transactional?: boolean`** — bypasses the category check and `email_opt_in`,
  because a receipt for money someone just paid is not a message they can be
  unsubscribed from. **SMS still requires `sms_opt_in`** either way: carrier consent
  isn't ours to waive. Default false — nothing is transactional by accident.
- **`channels` are attempted in the caller's order** (was hardcoded sms→email). The
  threaded bubble records the first channel that sent, so order is meaningful. Every
  pre-existing caller passes `['sms','email']` or a single channel, so this is a no-op
  for all of them; receipt passes `['email','sms']`, preserving its email-first bubble.
- Only LIVE channels are attempted (`commsEnabled()`), preserving receipt's
  long-standing "don't log the dead channel" behaviour without a special case in the
  logger.

**The owner decision is unchanged and still open:** *should a receipt ignore
`email_opt_in`?* Today it does — that looks right, and it is now explicit at the call
site rather than implied by a separate sender. Flipping it is a one-line change to
`transactional`.

**The pre-extraction reasoning, for the record** — it could not go on the pipeline until
dispatch could express:

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

Both additions are now in dispatch (above), so the extraction is done with behaviour
preserved.

### ⚠️ The verification harness was flaky — fixed
`scripts/verify-automations.ts` anchored its fixtures to **noon** (`isoNDaysAgo` did
`setHours(12,0,0,0)`) while the rule under test counts **elapsed 24h periods** from the
wall clock. So "sent 3d ago → due at delay 3" only became true after midday: **the
harness passed every afternoon and failed every morning** (4 boundary cases). Proven
pre-existing by stashing all local edits and re-running against untouched `5f93739` —
same 4 failures. Fixture is now `Date.now() - n×86_400_000`, which tests the real rule
at any hour. 96/96, deterministic.

This is the same wall-clock-vs-calendar-day seam the owner ruled on (keep wall-clock).
The harness had quietly encoded the *calendar* expectation.

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

## ⚠️ Overlap with `guardian/dedup-2026-07-14`

That branch's backlog listed `lib/cron/guard.ts requireCron()` and `runChaseCron`
(catalogued, not built). **Both are built here.** Verified before starting: `main` has no
chase extraction and no `lib/automation/`, and that branch has since moved on to other
work (payments single-writer, CEO dashboard, campaigns) — so neither was claimed and no
effort was duplicated. Whoever merges second should drop those two backlog entries.

### `runChaseCron` — done
The two chasers were the same loop twice. What they actually shared wasn't line count —
it was the parts that are **dangerous to re-type**, and which a third chaser would get
subtly wrong:
- **Claim BEFORE sending.** The compare-and-swap must precede dispatch or two overlapping
  runs both send. Order *is* the safety property.
- **`'error'`, not `'failed'`.** A throw means we don't know whether a provider received
  it, so it must stay retryable; `'failed'` is reserved for a provider reporting delivery
  failure and suppresses future attempts. Backwards = silently stops chasing real money.
- **One bad row must never abort the batch**, or the rest of the owner's book goes
  unchased until tomorrow.
- **What the tally counts**: `chased` = claims consumed, `sent`/`skipped` = what dispatch
  actually did.

Each chaser keeps only what is genuinely its own: its query, its stop conditions
(`invoiced` / `isQuoteExpired`), its policy, its CAS statement, and its message. Net
−25 lines, but the point is that the invariants now live in one reviewed place.

One subtlety worth recording: `render` runs *after* `claim`, and the meta needs the
pre-claim count. The row object isn't mutated by the CAS, so `(count ?? 0) + 1` in
`render` is the same number the CAS wrote — no threading of state required.

## Owner settings — one read, one fallback

`bizInfo` was hand-rolled in **4 crons**, each re-typing `company_name || 'Edge Property
Services'` underneath it. That fallback is the name a **customer** reads when an owner
hasn't set theirs — it signs their reminders and review requests. Four copies aren't a
default; they're four defaults that agree until someone re-words one.

`lib/automation/owner.ts loadOwnerContext` is now the single read: the union of all four
select lists in **one query per owner per run** (unchanged — a wider column list rides
along free on a row already being fetched). The two chasers get caching free from
`runChaseCron`; campaigns/notifications keep their own loop caches. `api/comms/send` (the
manual path, a 5th copy) folded in too — so a manual message and an automatic one can
never sign off as different businesses.

**Remaining `'Edge Property Services'` (5, deliberately):** client-side `useState` seeds
in `JobMessages`, `DayBulkMessage`, `RainDelayCenter`, `BeforeAfterStudio`. They seed a
**preview** while settings load; the message that actually sends re-renders server-side
through the loader. Routing a settings fetch into client components is a real change, not
a de-dup — and page metadata / static marketing copy elsewhere aren't fallbacks at all.

## The engine — built, and deliberately unable to send

The full loop now exists end to end, in **observe mode**:

```
/api/cron/signals   detectors → automation_signals   (writes rows, sends nothing)
        ↓
/api/cron/engine    signals × rules → decide() → automation_runs
                    ZERO send imports in the file. Not "doesn't send today" —
                    cannot, structurally.
```

- `lib/automation/rules.ts` — the registry. Code-defined on purpose: inventing a rule
  should be a reviewed change, not a row someone types. **Every rule enters at the mode
  it already runs at.** The two registered rules are `suggest`, which is exactly what
  the product does today (surface it, act on nothing). Switching the engine on changes
  nothing — that is the point.
- `lib/automation/decide.ts` — **pure**. No client, no clock, no send path; it cannot
  message anyone by construction. Check order is deliberate so the recorded reason is
  the *useful* one (a rule that's off says "off", not "outside quiet hours").
- `suppressedReason: 'mode_suggest'` is distinct from `'mode_off'` — "waiting to be
  trusted" is not "switched off", and a run log that conflates them is useless.

**What this buys before a single message changes:** the run log answers *"what would an
automation have done last night, and why didn't it?"* for as long as it takes to trust
it. Promotion to `auto` is then a one-field change against evidence, rather than a leap.

`fired` is reported in the response and is 0 while every rule is `suggest` — so the day
it stops being 0 is visible to us, not discovered via a customer.

**Deliberately not built yet:** the Delay/Undo stages (`automation_queue`,
`UndoableAction`). Nothing can fire, so a hold window would be scaffolding guarding
nothing. They land with the first `auto` promotion, which is when they start mattering.
Likewise `recentActionsForSubject` is passed as 0 — a query for a number that is always
0 would be dead code pretending to be a safeguard.

## Contracts — prepared, NOT wired

- `lib/automation/types.ts` — contracts only. Modes (`off | suggest | auto`), the
  hold/undo window, dedupe key, run log with a **suppression reason**. No runtime.
- `lib/automation/policy.ts` — `resolveChasePolicy`, in use by both chasers.
- `lib/cron/guard.ts` — `cronSecretOk` (constant-time) + `serviceClient`. The preamble
  every scheduled route opens with, once.
- `lib/signals/*` — pure, clock-injected, DOM-free, primitive inputs.
- **`/api/cron/signals` + `automation_signals`** — the detection half. Sweeps the
  server-runnable detectors and records what it found. **It sends nothing, notifies
  nothing, mutates nothing user-visible.** Idempotent: one row per
  (user, signal, subject, day).

### Why a table nothing reads yet
Deliberate. A rule must **consume a signal**, never re-derive the condition — re-deriving
is exactly how six screens ended up disagreeing about who had churned. The ledger has to
exist before the first rule can be honest. Until then the sweep is observability: it
answers "what would an automation have seen last night?" without anyone being messaged.

**Run this now:** `supabase/RUN-2026-07-14-automation-signals.sql` (the sweep degrades
gracefully without it — it reports the missing table instead of failing nightly).

**Signals emitted today:** `recurring_ran_out`, `churn_risk` (both customer-subject).
Deliberately a small, verified start rather than all ~75 at once — each additional
detector must first be proven server-runnable and duplicate-free, per the signals
contract.

**The gap that still defines the product:** ~75 detectors exist; before this pass three
ran without a browser open, and the two new chasers made five. This sweep is the first
that exists to be *read* rather than to send. The remaining ~70 are still browser-only.
