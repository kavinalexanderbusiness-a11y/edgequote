# Automatic lawn estimator release

This runbook covers the EdgeHQ-backed automatic lawn-measurement, written-quote,
acceptance, deposit, and scheduling release. It supplements
[`DEPLOY_CHECKLIST.md`](../DEPLOY_CHECKLIST.md). Do not publish the marketing site
until the EdgeHQ production checks in this file pass.

## Release boundary

The release contains six database migrations, the EdgeHQ application changes,
the private historical-photo backfill, and the marketing-site estimator.

```text
20260914021500_public_intake_hardening.sql
20260914021600_booking_upload_policy_hardening.sql
20260921235500_portal_request_mute_exception.sql
20260922200202_secure_public_quote_scheduling.sql
20260922210000_auto_mowing_quote_rules.sql
20260922220000_private_customer_uploads.sql
```

Customer photos uploaded after the release belong in the private
`customer-uploads` bucket. The public `booking-uploads` bucket remains only as a
temporary source for historical records until the separately reviewed backfill
and cleanup are complete.

## Stop conditions

Stop the release before changing production when any of the following is true:

- Kavin has not approved the final local preview.
- The target Vercel project, domain, Git revision, Supabase project, or database
  connection cannot be identified unambiguously.
- Any required environment variable is missing or points at a different tenant.
- The migration rebuild, estimator tests, booking tests, or diff check fails.
- A production schema check reports drift that is not represented in the repo.
- The dry-run photo report contains unsupported or unowned records that would be
  required for the release.

## 1. Record the release inputs

Record the EdgeHQ and marketing Git commit IDs, current production deployment
IDs, the Supabase project reference, and the current custom-domain assignments.
Do not print service-role keys, database URLs, Stripe secrets, or customer data.

Confirm `business_settings.base_address` is the real public mailing address used
in commercial email. Promotional email deliberately fails closed when it is
missing. Confirm the published privacy, cookie, terms, and cancellation pages
still match the enabled providers.

## 2. Local preflight

Use the repository's installed runtime rather than modifying lockfiles.

```bash
git diff --check
./node_modules/.bin/tsx scripts/verify-booking-photos.ts
./node_modules/.bin/tsx scripts/verify-lead-intake.ts
./node_modules/.bin/tsx scripts/verify-public-quote-scheduling.ts
./node_modules/.bin/tsx scripts/verify-public-quote-scheduling-runtime.ts
./node_modules/.bin/tsx scripts/verify-auto-mowing-quotes.ts
./node_modules/.bin/tsx scripts/verify-portal-requests.ts
./node_modules/.bin/tsx scripts/verify-comm-prefs.ts
./node_modules/.bin/tsx scripts/verify-customer-photo-backfill.ts
./node_modules/.bin/tsx scripts/verify-migrations.ts
./node_modules/.bin/tsx scripts/verify-rebuild.ts --release-preflight
```

The release-preflight mode proves that every migration applies to an empty
database and checks the estimator release's required tables, RLS, functions,
role grants, private bucket, and locked historical upload bucket. Before the
release is applied, the normal `verify-rebuild.ts` comparison is expected to
report the pending objects as differences from the current production contract.
After production is migrated and the contract is recaptured, run the normal
`verify-rebuild.ts` and require a clean result for disaster-recovery parity.

Run the marketing repository's `pnpm test`, syntax checks, and
`git diff --check`. Verify the estimator at narrow mobile and desktop widths,
including address correction, an ineligible route, a manual-review result, and
an eligible instant-written-quote result.

## 3. EdgeHQ and database cutover

This release uses an expand/switch/contract sequence. Do not deploy the complete
estimator application before its schema, and do not apply the booking-storage
hardening before a compatibility application owns every public photo write.

1. Apply only `20260914021500_public_intake_hardening.sql` with
   `ON_ERROR_STOP` enabled. It is additive and supplies the durable rate limiter
   required by the compatibility routes; the currently deployed application does
   not depend on it.
