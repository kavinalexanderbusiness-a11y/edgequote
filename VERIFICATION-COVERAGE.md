# Verification coverage — the characterization sweep, and where it ends

This records the state of behavioral (characterization) test coverage over the shared
pure libraries, and — deliberately — **why the sweep is stopping here.** It exists so the
next person doesn't re-walk all 140+ `src/lib` modules to rediscover that the
high-value pure engines are already pinned.

Characterization tests here are the `scripts/verify-*.ts` harnesses, each wired into
`package.json` and `.github/workflows/ci.yml`. They assert **values** — the class of bug
`tsc` and `next build` sail straight past (a wrong price, a wrong ETA, a mislabelled
consent skip) — by running the real pure functions with fixed inputs. They change **no
production behavior**; several harnesses caught real subtleties precisely because they run
the code rather than describe it.

## Pure decision engines now covered

| Engine | Harness | What it pins |
|---|---|---|
| customer matching | `verify:customer-v2` | phone last-10 identity, email/address/name precedence, address token+prefix |
| dedup (property/job/photo) | `verify:dedup` | ~35 m same-lot radius, cancelled-never-counts, hamming near-photo |
| lead intake | `verify:lead-intake` | honeypot/token strip, HTML-injection escape, snake/camel alias contract |
| booking photos | `verify:booking-photos` | the `^https?://` URL filter, shape guards, dedupe |
| booking link/token | `verify:booking-link` | anti-enumeration token shape, canonical URL builder |
| routing | `verify:route` | ETAs, greedy vs manual order, dayLoad (blocked-day 0 vs unknown −1), 9-waypoint cap |
| quote lifecycle | `verify:quote-status` | expiry overlay (sent-only; today still valid), send-gating precedence, markSentPatch omit-not-overwrite |
| follow-up / chasing | `verify:followup` | CASL consent gate, two-then-stop cap, oldest-then-stale-money order, policy clamps |
| **visit value (money)** | **`verify:visit-value`** | **the RPT-1 seam: price-BUCKET resolution (month/quarterly/annual → monthly), manual-price-wins, anchor-uses-initial** |

Plus the pre-existing engine harnesses: `pricing`, `guardrails`, `labor`, `density`,
`learning`, `seasons`, `recurrence`, `automations`, `comms-governor`, `business-shape`,
`trades`, `onboarding`, `modules`, `ai-context/assist/surface`, `integrations`,
`analytics`, `inventory`, `accounting`, `reports`, `portal`.

## Why the sweep stops here

The remaining ~140 uncovered `src/lib` modules were enumerated and cross-referenced
against the harness imports. They fall into buckets where a characterization test is
low-value, not the right tool, or redundant:

- **I/O-bound (the majority)** — data loaders and mutators: `accounting/data`,
  `dashboard/data`, `marketing/*`, `payments/*`, `crm/*`, `analyticsData`, `autoMeasure`,
  `scheduleQuote`, `timelineData`, `reactivation`, `workforce`, `payroll`, `leads`,
  `notifications`, `supabase/*`, everything under `offline/`. Their logic is "read rows →
  shape → write rows"; a pure test would assert a mock, not behavior. Their correctness is
  better served by the integration/RPC layer than by characterization.
- **Browser / rendering** — `googleMaps`, `beforeafter/*` (canvas), `exif`, `pdfTheme`,
  `portalPdf`, `theme`, `motion`, `toast`, `confirm`, `prefetch`, `push`, hooks like
  `sms/useSmsPricing`. Not pure decision logic; need a DOM.
- **Trivial / data-only** — `grade` (a colour map), `*/types`, the `*/index` barrels,
  `signals/constants`, `marketing/holidays|styles`, `distance`, `csv`. Nothing to
  characterize beyond a constant.
- **Frozen and adequately guarded elsewhere** — `comms/*` (messaging freeze;
  `reach.ts`'s consent rules are exercised transitively by `verify:followup`),
  `stripe/config` + `payments/*` (invoice/payment freeze), `automation/policy` (its clamps
  are pinned via `verify:followup`'s `resolveFollowUpPolicy`).
- **Already the money seam, now pinned** — `visitValue` was the last high-consequence
  one; this pass closes it.

## Genuinely pure engines a FUTURE deliberate pass could take (not forced now)

These are pure and testable but were judged lower-value than the money seam, so they are
left as a **conscious choice**, not an oversight. Pick them up deliberately if the value
justifies it — do not add a verifier just to add one:

- `signals/lifecycle` — churn / lapsed / seasonally-dormant detection (retention
  decisions). The strongest remaining candidate; pure, no I/O. Worth doing if reactivation
  accuracy becomes a focus.
- `sms/segments` — GSM-7 vs unicode encoding + segment/cost math. Pure, edge-rich; value
  scales with SMS spend.
- `measure/geometry` — polygon area / path length. Pure math feeding measured area; low
  regression risk (it's geometry), which is why it's not urgent.
- `measure/confidence`, `disruption` (reschedule; scheduling-frozen),
  `scheduleWarnings` (scheduling-frozen), `laborCost` (money aggregation, large, one I/O
  touchpoint) — medium value, several behind freezes.

**Bottom line:** the business-critical pure decision engines with meaningful behavioral
gaps are covered. Further verifiers would be marginal, I/O-bound, or redundant — so the
routine "find one more" sweep ends here by design.
