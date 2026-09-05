# Merchant connections C1 — offline identity foundation

Status: **UNAPPLIED, INACTIVE. New-tenant payments and messaging: FIX FIRST.**

Audited against origin/main `b353612252ffac012ab1ea447ea961e0662f5be3` on September 5, 2026. C1 creates no provider account, checkout, charge, message, capability grant or production record. It does not make Connect ready to activate. Free early access does not imply an application fee or a paid EdgeHQ offer.

## Current boundary

`src/lib/capabilities.ts` deliberately restricts the deployment's single merchant Stripe account, Twilio number and Resend sender to the founding business. Missing or failed capability reads deny access. Preserve that legacy EPS boundary. A new independent business must never receive those shared grants or settle its customers' money into EPS's account.

Platform subscription billing is separate (`src/lib/billing`, `PLATFORM-BILLING-ADR.md`). Merchant connections concern customer → service-business money. These tables and helpers do not import billing, look up subscriptions, impose entitlements or reinterpret existing merchant records.

## Complete current Stripe scope inventory

Every current Stripe HTTP request is in `src/lib/stripe/config.ts`. None sends a `Stripe-Account` header. Adding an onboarding button alone would leave these paths bound to EPS:

| Path | Current source and required account boundary |
|---|---|
| Invoice Checkout | `api/payments/checkout`, `api/portal/pay`, `createInvoiceCheckoutSession`: server invoice/balance must select the merchant and account-scoped Customer before creating Checkout. |
| Quote deposit Checkout | `api/portal/quote-deposit`, `createQuoteDepositCheckoutSession`: retain current-version acceptance and deposit calculations; bind the created session to the merchant and local quote. |
| Customer and saved-card setup | `lib/payments/cards`, owner/portal `setup-card`, `createStripeCustomer`, `createSetupCheckoutSession`: current `customers.stripe_customer_id` has no account/mode scope. |
| Card capture, refresh and removal | `fetchSetupIntentCard`, `fetchPaymentIntentCard`, `saveCardForCustomer`, `detachPaymentMethod`, owner/portal `remove-card`: card reads, saved mappings, old-card retirement and account-updater events all require the original account. `portal_remove_card` currently returns only IDs after deletion; it must retain trusted scope for detach/retry. |
| Saved-card charge | `attemptAutoPayCharge`, called by owner `api/payments/autopay`, `api/cron/autopay`, and `api/crew/complete`: scope both Customer and payment method before charging. Preserve consent, owner/manual distinction, ledger balance, anomaly holds and idempotency. Portal AutoPay preference changes must use the same connection permission. |
| Reconciliation | `api/payments/reconcile`, `reconcileStripe`, `listSucceededPaymentIntents`: the existing account-wide read would expose another merchant's payments if shared grants were expanded. Every page of a future read must use the chosen merchant account. |
| Payment recording and receipts | `api/stripe/webhook`: invoice/quote Checkout and AutoPay writes derive `user_id` from metadata. Connected merchants can control their own Stripe objects, so provider signature alone cannot make metadata authoritative across tenants. |
| Refunds/disputes | Same webhook: refund cash/credit legs and dispute notifications locate the original payment by PaymentIntent ID only. Scope original payment lookup, dedupe and resulting writes by account/mode. There is currently no Stripe refunds-creation HTTP path; the handler records provider refunds. |
| Availability | `api/payments/status`, `api/integrations/status`, capability hook/consumers: configuration/grant booleans are not connected-account readiness. Runtime integration must distinguish missing, restricted, disconnected and unknown. |

The current webhook discards top-level `account` and `livemode` at its event cast. Existing customer IDs, payment-method uniqueness, session dedupe and ledger PaymentIntent lookups also lack that scope. C1 leaves them unchanged until a complete reviewed migration is prepared. It must not attach Connect deliveries to that legacy endpoint.

Direct charges place transaction objects on the connected account; reads and writes use that account's `Stripe-Account` header. This is the proposed collection direction for independent service businesses, subject to a deliberate account/controller decision. No destination charges, transfers or application fees are introduced. [Stripe direct charges](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted).