2. Deploy a reviewed compatibility revision based on the currently deployed
   application. It must contain the shared bucket-catalog decision in
   `customerUploadPhotos.ts`, the booking and portal server upload routes, the
   booking client's old/new response handling, inline website-photo compatibility,
   authenticated private-photo reads, and readers for both legacy and private
   references. Do not include estimator or scheduling code which depends on the
   remaining migrations. Record the immutable deployment URL and wait until no
   previous application instance is serving traffic.
3. While only `booking-uploads` exists, verify booking, portal-request, and inline
   website photos through the compatibility revision. Each must store a supported
   legacy reference; a bucket-catalog error must return 503 rather than write.
4. Apply the remaining migrations with `ON_ERROR_STOP` in exactly this order:

   ```text
   20260914021600_booking_upload_policy_hardening.sql
   20260921235500_portal_request_mute_exception.sql
   20260922200202_secure_public_quote_scheduling.sql
   20260922210000_auto_mowing_quote_rules.sql
   20260922220000_private_customer_uploads.sql
   ```

   The final migration creates the private bucket, removes the remaining browser
   INSERT policies from `booking-uploads`, and changes that historical bucket's
   MIME allowlist so stale service code cannot add another image. Existing public
   objects remain readable for the backfill.
5. Without changing the application deployment, repeat all three upload checks.
   They must now store `customer-upload:` references, use signed previews/reads,
   and leave `booking-uploads` unchanged. Verify direct anonymous and authenticated
   image writes to both buckets fail.
6. Deploy the complete reviewed EdgeHQ estimator revision. Verify `/api/health`,
   sign-in, the dashboard, authenticated signed photo reads, automatic quote
   creation, and accepted-quote scheduling. Verify public API responses do not
   contain customer, lead, quote, or job identifiers.

If any compatibility check fails, stop before the next phase. Roll back the
application alias while the private migration is still unapplied; after the final
migration, keep the additive schema and prepare a forward fix rather than restoring
an application which writes customer images to the public bucket.

## 4. Historical customer-photo migration

The backfill is dry-run by default and writes reports outside the repository with
mode `0600`.

```bash
npm run backfill:customer-photos
npm run backfill:customer-photos -- --apply
npm run backfill:customer-photos
```

Review the first report before applying. The apply run verifies source and target
size plus SHA-256, writes a restricted before-value backup, and uses exact
compare-and-swap rewrites. The final dry run must show zero supported legacy
references. Investigate every blocked record; do not coerce arbitrary URLs or
unowned paths into the private bucket.

Do not delete old source objects in the release window. Cleanup is a later,
separate operation after the final residual-reference scan and backup review:

```bash
npm run backfill:customer-photos -- --apply --cleanup-sources
```

## 5. Marketing-site publish

Publish the reviewed marketing revision only after sections 3 and 4 pass. Verify
the custom domain, favicon, legal pages, contact destinations, estimator API
origin, and production Content Security Policy. Then perform one synthetic flow
for each outcome without using real customer data:

- address not found or corrected;
- route ineligible;
- measurement needs customer correction or owner review;
- eligible measurement produces the approved written price;
- acceptance requests a deposit only when the quote requires one;
- scheduling offers only an actually open, owner-approved slot;
- blocked, cancelled, full, or stale slots are rejected when submitted;
- recurring acceptance creates only the first scheduled visit and leaves later
  recurrence setup to the owner workflow.

Remove the synthetic lead, quote, invoice, and job records after verification.
Keep the immutable deployment URL, test timestamps, and sanitized results in the
release record.

## Rollback

- **Marketing failure:** restore the previous marketing deployment/domain alias.
  The unpublished or rolled-back estimator cannot create new intake.
- **EdgeHQ application failure:** restore the previous EdgeHQ deployment. Keep the
  additive database objects in place unless a reviewed forward migration is
  prepared; do not hand-edit production or replay archived SQL.
- **Photo backfill failure:** stop immediately. Do not run source cleanup. Use the
  restricted before-value backup and apply ledger to prepare a reviewed restore;
  do not overwrite rows that changed after the backup.
- **Migration failure:** stop the marketing publish. Capture the failing statement
  and current schema state, then repair with a new forward migration. Do not edit
  a migration that production already recorded.

The release is complete only after the custom-domain production flow passes and
the stored quote, acceptance, deposit state, first job, customer confirmation,
and private photo references match the submitted scenario.
