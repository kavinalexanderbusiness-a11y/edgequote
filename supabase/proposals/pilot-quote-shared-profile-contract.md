# Dormant quote shared lock and fixed email profiles

These proposals isolate Quote Save/identity/acceptance from optional email storage. They are not migrations or production activation. They add no receipt ledger, retention rule, business-row seed, billing feature or logout behavior.

## Installation boundary

After the reviewed native baseline/migrations, choose exactly one explicit profile:

- Email absent: `pilot-quote-shared-profile.sql` → `pilot-quote-email-absent.sql` → `pilot-quote-identity.sql` → `pilot-quote-save.sql`.
- Email present: `pilot-quote-shared-profile.sql` → unchanged `pilot-email-core.sql` → `pilot-quote-email-present.sql` → `pilot-quote-identity.sql` → `pilot-quote-save.sql`.

The versioned acceptance companion may follow Save only when separately approved. Installing the present profile does not approve the email core's retention/deletion restrictions. Billing B1/B2 and merchant C1 are not predecessors.

The private expected-profile declaration is installed in source, not inferred from existing tables or supplied by a caller/GUC. The catalogue digest is pinned from a disposable reference built from reviewed source, not accepted from the target being checked. Missing, partial, unexpected or altered footprint refuses. Absent mode may return empty retained arrays only after verifying the declared absent footprint; an undefined-table error is never converted to emptiness.

Installation and any profile change require a separately reviewed, quiescent migration with participating writers drained. **Live profile switching is unsupported.** Catalogue checks cannot lock nonexistent objects or prevent arbitrary privileged DDL after a check. No new global migration fence is introduced: existing email entry points sometimes read relations before taking their owner lock, and native archive triggers already hold customer locks. Adding an earlier fence only inside those helpers would create an unsafe lock order.

## Preserved behavior

The private neutral owner lock uses exactly `pg_advisory_xact_lock(hashtextextended('pilot-email:' || owner::text, 0))`. Despite the historical string, it is the shared numeric transaction lock for this integration. Renaming it or choosing another hash would split mutual exclusion. The present profile welds the original email helper to that neutral primitive; all other email-core source stays unchanged.

Identity and Save acquire it where the original email owner lock was acquired. Acceptance continues through `_pilot_quote_save_lock`. Existing row-lock order stays owner advisory → auth → customers → properties → quote/children → templates → settings → acceptances → measurements. Identity's existing narrower standalone row-lock sequence remains unchanged. The VOLATILE writer/lock boundary performs a fresh profile check after any advisory wait; a pre-wait stable snapshot is not a post-wait certificate.

Save's editor/target/retained projections stay STABLE one-statement reads. The standalone identity snapshot retains its baseline VOLATILE behavior; it does not acquire a new single-snapshot guarantee here. The profile-aware retained helper uses fixed fully qualified dynamic SQL with bound values, retaining complete ordered workflow/attempt rows in present mode. Any retained workflow state still prevents customer reassignment. Save compares the same before/after retained data. In absent mode there are no email FKs or triggers to change native quote deletion/Undo. Existing quote parent-row Undo does not restore cascaded child data, and this change does not expand that promise.

Catalogue verification includes object identity/kind/owner, column definitions and permissions, relation permissions/RLS, policies, constraints and enforcement flags, index validity, user/archive trigger enablement, internal FK triggers on both sides, rewrite rules, inheritance/partition edges touching email relations, and email function definitions/security/configuration/permissions. Internal generated trigger names/OIDs are normalized by constraint/relation/function/event identity; enforcement state is preserved. Runtime failure uses the existing native-error unavailable/unknown boundary; it does not manufacture a successful Save receipt.

## Evidence boundary

The focused profile proof uses the existing marked disposable PostgreSQL17 service and explicitly synthetic platform prelude. It verifies native SQL/profile/locking, not real Auth, PostgREST, browser Undo or a production rollout. Sequential PGlite reference work cannot prove competing-backend contention. Preserve failed attempts and exact source/test hashes, and independently review final source and proof before any landing recommendation.

Reference: PostgreSQL documents transaction-level advisory locks in [Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html) and the snapshot distinction between STABLE and VOLATILE functions in [Function Volatility](https://www.postgresql.org/docs/17/xfunc-volatility.html). These semantics inform the post-wait checks; tests must verify this repository's actual callers.
