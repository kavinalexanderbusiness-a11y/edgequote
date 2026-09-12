# Owner phone reminders — release report

Decision: **MERGE** for the bounded owner-only reminder slice.

## Shipped behavior

- Produces one tenant-local workday-prep digest and one end-of-day digest for owners who have an active push subscription and enable the relevant preferences.
- Uses the tenant IANA timezone, work start time and daily capacity. With the current Edge Property Services defaults (America/Edmonton, 08:00 start, eight-hour capacity), the targets are 07:00 and 17:00 local time, with a three-hour catch-up window after a missed hourly sweep.
- Morning copy reports today's job count, truthful recorded arrival windows, missing arrival times, active equipment assigned to scheduled crews and whether visit notes exist.
- End-of-day copy reports unfinished work, tomorrow's plan/equipment, completed chargeable jobs that need invoices, drafts, outstanding invoice balances and overdue totals.
- Uses the canonical invoice ledger calculation, including GST, discounts and payments.
- Keeps customer names, addresses, phone numbers and raw job-note text off the lock screen.
- Uses deterministic owner/date/slot notification IDs, so overlapping sweeps converge on one stored notification.
- Honors the daily master switch plus workday-prep, invoice-follow-up, overdue-balance and end-of-day switches.

## Scheduling and activation

The unapplied migration schedules the producer hourly through Supabase Cron. It reads only `edgehq_app_url` and `edgehq_cron_secret` from Supabase Vault and makes no request while either value is absent.

S106 remains the sole activation controller. Activation sequence:

1. Deploy the app route.
2. Apply the migration.
3. Store the deployed origin in Vault as `edgehq_app_url`.
4. Store the same secret in Vercel `CRON_SECRET` and Vault `edgehq_cron_secret`.
5. Confirm VAPID/push configuration and an active owner subscription.
6. Run one authorized subscribed-device delivery check.

No production DDL, app deployment, provider activation, customer communication, payment action or business-record mutation was performed in this lane.

## Known boundary

The current data model has no explicit job-to-material assignment. Reminders therefore state only that visit notes exist and name active equipment assigned to the scheduled crew; they do not invent a material list.

This slice targets tenant owners. Role/crew recipients, service routing, per-user preferences, editable templates, configurable quiet hours, lifecycle escalation, durable delivery logs, localization/currency and crew PWA controls remain later universal-platform work. Monitor the 15-second scheduler request timeout and the fail-closed 1,000-subscription ceiling during rollout.

## Verification

- Owner reminder contract: 41/41
- Fresh database rebuild: 24/24
- Existing cron contract: 197/197
- Tenant time, communication preferences, settings save, owner inbox and tenant boundary checks: passed
- TypeScript and scoped lint: passed
- Production build: passed with pre-existing warnings
- Independent final reviews: MERGE / MERGE
