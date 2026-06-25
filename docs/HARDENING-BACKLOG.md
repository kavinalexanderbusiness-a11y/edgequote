# EdgeQuote — Hardening Backlog (post-audit, 2026-06-25)

Deferred findings from the adversarial production audit, ranked. **Implemented already
(not in this list):** #1 duplicate-invoice double-charge guard, #2 Maps-route auth,
#3 schema reproducibility, #10 failed-fetch error states. None of the items below are
launch blockers; the money path is sound.

**Scales:** Launch impact / Money risk / User impact = None · Low · Med · High.
Difficulty = Trivial (~5 lines) · Small (<½ day) · Medium · Large.

| # | Finding | Launch impact | Money risk | User impact | Difficulty | Timing |
|---|---|---|---|---|---|---|
| 4 | Multi-day webhook outage can defeat the AutoPay double-charge guard (idempotency key expires ~24h; cron could re-charge) | Low | **Med** | Low | Medium | **Before launch** if AutoPay is on day 1; else First month |
| 5 | Transient Stripe/network outage reported to owner as a card "decline" | Low | None | Med | Small | First month |
| 6 | Hard-declined card re-attempted every cron run for ~14 days (issuer fraud-flag risk) | Low | Low | Low | Small | First month |
| 7 | Portal shows a transient load error as a permanent "dead link" | Low | None | **Med** (paying customers) | Small | First month |
| 8 | Portal "Accept quote" gives no feedback on failure | Low | Low | Med | Trivial | First month |
| 9 | Invoice number (INV-####) computed app-side, no unique constraint → concurrent collision | None | Low | Low | Small | First month |
| 11 | Portal AutoPay toggle has no try/catch → optimistic state can stick | None | None | Low | Trivial | First month |
| 12 | Portal "Request service" silently no-ops on failure | None | None | Low | Trivial | First month |
| 13 | Public portal `autopay`/`setup-card` routes lack rate limiting | Low | None | Low | Small | First month |
| 14 | Permanently-invalid phone/email retried + re-logged every notifications cron run | None | Low (per-attempt SMS cost) | None | Small | First month |
| 15 | AutoPay cron recovery bounded to a 14-day window / depends on cron running | Low | Low | Low | Small | Scale |
| 16 | Failure/refund/dispute notification dedupe is check-then-act (worst case: a duplicate toast) | None | None | Low | Small | Scale |
| 17a | Google `error_message` echoed verbatim to callers (minor info disclosure) | None | None | None | Trivial | First month (folds into #2) |
| 17b | `record_booking_measurement` accepts an unscoped `quote_id` (pollutes accuracy analytics) | None | None | None | Trivial | Nice-to-have |
| 17c | Portal token ~41-bit entropy, no expiry (accepted login-less tradeoff) | Low | None | None | Medium | Scale |
| 17d | Website-lead rate limit is a coarse per-hour count (no per-IP) | None | None | None | Small | Nice-to-have |
| 17e | Portal `setup-card` persists `stripe_customer_id` best-effort (webhook back-fills) | None | None | None | Trivial | Nice-to-have |
| 17f | Client measurement handoff lost on refresh (unsaved measurement) | None | None | Low | Trivial | Nice-to-have |
| 1c | Calendar "Done" in-flight guard (scheduler-owned; the unique index already prevents the double-charge) | None | None | Low | Trivial | First month — **scheduler session owns this file** |

## By recommended timing

**Before launch (only if AutoPay is enabled for customers on day one)**
- **#4** — add a Stripe reconciliation (search PaymentIntents by `metadata.invoice_id`) before charging a draft older than the ~24h idempotency window. Highest *money* item remaining, but narrow precondition (sustained >24h webhook outage). If AutoPay onboarding is gradual, this is comfortably First-month.

**First month (reliability + customer-facing polish)**
- **#7, #8, #11, #12** — portal failure UX: replace silent no-ops / permanent-dead-link with the fixed-string error + retry pattern already used by `pay()`. Customer-facing; cheap.
- **#5, #6** — distinguish "provider unavailable" from "card declined", and stop re-charging hard declines. Prevents wasted customer outreach + issuer fraud flags.
- **#9** — `unique(user_id, invoice_number)` + recompute-on-violation.
- **#13, #14, #17a, #1c** — small consistency/abuse/log-noise fixes.

**At scale (revisit when data/traffic grows)**
- **#15, #16, #17c** — widen cron lookback / escalate stuck drafts; partial unique index on system notifications; portal-token expiry/rotation.

**Nice-to-have**
- **#17b, #17d, #17e, #17f** — analytics hygiene, finer rate limiting, best-effort logging, sessionStorage retention.

## Notes
- **Observability** wasn't covered by a dedicated audit agent (it failed mid-run). Verified separately: per-failure `console.error`/`warn` on webhook/cron/charge paths, durable `notification_log` audit trail, owner-facing `notifications` for payment_failed/autopay_review/refunded/disputed, `website_leads.raw_submission` intake audit. The one real gap is **no centralized error monitoring (Sentry/Logflare)** — currently you read Vercel logs reactively. Low priority, post-launch.
- The audit's full "What's already solid" + "Considered and dismissed" sections are the source of truth for what was verified correct (idempotent webhook, single paid-state writer, triple AutoPay double-charge protection, RLS scoping, signature verification).
