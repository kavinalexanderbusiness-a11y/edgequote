# EdgeQuote

Field-service management for 1–3 person operators (lawn & landscaping first,
multi-industry via trade packs), Canada-first. The product promise: **calm,
automatic, intelligent** — measure a property from satellite, price it with a
deterministic per-contractor engine, let the customer accept and pay without a
login, and learn true costs from every completed visit.

## Canonical documents (read these before building)

| Document | Authority over |
|---|---|
| [`PRODUCT-VISION.md`](PRODUCT-VISION.md) | **The product.** Strategy (Part I: the moat is the loop) + full product specification (Part II). Owner-approved; feature debates end here. |
| [`UX-DIRECTION.md`](UX-DIRECTION.md) | UX direction for all future UI work. Guidance, not a build order; freezes/specs win on conflict. |
| [`DETECTION_ENGINE_ADR.md`](DETECTION_ENGINE_ADR.md) | The one detection engine (`lib/signals/*`). |
| [`QUOTE-PRESENTATION-V2.md`](QUOTE-PRESENTATION-V2.md) | Pricing V2 Phase 6 spec (build gated on Phases 1–5). |
| [`ONBOARDING-FIRST-RUN.md`](ONBOARDING-FIRST-RUN.md) | First-run onboarding design (design only; lane not opened). |
| [`MULTI_INDUSTRY_ARCHITECTURE.md`](MULTI_INDUSTRY_ARCHITECTURE.md) | Multi-industry architecture — a trade is configuration, never a fork. |
| [`DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md) | **Deployment — the single source of truth:** migrations, env vars, external services, smoke tests, monitoring, and rollback. The live DB catalog is the migration authority — there is no ledger. |

Three permanent rules (from the vision, owner-directed): **real customer
feedback outranks assumptions · AI never produces a price · frozen lanes open
only by explicit owner approval.**

**Audits are history, not truth.** Point-in-time reports — `PRODUCTION_READINESS_REPORT.md`,
`MEASURE-AND-QUOTE-AUDIT.md`, `OFFLINE_ENGINE_AUDIT.md`, `PUBLISHING_AUDIT.md`,
`AUTOMATION_DEDUP_STATUS.md` — and the `docs/HARDENING-BACKLOG.md` are dated snapshots.
Read the date and verify against current code before acting; when one disagrees with a
canonical document above, the canonical document wins. New design work amends the relevant
canonical document deliberately — it never forks a second, competing one.

## Development

```bash
npm install
npm run dev          # Next.js app
npm run typecheck    # tsc --noEmit
npm run build        # production build
npm run verify:<x>   # deterministic engine harnesses (pricing, labor, accounting, …)
```

Verify suites are the contract: check **exit codes**, not checkmark counts.
`supabase/RUN-*.sql` files are the record of applied production migrations —
committed, never re-run out of order.

Stack: Next.js (App Router) · Supabase (Postgres/Auth/Storage/Realtime) ·
Stripe · Twilio/Resend · Vercel (project `kavinalexanderbusiness-a11y-edgequote`).
