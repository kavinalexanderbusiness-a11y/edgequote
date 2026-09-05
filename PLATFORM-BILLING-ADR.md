# ADR-003 — Platform billing (EdgeHQ → the business owner)

**Status: B1 + B2 OFFLINE DRAFTS, UNAPPLIED. Free early access; paid activation is deferred.**

Updated September 5, 2026. The user approved public self-service signup and free early access. A later paid price, billing cadence and trial duration remain unset. The old proposed trial defaults, business-insert trigger, backfill and `standard` plan are withdrawn. This revision prepares an isolated foundation and reconciliation engine; it does not make paid signup ready.

## Merchant payments and platform billing

| | Merchant payments | Platform billing |
|---|---|---|
| Money flows | Customer → service business | Business owner → EdgeHQ |
| Stripe account | Existing merchant account | **A different Stripe account** |
| Credentials | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Future `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET` |
| Webhook | `/api/stripe/webhook` | Future `/api/platform/billing/webhook` |
| Code | `src/lib/stripe/*`, `src/lib/payments/*` | `src/lib/billing/*` |
| Records | Customer invoices, payments, payment methods | Owner account mapping, subscription history, private processing events |

Different keys in the same Stripe account are insufficient. Merchant reconciliation lists account-wide PaymentIntents; platform subscription charges in that account could be reported as unrecorded merchant revenue. Before any provider activation, verify that the platform merchant account ID differs from the existing merchant account ID. Identifier prefixes or environment-variable names are not proof of separation.

**The merchant webhook must always record customer payments regardless of the business's platform subscription.** Billing must never alter tenant invoices, payments, payment methods, customer balances or `platform_capabilities`. Future platform code must not read the merchant ledger. Existing merchant code must not read platform billing state.

## Billing subject and authority

The billing subject remains the owner's `auth.users.id`. The existing unique `business_settings.user_id` identifies an owner; this introduces no second organization identity. Trusted account creation must verify a current business settings row. Crew users must never create, read or change billing records, even if faulty server code creates a mapping for a crew UUID.

All writes are server-owned. No account can declare itself paid through an owner-writable settings column, browser table write, metadata claim or public RPC. Current CRM access remains unchanged: there is no entitlement resolver, enforcement flag, trial, signup trigger or runtime consumer in B1.

## B1 draft objects

The executable contract is [supabase/drafts/platform-billing-b1.sql](supabase/drafts/platform-billing-b1.sql), deliberately outside the applied migration directory. It uses existing `extensions.uuid_generate_v4()` and the canonical `public.handle_updated_at()` trigger function. Its transaction creates only:

- `platform_billing_accounts`: owner UUID, explicit Stripe account/mode/customer mapping, UUID ID and timestamps. Unique owner/account/mode and account/mode/customer mappings prevent duplicate or cross-owner customers. A composite account/owner/provider/mode key anchors subscriptions.
- `platform_subscriptions`: subscription history linked through that composite key; explicit provider status, cancellation facts, nullable price/trial/period timestamps and last successful synchronization time. Provider subscription IDs are unique within account/mode. Canceled and incomplete-expired history is retained; only one incomplete/trialing/active/past-due/unpaid/paused subscription may occupy an account mapping. A scheduled cancellation still occupies the slot. Dates cannot run backward when both are known.
- `platform_billing_events`: private account/mode/event identity, verified event type/time, processing state, attempt count, lease, completion time and a bounded sanitized error code. It holds no raw payload, credential, card data or user-readable exception. An unmapped verified event can still be tracked privately.

There are no plan, seats, amount, balance, features or editable entitlement columns. Nullable price/date values mean unknown, not a free offer or indefinite access. Status, mode and cancellation flags have no commercial defaults. Unexpected provider statuses fail reconciliation until explicitly reviewed.

Only accounts and subscriptions have authenticated SELECT, each requiring both the caller's own UUID and a current own business settings row. All three tables enable RLS; explicit standing grants to PUBLIC, anon and authenticated are revoked. Events have no policies or authenticated SELECT. Service role receives SELECT/INSERT/UPDATE/DELETE only, after clearing inherited table defaults. No new function or security-definer mutation is created.

Two update triggers use the existing canonical function. New indexes support owner reads, the subscription FK/history lookup, one nonterminal subscription per mapping and event recovery inspection. No index or policy on an existing table changes.

The auth-user FK cascades the mapping and subscription history if an Auth user is deleted. B1 adds no deletion endpoint or job. Any future offboarding design must review provider cancellation, record retention and statutory obligations separately before deleting an Auth user. A billing failure must never delete an account or business records.

## Events: received is not processed

The former instruction “INSERT conflict means already processed; return 200” was incorrect. A duplicate proves only that an event was received. `received`, `processing` and `failed` rows are unfinished; only `processed` or deliberately `ignored` rows have `processed_at`. Processing requires a lease. Failed work and expired processing leases remain eligible for a subsequent attempt.

