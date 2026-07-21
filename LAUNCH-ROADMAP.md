# EdgeQuote — Launch Roadmap (living status)

**Reconciled 2026-07-21 against `origin/main` @ `bf667fd`.** This is a living
status tracker, not a spec. It opens no lane, repeals no freeze, and is
subordinate to `PRODUCT-VISION.md`. Finding-level detail lives in the audit that
spawned it (`PRODUCTION_READINESS_REPORT.md`, 2026-07-02); post-launch reliability
work lives in `docs/HARDENING-BACKLOG.md`. Merge status is verified against the
git log, not assumed — a blocker is "done" only when it is on `main`.

The roadmap began as **104 audit findings reduced to 13 canonical blockers + 1
owner decision** (root pattern the owner accepted: *a canonical seam is
introduced, the old execution path keeps running* — every fix ENFORCES the seam
by deleting or routing the old caller, never adds a new one).

---

## Verdict — the roadmap has essentially cleared

**11 of the 13 engineering blockers are merged to `main`.** The launch gate is no
longer engineering correctness; it is **one owner infrastructure action** (set
`CRON_SECRET`) and **one owner product decision** (self-serve signup). Everything
that could charge the wrong amount, mint duplicate records, skip consent, or
silently truncate a revenue read has been routed through its single seam and
shipped.

---

## ✅ Merged — removed from the active roadmap

| Blocker | What it enforced | Landed on `main` |
|---|---|---|
| **PAY-1** | Workforce FK cascade → `set null` + technician archive (deleting a person no longer erases their pay history) | `RUN-2026-07-17-payroll-archive-technicians.sql` + `lib/crews.ts archiveTechnician` |
| **SCH-1** | Un-completing a visit reverts its draft invoice as **one** offline op (no stranded half-state) | `83d439c` |
| **MEAS-1** | `property_measurements` is the sole authority for `lawn_sqft` (was 3 stores / 3 writers) — the pricing foundation | PR #36 (`413db60`, `7b63dd4`); guard trigger + `RUN-2026-07-17-meas1` live in prod |
| **PR-1** | Price targets derive through the cadence/grade seam; guardrail `ctx` is now compiler-required so no caller can skip it (killed the 1-click one-time-price-on-recurring bug) | PR #37 (`0a24ddb`, `2524793`) |
| **QL-1** | One quote-status writer (`QuoteStatusControl`) — the builder dropdown was a 5th raw writer that killed expiry/follow-up | PR #37 (`031bbb4`) |
| **QL-2** | Quote address is a document snapshot, never a match key (stopped edits manufacturing duplicate properties) | PR #37 (`0677061`) |
| **BK-1** | The public booking door dedupes customer + property on every submission (was minting a new customer each time) | PR #39 (`f0722f7`) + intake alignment PR #42 (`f6b9694`) |
| **MSG-1** | One send governor owns when/how-often; bulk review-requests respect marketing opt-out (CASL) — was 9 senders, 5 dedupe brains, zero frequency governance | PR #40 (`bf667fd`, `3d093aa`) |
| **RPT-1** | Money flows through one visit-value seam (`jobVisitValue`); no surface sums `payments.amount` raw (fixed the 63%-null-quote $0-margin class) | `06fb97a` + `6812d58` |
| **PERF-1** | One paging helper (`pageAll`); every revenue/collection read is bounded (the invoices page no longer truncates unpaid at 1000 and disagrees with dashboard Owed) | `f379f71` + `d49037b` |
| **INF-1** *(cadence half)* | Cron cadence reconciled to daily; Hobby-plan sub-daily crons removed (they had been failing the whole deploy); cadence precedence ADR complete | `ed9dc44` + `45e93eb` |

---

## 🔴 Remaining launch blockers

Both are **owner actions**, not engineering work.

1. **INF-1 (the secret) — set `CRON_SECRET` in Vercel.** The cadence is fixed and
   `vercel.json` defines **12 daily crons** (reminders, invoice-reminders,
   autopay, reports, campaigns, quote-followup, publish, marketing-draft,
   scheduled-messages, integrations, signals, engine). Until the secret is set,
   the cron routes reject every invocation and **the entire scheduled layer never
   runs** — no reminders, no AutoPay collection, no reports, no campaigns. This is
   the single hard blocker to a functioning launch. *Owner: set it, then confirm
   one cron fires (the `DEPLOY_CHECKLIST.md` smoke test covers this).*

2. **OWN-1 — self-serve signup.** Still absent. A "buyable" 1.0 needs a way for a
   contractor to create an account without a manual invite. This is a product
   decision, not a defect. *Owner call: is 1.0 invite-only (pilot) or open?*

---

## 🟡 Open, but not launch-gating

- **INF-2 — canonical `get_portal_data` is NOT merged.** The reconciliation work
  exists on branch `inf/portal-canonical` (`f387053`, `4b1f2e9`) but never landed;
  `main` still carries **10 RUN files** that `create or replace` `get_portal_data`,
  and nothing enforces a single definition. Production already holds the correct
  body, so this is a **disaster-recovery / repo-hygiene** risk (a fresh deploy or a
  re-run of an older file rolls the portal backward), not a customer-transacting
  bug. *Recommend: merge the branch, then add a `verify:sql` guard asserting
  exactly one canonical definition. Needs an owner go-ahead — it touches the
  portal freeze's SQL surface.*

---

## Post-launch (not blockers)

`docs/HARDENING-BACKLOG.md` holds the ranked reliability backlog (portal failure
UX, provider-vs-decline distinction, invoice-number unique constraint, cron
lookback widening, centralized error monitoring). One item has a launch
precondition worth flagging:

- **Hardening #4** — a multi-day Stripe webhook outage can defeat the AutoPay
  double-charge guard (the idempotency key expires ~24h). *Do before launch ONLY
  if AutoPay is enabled for customers on day one*; otherwise first-month. The
  durable guard is the pre-charge DB dedupe, so gradual AutoPay onboarding makes
  this comfortably first-month.

---

## Context — the product surface advanced in parallel

Not blockers, but the reason the launch bar is now infra + product-decision rather
than correctness: since the audit, the **portal was redesigned** (`21659be`, one
account understood at a glance), the **mobile shell** moved navigation to a
thumb-reachable bottom bar (`e825685`, `11625b0`), the **dashboard** opens on a
ten-second Morning Briefing (`14bfb06`), and **ADR-002 config provenance** shipped
(every price writer records its reasons). The engines are strong and the surface
is coherent; what remains is turning the key.

---

*This document supersedes the memory-only launch roadmap as the repo-of-record.
When it and the audit report disagree, verify against current code — the audit is
a dated snapshot; this tracker is reconciled against the merge log.*
