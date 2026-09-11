# B3 — three-plan preview readiness

**Scope: source-only preparation. Paid launch: FIX FIRST. Stripe setup and activation: PARK.** The user has deferred Stripe account work. The three prices were delegated and approved through the launch coordinator; no further price or private-information prompt is needed.

This branch converges conflicting public prices and prepares read-only provider validation. It does not implement Checkout, billing portal sessions, a current paid-plan indicator, subscription creation, plan switching or paid enforcement. It changes no schema, production data, provider configuration or existing business access. S106 remains the sole main landing controller.

## One catalogue

| Plan | CAD/month, before applicable tax | Included code-backed capabilities |
| --- | ---: | --- |
| Base | 29.00 | Customers/service locations, quotes/invoices and visit scheduling |
| Plus | 59.00 | Base plus recurring visits, teams/crews, time tracking/timesheets and job/labour cost insights |
| Premium | 99.00 | Plus plus advanced business insights and operational suggestions |

`src/lib/productPlans.ts` is the single catalogue. Immutable cumulative features avoid differing inheritance between consumers. `/plans`, login, signup and setup now use the same plan names; the Plans page reads amounts from the catalogue. Signup is free early access, without a card, trial timer or automatic conversion. No selected plan is persisted or accepted as payment consent.

The capability inventory was reviewed against `de99c92a4898c1ee6876e624aa11d3a9a5f16f4c`:

- Core: `src/app/dashboard/customers`, `properties`, `quotes`, `schedule`, `invoices` and their existing RLS-scoped helpers.
- Plus: `src/lib/recurrence.ts`, `src/app/dashboard/workforce`, `dispatch/time`, `src/lib/timeTracking.ts` and `src/lib/laborCost.ts`.
- Premium: `src/app/dashboard/profitability`, `sales`, `reports` and `src/lib/automation/{rules,decide}.ts`. The two operational rules produce suggestions; dispatchers are empty. Reports and available code are not proof of live provider delivery or autonomous actions.
- Protected at all billing states: existing records, customer payment recording, exports, saved recovery and completion of existing work. Existing auth/crew/owner permissions still govern access; billing must not grant additional role permissions.

No paid scanning, SMS/email/AI credits, online payment processing, unlimited seats/usage, payroll remittance or autonomous customer messaging is promised. `platform_capabilities` and navigation/module preferences remain separate authorities.

## Prepared server components

`src/lib/billing/planCatalogue.ts` accepts only server configuration. Each plan needs its own `PLATFORM_STRIPE_PRICE_BASE|PLUS|PREMIUM` and matching `PLATFORM_STRIPE_PRODUCT_BASE|PLUS|PREMIUM`. These are symbolic configuration names, not activation instructions. No sandbox or live ID is embedded in source. The adapter copies immutable configuration before I/O, verifies actual separate Stripe accounts with the existing B2 adapter, then GETs the three prices from the fixed Stripe origin with expanded products/currency options. Redirects are refused; requests time out; price bodies are bounded to 64 KiB. Merchant credentials are used only to identify their account.

Provider facts must match active product/price, exact ID/mode, CAD 2900/5900/9900, per-unit licensed monthly recurrence with interval count one, no price-level trial, custom amount, tiers or quantity transformation. Missing expanded currency facts, alternate currencies or contradictory CAD options refuse verification. An inclusive-tax price conflicts with the before-tax offer. Even successful verification returns `checkoutEnabled: false` and `taxSetupVerified: false`. It is neither purchase consent nor an entitlement. Real provider verification has not run in this source lane.

`src/lib/billing/planPolicy.ts` resolves a **dormant preview policy**, using injected fresh server `auth.getUser()` and database `current_app_role()` ports, with an identity recheck after the role lookup. Invalid, switched, absent or failed authority cannot become a billing owner; crew cannot manage billing. Outputs always preserve existing role permissions and disable billing/enforcement. No paid plan is inferred. There is no mounted server adapter or actual paid capability resolver yet. The B1/B2 mirror lacks opt-in and full subscription commercial facts, so using its `status`/`price` to claim a paid tier would be incorrect.

## Verification boundary

The focused `verify:platform-billing-plans` guard runs actual catalogue parsing, fixed GET transport and preview policy against synthetic fixtures. It covers tampered/missing/duplicate IDs, in-flight configuration mutation, account/mode/product/amount/cadence/currency/trial mismatches, bounded failed provider reads, crew/owner/authority changes and unmounted/no-migration invariants. Existing estimator checks deliberately replace the obsolete null-price expectation with the approved catalogue while retaining no-enforcement/no-provider-allowance checks.

`verify-platform-billing-foundation.ts` keeps its existing no-runtime-import/no-schema-activation assertions. Only the exact dormant file inventory is extended for the two new modules. B1/B2 SQL and transport/reconciliation behavior are unchanged. Scoped source checks do not prove native concurrent transactions, live auth/PostgREST, provider integration, tax readiness or paid entitlement enforcement. The exact candidate's CI and review receipts belong in the handoff, not in a self-declared source PASS.

## Gates before paid launch

1. User resumes private Stripe setup; coordinator confirms separate actual account/mode and tax/payout/agreement readiness. Catalogue IDs remain test-only until provider reads verify them; test IDs must never become live defaults.
2. Review and prove a schema-first B3 enrollment/consent/operation contract. A durable owner/account/mode coordinator must exist before any customer creation, serialize purchase operations and preserve unresolved attempts beyond provider idempotency retention. An uncertain response permits recovery, not another charge attempt or a new plan/key.
3. Close concurrency with B2's account/event leases and result revisions. Provider commercial attestation must be complete, fresh and tied to the exact standing revision; the current B2 mirror alone cannot establish quantity/discount/offer facts or ordered paid rights.
4. Add authenticated owner-only Checkout and portal adapters with strict same-origin finite inputs, one fixed monthly item/quantity, stored customer mapping and fixed return paths. No browser price, amount, customer, tenant or subscription ID is authoritative. Return URLs cannot mark payment successful.
5. Prove signed replay-safe lifecycle handling, duplicate/concurrent customer/Checkout/subscription prevention, interrupted return, out-of-order events, failed renewal and period-end cancellation. Use independent native database backends and real provider test-mode replay, without production business writes.
6. Review a single authoritative paid capability resolver and close each feature's actual direct SQL/RPC/server writer. Menu visibility and the dormant policy are insufficient. Preserve established early-access rights until explicit opt-in, protected data/export/payment rights and existing work through failures/cancellation/downgrades.
7. Keep paid plan switches off until a version-bound preview discloses timing, amounts and proration before consent. Review cancellation separately: no immediate cancellation or silent subscription replacement.
8. S106 freshly measures main, reviews the exact schema/source/test package and applies only the approved schema-first plan, with zero unintended business-row mutations. Feature sessions do not land main or activate providers.

Provider shape reference: [Stripe Price object, pinned Basil API](https://docs.stripe.com/api/prices/object?api-version=2025-03-31.basil) and [retrieve a Price](https://docs.stripe.com/api/prices/retrieve?api-version=2025-03-31.basil). The reviewed transport retains `2025-03-31.basil`; this lane does not upgrade the provider API.