B1 supplies storage constraints, not a webhook handler, queue or concurrency guarantee. The local guard exercises illustrative SQL to prove the table can support atomic lease acquisition, attempt increments and conditional completion. That is not an end-to-end provider retry proof.

B2 must implement and independently prove all of the following before acknowledging events:

1. Verify the raw request signature with the platform secret and validate the actual platform account/mode. Resolve the owner from the trusted account mapping, never a client-supplied tenant ID or unverified metadata.
2. On duplicate event identity, inspect completion state. Claim unfinished work atomically by incrementing `attempt_count` and acquiring a lease. A busy unfinished event must remain retryable; row existence alone cannot produce a successful acknowledgment.
3. Fence stale workers. Conditional completion must include the claimed attempt count (or an equivalent ownership token), processing state and a valid lease. Ownership must also guard the subscription mutation in the same transaction; fencing only the final event stamp leaves an old worker able to regress state. An expired worker must not finish or overwrite the newer attempt.
4. Serialize canonical reconciliation per account/subscription across **different events**, including replacement subscriptions. A fresh provider fetch and event timestamp alone do not order concurrent handlers. Terminal transition and replacement must respect the partial unique index; never overwrite another provider subscription to evade it.
5. Set `last_synced_at` only after successful canonical reconciliation. Complete the event atomically with that successful write, or deliberately ignore a verified irrelevant event under an explicit policy. Unknown mappings/statuses are reviewable failures unless a later reviewed policy says otherwise.
6. Return a retryable error for unfinished work unless a separately designed durable recoverable queue owns it. This table stores no raw event payload; there is no polling cron or recovery worker in B1.

Provider state, ordering, lease races, crash recovery, signature rejection, test/live isolation and acknowledgment behavior require behavioral proof. Synthetic B2 proof is described below. Provider test-mode proof and real multi-backend lock contention remain activation gates.

## B2 dormant reconciliation

The additive [B2 draft](supabase/drafts/platform-billing-b2.sql) follows the unchanged B1 draft only in disposable PostgreSQL. It adds a private account lease and service-only claim, commit and failure RPCs. Account and event rows are locked in the same order; an attempt must still own both unexpired leases when committing subscription state and event completion in one transaction. Different events for replacement subscriptions share that account lease. A stale worker cannot update subscriptions or release a newer worker's lease. Terminal history is preserved; a missing provider result is never interpreted as cancellation.

The account's new coordination columns are private. Authenticated callers retain only explicit SELECT of the original B1 account columns under the existing owner RLS policy. They cannot SELECT the account's lease or private event data, execute processing RPCs, or mutate billing state.

[reconcile.ts](src/lib/billing/reconcile.ts) claims before fetching current provider state and accepts only complete, owner/account/mode-matching snapshots. It returns retry for unknown mappings, failed reads, busy leases, invalid states or unsuccessful commits. An event row's existence is not successful processing. No raw payloads, provider exceptions or credentials are persisted.

[webhook.ts](src/lib/billing/webhook.ts) is an **unmounted server library**. There is no `/api/platform/billing/webhook`, checkout, portal, billing UI, signup hook or background consumer. Setting environment variables alone cannot activate it. Its prepared handler verifies the exact raw payload with HMAC-SHA256, constant-time v1 comparison and a five-minute signature tolerance. It verifies each key's actual current account with `/v1/account`, requires the SaaS and EPS account IDs to differ, and retrieves the event using the SaaS account key before any database claim. Connect/organization deliveries and wrong mode fail. Supported `customer.subscription.*` events reconcile; unknown subscription event types retry; verified non-subscription events are deliberate no-ops.

[provider.ts](src/lib/billing/provider.ts) performs only GET requests, always to the fixed Stripe API origin with redirects refused, no caching and bounded request timeouts. It pins the documented `2025-03-31.basil` contract, loads every subscription page with `status=all`, and explicitly retrieves required IDs omitted from the list. Periods come from the subscription item, not removed top-level fields. B1 represents one price/period pair, so incomplete or multiple-item subscriptions remain reviewable retries. This does not choose or create a price. Provider errors are reduced to generic responses, without logging raw exceptions or headers.

Future reviewed configuration requires `PLATFORM_BILLING_RECONCILIATION_ENABLED=true`, `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET`, `PLATFORM_STRIPE_ACCOUNT_ID`, `PLATFORM_STRIPE_MODE=test|live`, `MERCHANT_STRIPE_ACCOUNT_ID`, and the existing merchant key solely to verify its account identity. This list is a contract, not an instruction to set them now. Key prefixes are input validation; actual account and event reads establish scope. No credentials or provider configuration were provisioned by this lane.