Connect events include top-level account identity, and a production Connect webhook can receive both test and live events. The new handler must verify its separate endpoint signature, match actual configured platform identity, account and mode, then resolve a previously stored object binding. Metadata is only a consistency check. [Stripe Connect webhooks](https://docs.stripe.com/connect/webhooks).

## C1 storage and resolver contract

`supabase/drafts/merchant-connections-c1.sql` is outside the applied migration path. Its single transaction adds exactly two private tables:

- `merchant_connections`: owner UUID anchored to existing `business_settings.user_id`, distinct platform and merchant account IDs, explicit mode, disconnection time, timestamps. Account/mode has one permanent owner; at most one current connection per owner/platform/mode. Disconnection permits a replacement while retaining old identity.
- `merchant_provider_objects`: exact connection/owner/platform/account/mode composite FK, provider object type/ID and exactly one local customer, invoice or quote target. Existing `(user_id,id)` keys provide same-owner FKs. Customer/card/setup objects target customers; Checkout can target a customer for setup or an invoice/quote for collection; PaymentIntent/Charge targets an invoice/quote. Account/mode/type/ID is unique.

Both tables enable RLS and explicitly revoke inherited privileges. PUBLIC, anonymous and authenticated roles receive no access or policies. Service role receives SELECT/INSERT on both and column-level UPDATE of `merchant_connections.disconnected_at` only. The existing timestamp trigger owns `updated_at`. No service delete, identity update or target rewrite is granted. No function, RPC, provider payload, credential, card detail, amount, plan or enabled flag is added.

`src/lib/merchantConnections/resolve.ts` supplies only pure helpers with an injected read interface. There is no Supabase adapter or runtime consumer. Owner resolution requires a current business owner and one current matching identity. Event resolution requires a current business owner and known object binding, including historical disconnected connections. All returned/thrown read failures and ambiguous/mismatched rows fail closed. Results explicitly project safe identifiers and never declare payment readiness.

The future caller must authenticate the owner before supplying `ownerId`; a matching input UUID is not authentication. Event callers must verify the raw signature and actual platform/account/mode first. C1 is not a signature verifier, payment authorization engine or proof of provider ownership. The resolver deliberately accepts no metadata-based tenant override and no optional legacy-account fallback.

RESTRICT FKs and immutable service history intentionally prevent deletion of a referenced business/customer/invoice/quote or mapping once populated. Before activation, review retention, account closure and existing document-deletion flows under an explicit correction/offboarding plan. C1 changes none of those flows now and applies no schema. Superuser repair is outside the ordinary service contract.

## Remaining activation sequence

1. Review actual provider account identities and choose Connect controller/dashboard type, country/capability policy, fee/loss responsibility and ownership model. Do not reuse EPS credentials/account or assume environment-variable names prove separation. Hosted onboarding's dashboard type is immutable; its return URL also means “saved for later,” not “ready.” Account Links must be issued only to authenticated owners, refreshed server-side, and never emailed/texted. [Stripe hosted onboarding](https://docs.stripe.com/connect/hosted-onboarding).
2. S106 reviews the exact new-table DDL, baseline keys/roles and deletion implications, reserves a migration, applies schema first, and verifies zero unintended business-row mutations. Do not apply this draft directly or create a second replay copy. There is no seed, historical backfill or signup trigger.
3. Implement and test a server-owned adapter and mandatory account-aware transport for **every path above**, new scoped Customer/card mappings, original-scope detach/retry, and a separate Connect webhook with durable object bindings. Persist local intent before returning a Checkout URL; handle creation/webhook races without trusting metadata as ownership. Record unknown/unmapped relevant events as retryable/recoverable failures; do not acknowledge unrecorded money as completed.
4. Add verified provider account status, safe sanitized owner status, restricted/disconnected behavior and account-update/deauthorization handling. New-charge permission may be denied while historical payment/refund recording remains available. A configured key, C1 identity or onboarding redirect never enables collection by itself.
5. Prove real provider **test-mode** invoice/deposit payments, consented setup/card replacement/removal, automatic/manual charge, refunds, disputes, pagination/reconciliation, duplicate/out-of-order events, failed reads/writes and mixed account/mode attacks. Then review a tenant-specific activation plan. No production business-row smoke writes are authorized here.

## Messaging audit and future boundary

`lib/comms/send.ts` sends with global Twilio SID/token/From and Resend key/From. `dispatchToCustomer` and the manual send routes enforce the legacy tenant grant, consent and governor. Keep those protections. System signup/recovery/crew invitations and owner notifications also call `sendEmail` directly: moving tenant customer mail must not accidentally reroute or disable those platform messages.

Inbound SMS (`api/sms/inbound`) verifies one global token and resolves by sender phone only within the granted EPS tenant set. Multi-tenant SMS must first resolve a registered recipient number/Messaging Service and account, verify the corresponding private token against the exact public URL/all parameters, and only then search that owner's customer phone. STOP/START must stay within that connection and tenant. Twilio subaccounts isolate resources but share the parent balance, so platform-managed subaccounts versus independently owned provider accounts is a separate operational/cost decision. [Twilio subaccounts](https://www.twilio.com/docs/iam/api/subaccounts), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

Delivery callbacks (`api/sms/status`, `api/email/status`, `lib/comms/delivery`) currently update by provider/message ID only. The MMS proxy (`api/messages/media`) authenticates with the global Twilio credentials. Both need original connection/account ownership. Preserve consent/governor rules, message history and delivery progression when connecting a new sender.

`useBusinessData.ts` selects `business_settings.*` in the browser. Never add provider keys, auth tokens or webhook secrets there. A future messaging lane needs a private server credential store/reference, owner-authenticated setup, verified tenant-owned sender, safe status projection, rotation/revocation and scoped callbacks/media. C1 stores no secrets and makes no secret-store choice. Resend supports send-only keys, which can limit a sender's authority; provider validation requiring wider access must not silently expand those permissions. [Resend key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key).

## Verification boundary

Run `tsx scripts/verify-merchant-connections.ts`. It checks the actual resolver with synthetic reads, then replays the exact current migrations plus C1 in disposable PostgreSQL using the existing optional PGlite helper. It exercises schema/row preservation, owner/crew and cross-tenant FKs, account/mode identity, append-only ACL, canonical timestamp updates, retained disconnected history, deletion restrictions and actual SQL reader → resolver integration. Optional dependency absence is reported as skipped, never claimed as PostgreSQL proof. No dependency is installed, no live client/provider is imported and no production request is made.

This is a source/schema contract, not a Connect test-mode run, authenticated Supabase browser test, production migration or launch approval.

The guard prints its existing `pg_net`/`pg_stat_statements` platform substitutions. For the narrow deletion-retention checks, PGlite rejects the baseline's generated-column replica identity before reaching the FK. Each such test temporarily drops only the disposable `supabase_realtime` publication inside a transaction, proves the exact RESTRICT violation, then rolls back and verifies the publication is restored. No table, FK or trigger is weakened, and this is not a production replication test.
