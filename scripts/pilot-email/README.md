# Dormant client-owned email core

This is source preparation, not an enabled CRM feature. No application route
mounts the request handlers, no scheduler calls the worker, and no credential
resolver is installed. No environment variable activates this code. The SQL is
in `supabase/proposals`, outside migration replay. Do not apply it to production.

The new path reuses the native reach and governor checks. Its PostgreSQL start
is stricter: it locks and rechecks the current quote, consent, approved client
connection and daily capacity before authorizing one provider attempt. Confirmed
provider acceptance is finalized atomically into native Messages and notification history.
No failure falls back to the founder's shared sender or legacy fail-open send
reservation. The default CRM dispatch and founder capability denial are unchanged.

The provider adapter sends the exact database-frozen JSON bytes and key. An
unknown outcome retries only that message within a conservative 23-hour window;
a known confirmation reconciles locally even after pause or disconnection. The
worker returns finalized only when both native receipts exist. It does not claim
that an in-flight external request can be canceled by a later reply.

The webhook handler verifies the exact raw bytes using the selected client's
secret. A routed email first holds all versions of that owner's customer/quote
workflow, then retrieves bounded content from the same provider account. Sender,
received-ID and reply route must match. Uncertain or HTML-only content remains
held for review; remote images, attachments and raw download URLs are never
fetched. Only an exact single-word unsubscribe can change that customer's email
consent. Reply prose cannot accept a quote, restore consent or issue another send.

The owner handler obtains an authenticated user from trusted server auth, checks
the connection owner, and records an explicit quote-version approval. Approval
does not send. Repeating approval cannot resume a held workflow or reset its
message budget. Safe replies contain no secrets, private account references,
recipient snapshots or raw SQL/provider errors.

## Disposable proof

The PR-only workflow starts a marked, empty `postgres:17` service and replays the
actual platform test prelude, baseline, all migrations and proposal. The fixture
driver accepts only fixed loopback `pilot_test`, a matching marker, and major
version 17. It accepts no database URL or inherited credential configuration.
The prelude substitutes Supabase auth/storage/network facilities; those are
explicit fixture boundaries, not real JWT, storage or network verification.

Native triggers, RLS policies, constraints and realtime publication definitions
remain enabled. Separate psql backends and observed database lock waits prove
the recorded races. Runtime cases execute actual application modules and SQL;
only the Supabase REST transport shape, auth identity and external Resend HTTP
are fixtures. This does not prove a deployed route, a real provider account or
an owner-facing inbox UI. Full project checks run in the existing cloud CI;
do not install or run a full local build on the constrained owner machine.

## Production release gates still open

- Explicit reviewed operational approval for DDL, including the new parent
  indexes and RESTRICT retention/deletion effects. No backfill is proposed.
- Approved client-owned sender/receiving identity and secure secret-reference
  resolver, real setup verification and named test recipients; no founder grant.
- Actual scheduler recovery and owner review/status UI, with correct native
  email wording and a separately approved email reply action.
- Acknowledgement that existing SMS/portal writers and legacy senders do not
  participate in the pilot's advisory-lock protocol. Their already-committed
  records are checked; global all-channel cancellation/cap serialization is not
  provided by this source.
- Independent passing PostgreSQL17, runtime and full CI evidence for the exact
  final source, followed by the sole S106 release process if a release is approved.

All existing cron, real sends, billing/merchant lanes and new spending remain
inactive or held. No trial, provider webhook, customer or subscription is created.