The transport guard executes the actual signature verifier, adapter and core using synthetic provider responses and an injected store. The reconciliation guard applies real B1+B2 SQL to disposable PostgreSQL, interleaves held provider reads with competing claims, and checks rollback/fencing/ACL. PGlite executes PostgreSQL semantics in one backend; interleaved calls do not prove independent backend lock waits. Neither guard is a live provider, Supabase Auth, PostgREST or production test.

## Remaining B3 activation plan

Before exposing any billing route: apply the exact approved schema through S106; verify the separate Stripe account and pinned endpoint version in test mode; run real concurrent backend and provider replay tests; and add trusted owner-only customer mapping creation. Checkout needs a server-owned allowlist for an explicitly approved paid offer, durable idempotent coordination that prevents concurrent duplicate customers/checkouts/subscriptions, and fixed server-owned return URLs. Portal sessions must use the authenticated owner's stored customer, never a submitted customer ID. Test renewal, cancellation, failed payment, retries and return-page interruption with no effects on merchant money recording. Free early access continues until that separate activation decision. No charging, trial timer, restrictions or automatic conversion are introduced here.

## Commercial decisions still open

Self-service access is the intended product direction. It does not choose prices, payment cadence, card-up-front versus trial-first, trial length, grace periods, seats, feature policy or treatment of existing businesses. Do not infer those from the old draft website or hard-code them while they are undecided. No platform provider environment variable, price, account, subscription, trial or backfill is created by this lane.

Any later restrictions need an explicit product decision and a single server-owned resolver. Customer payment recording, business records and export access must remain protected. B1 introduces no enforcement and changes no missing-row behavior.

## Local verification and its limits

`npm run verify:platform-billing-foundation` first checks that B1 remains outside the migration path and no existing runtime path imports or queries the dormant billing library. With the already available optional PGlite dependency, it rebuilds a disposable PostgreSQL database from the platform prelude and all current migrations, then applies the exact B1 draft unchanged. B2's separate guard applies B1 then B2 and checks the additive processing contract.

The guard checks unchanged existing catalogue definitions, exact new columns/defaults/types/nullability, composite keys, RLS and ACL, update triggers and indexes. It tests owner A/B, a crew UUID with an intentionally bad server fixture, anonymous callers, service writes, refused browser mutations, provider account/mode mappings, nonterminal conflicts, terminal history, invalid dates/statuses/identifiers, event privacy and retryable unfinished leases. New business creation must produce zero billing rows.

PGlite's platform-only `pg_net` and `pg_stat_statements` substitutions are printed, using the existing repository helper. This is PostgreSQL semantics with synthetic identities, not a Supabase Auth token, PostgREST, provider or production test. If optional PGlite is absent, the guard explicitly reports that behavioral proof was skipped; an approval packet must contain a completed PostgreSQL run. No dependencies are installed by the guard.

## S106 application plan — not authorization to apply

1. Re-fetch and re-measure exact origin/main, review the isolated candidate and the final three-table contract, and confirm no competing schema lane. Keep one main landing at a time.
2. Review current production catalogue read-only: the three names must be absent; the owner UUID uniqueness, auth FK model, UUID extension, canonical trigger, service role and current grants must match this contract. Capture the normal pre-change schema/row-count evidence through the approved S106 process. B1 preparation must not rewrite production fingerprint or ledger artifacts.
3. Use the Supabase CLI's migration generator to reserve the real migration version. Move the reviewed SQL from drafts into that version only after exact schema approval; do not keep two replay copies. Update the guard's apply-path check for the approved applied state, preserving all behavioral assertions. Re-run the focused PostgreSQL proof against the final file.
4. Apply the exact reviewed transaction under S106's schema-first plan. It contains DDL only and creates three empty tables. There is no signup trigger, seed or backfill. Abort on unexpected existing objects instead of masking drift with IF NOT EXISTS.
5. Read back columns, keys, checks, indexes, ACL, RLS policies, triggers and zero new billing rows. Confirm the pre-existing schema and business-row evidence are unchanged. Only after real readback update the normal migration ledger/fingerprint through its canonical tooling and land the matching code/docs.
6. Commercial activation remains a separate reviewed lane. Do not set PLATFORM_STRIPE variables, deploy a provider route or charge a business as part of B1.

If application fails, the SQL transaction rolls back. After a successful application, leaving inert empty tables is safe while investigating. Any rollback drop requires a separate S106 plan and verified emptiness; never drop a populated billing table or delete users automatically.

Documentation consulted: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Data API grants](https://supabase.com/docs/guides/api/securing-your-api). The separate-account rule comes from the repository's merchant reconciliation behavior, not from a provider guarantee.

B2 references: [Stripe signature verification and event delivery](https://docs.stripe.com/webhooks), [Stripe's current-account implementation](https://github.com/stripe/stripe-node/blob/master/src/resources/Accounts.ts), [all-status subscription pagination](https://docs.stripe.com/api/subscriptions/list), [Basil item-level period change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
