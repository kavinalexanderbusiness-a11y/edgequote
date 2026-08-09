# EdgeQuote — Deploy Checklist

Single source of truth for deploying the **operational platform** (CRM, quotes,
scheduling, invoices, payments + AutoPay, comms, website import, portal) from scratch
or to production. Verified 2026-06-25: no deployment blockers; `schema.sql` builds a
fresh database completely; `tsc` + `next build` pass.

> **Scope note:** `supabase/RUN-2026-06-25f-grow-marketing-studio.sql` and
> `RUN-2026-06-25g-service-pricing-display.sql` belong to the separate **EdgeQuote
> Grow** track and are **not** part of this operational freeze — apply them per that
> track, not this checklist.

---

# Before Deploy

## SQL migrations

**Each migration is listed once.** Pick the path that matches your target database.

### Fresh database / disaster recovery — schema.sql **then every later RUN file**

> ⚠️ **This section used to say "run ONE file — nothing else is required."** That was
> true when it was written (2026-06-25) and has been wrong since 2026-06-27. As of
> **2026-07-21 there are 89 `RUN-*.sql` files** (was 27 at the 2026-07-15 revision
> of this note — the count rots fast; trust `ls supabase/RUN-*.sql`, not this
> sentence). Running `schema.sql` alone rebuilds a database weeks behind
> production. It does not error — it just quietly produces a schema the app fails
> against. Two further cautions from the migration audit: production's schema is
> NOT a subset of main (unmerged branches have been applied by hand — the live
> catalog is the only authority), and several functions (`get_portal_data`,
> `submit_website_lead`) are `create or replace`d by MULTIPLE files — only the
> newest in each chain may ever run, or the portal silently rolls backward.

```
# 1. the snapshot (complete as of 2026-06-25)
supabase/schema.sql

# 2. THEN every RUN file dated after it, in filename (date) order — they are idempotent
ls supabase/RUN-*.sql | sort        # apply each in this order

# 3. THEN the canonical objects — LAST, and not optional
ls supabase/CANONICAL-*.sql | sort  # currently: get_portal_data
```

**Why step 3 exists.** Some objects were `create or replace`d by many migrations at
once. `get_portal_data` was the worst: nine `RUN-*.sql` files plus eleven copies
inside `schema.sql`, each one a complete runnable body — so applying an older file
silently replaced the live function with an earlier version and the customer portal
started returning less (no `services`, no `properties`). It never errored. Those are
now all tombstones, and the single body lives in `supabase/CANONICAL-get_portal_data.sql`.

Running it **last** is what makes the order safe: whatever the dated files did on the
way past, the canonical body wins. **Skip step 3 and `get_portal_data` will not exist
at all** — the portal RPC 404s and every customer portal page comes back empty.

> ### ⛔ Run `npm run verify:portal-canonical` BEFORE step 3
>
> "The canonical body wins" is a loaded gun pointed at production when that body is
> **stale**. The file is a snapshot of an object that keeps moving, so it rots by
> default — and because it wins, a stale snapshot does not fail, it silently rolls
> the function backward. No error, no stack trace: just fields missing from a
> customer's screen, or a security predicate gone.
>
> This is not hypothetical. On 2026-08-09 the file had already drifted by one line,
> and that line carried both the draft-invoice privacy predicate (a confirmed data
> exposure, fixed in `06a50db`) and the deposit fields. Applying it as written here
> would have re-opened the exposure.
>
> `npm run verify:portal-canonical` is the check that makes step 3 safe. It fails the
> build if the file has lost a required predicate or field, if a tombstoned migration
> has regained a runnable body, or — with database credentials present — if the live
> function returns anything this file no longer builds. **If it fails, resync the file
> from production before deploying; do not apply it.**

`schema.sql` creates the 7 base tables (`business_settings, service_templates,
travel_fee_tiers, properties, job_recurrences, jobs, invoices`) + RLS policies +
indexes, then every dated migration **through 2026-06-25 only**, including the
`invoices(job_id)` unique index.

**Keep this current.** Supabase's migration history only records what was applied via
MCP `apply_migration` — everything built by pasting into the dashboard (i.e. most of
this schema's history) left no row. So these files are the only record a rebuild can
be driven from. When you add a `RUN-*.sql` it joins this path automatically by date;
but create an object in the dashboard and never write a file, and it exists *only* in
production — disaster recovery silently loses it.

That has already happened three times, all found and transcribed back on 2026-07-15:

| Object | Was only in prod | Now recorded in |
|---|---|---|
| `social_connections`, `publish_jobs` | Marketing Studio publishing | `RUN-2026-07-15-record-marketing-publishing-tables.sql` |
| `branding` storage bucket | business logo (settings upload + every branded email) | `RUN-2026-07-15-record-branding-bucket.sql` |

**Verified 2026-07-15 — production vs. source control:**
all 54 tables, 43 functions, 36 triggers and 4 storage buckets are now creatable from
this repo. (The previous known exception is closed: `automation_signals` is
covered by `supabase/RUN-2026-07-14-automation-signals.sql`, on `main` — a
rebuild from `main` creates it.)

### Existing database — incremental files (already applied this session; listed for the audit trail / a DB that's behind). Apply in this order; each is idempotent:
1. `supabase/RUN-2026-06-25-autopay-website.sql` — AutoPay (2026-06-25c) + Website Import (2026-06-25d)
2. `supabase/RUN-db-catchup-2026-06-25.sql` — booking columns + funnel, `measurements`, `schedule_items`, `search_conversations` (lead badge), `pg_trgm` indexes, **REVOKE EXECUTE … FROM public** on the 11 trigger functions
3. `supabase/RUN-2026-06-25e-website-lead-rate-limit.sql` — `business_settings.website_lead_hourly_limit` + rate-limited `submit_website_lead`
4. `supabase/RUN-2026-06-25f-invoice-job-unique.sql` — **the duplicate-invoice / double-charge guard** (partial unique index on `invoices(job_id)`)

> If you've followed this session, only **#4** may be outstanding — run it before relying on AutoPay.

## Environment variables (Vercel project settings)

**Required (core app):**
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY            # server-only — NEVER prefix NEXT_PUBLIC_
                                     # ALSO gates Crew Mode invites: /api/crew/invite creates the
                                     # employee's auth account through the Admin API. Without it the
                                     # button returns a clear "not configured" and the owner falls back
                                     # to a join code (which only works for an existing login).
                                     # Check with: GET /api/health → checks.config.ok
GOOGLE_MAPS_API_KEY                  # server-side (geocode/distance/route proxies)
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY  # restrict by HTTP referrer
NEXT_PUBLIC_APP_URL                  # e.g. https://app.example.com (builds portal links in server-sent messages)
CRON_SECRET                          # Vercel sends as Bearer; all 12 cron routes validate it
```
**Required for payments + AutoPay + receipts:**
```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET                # from the Stripe webhook endpoint signing secret
```
**Required for SMS/email (reminders, receipts, review requests, AutoPay failure alerts reach the owner regardless via in-app):**
```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM                          # e.g. +15875551234 (needs A2P 10DLC)
RESEND_API_KEY
RESEND_FROM                          # e.g. "Edge Property Services <hello@yourdomain.com>" (verified domain)
```
**Optional (Web Push / PWA badges):**
```
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT                        # mailto: or https: contact
PUSH_SEND_SECRET                     # must equal public.push_config.secret
```
**Optional (outbound integrations):**
```
INTEGRATIONS_DELIVER_SECRET          # [2026-07-21] signs outbound webhook deliveries
                                     # (integrations outbox → /api/integrations/deliver);
                                     # delivery stays inert until set
```
No Stripe **publishable** key is needed (card capture uses hosted Checkout in setup mode).

## Stripe configuration

1. **Add a webhook endpoint:** `https://<app>/api/stripe/webhook`.
2. **Subscribe to exactly these 6 events** (everything the webhook handles):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
3. Copy the endpoint's **signing secret** → `STRIPE_WEBHOOK_SECRET`.

> ⚠ AutoPay refuses to charge unless `STRIPE_WEBHOOK_SECRET` is set — money is never taken with no path to mark the invoice paid.

## Supabase configuration

1. **Run the migration** (above).
2. **Auth → enable "Leaked Password Protection."**
3. **Storage buckets — no manual step.** All four are created by the SQL path above and
   verified against production on 2026-07-15:

   | Bucket | Public | Holds | Created by |
   |---|---|---|---|
   | `job-photos` | yes | portal / job photos | `schema.sql` |
   | `booking-uploads` | yes | booking-funnel photos | `RUN-db-catchup-2026-06-25.sql` |
   | `branding` | yes | business logo (settings upload + branded email header) | `RUN-2026-07-15-record-branding-bucket.sql` |
   | `equipment-docs` | no | equipment paperwork | `RUN-2026-07-15-equipment-docs.sql` |

   > This step used to read *"create `branding` + `job-photos` in the dashboard if
   > absent."* Both are now created by SQL — `job-photos` always was — and creating
   > them by hand is what produced the drift in the first place: `branding` existed
   > only in production for months because it was made in the dashboard and never
   > written down. **Add a bucket in SQL, never in the dashboard**, or disaster
   > recovery loses it.
4. **Realtime:** handled by `schema.sql` (core tables + `payment_methods`, `website_leads`, `schedule_items`, `day_statuses`, `notifications` are on the `supabase_realtime` publication). No manual step.
5. **Web Push (only if using push)** — after generating VAPID keys, set the dispatch row once:
   ```sql
   update public.push_config
     set endpoint_url = 'https://<app>/api/push/send',
         secret       = '<PUSH_SEND_SECRET>';
   -- if no row exists: insert into public.push_config (endpoint_url, secret) values ('https://<app>/api/push/send','<PUSH_SEND_SECRET>');
   ```

## Vercel configuration

- **Cron jobs** (defined in `vercel.json` — deployed automatically; confirm they appear under Project → Cron). Twelve daily crons; `vercel.json` is the source of truth if this table rots:
  | Path | Schedule (UTC) |
  |---|---|
  | `/api/cron/signals` | `0 11 * * *` |
  | `/api/cron/engine` | `30 11 * * *` |
  | `/api/cron/reports` | `0 12 * * *` |
  | `/api/cron/publish` | `0 13 * * *` |
  | `/api/cron/notifications` | `0 14 * * *` |
  | `/api/cron/campaigns` | `0 15 * * *` |
  | `/api/cron/scheduled-messages` | `0 15 * * *` |
  | `/api/cron/integrations` | `30 15 * * *` |
  | `/api/cron/marketing-draft` | `0 16 * * *` |
  | `/api/cron/quote-followup` | `0 17 * * *` |
  | `/api/cron/invoice-reminders` | `0 18 * * *` |
  | `/api/cron/autopay` | `0 2 * * *` |
  > Vercel **Hobby** rejects any sub-daily cron at deploy time — every schedule here must stay daily (this has broken every deploy twice; see git history). On **Pro**, sub-daily backstops may be restored.
- Set every environment variable above for the **Production** environment.

---

# Deploy

## Build
```
npm install
npm run typecheck     # tsc --noEmit — must pass
npm run verify        # every engine guard, one command — must exit 0
npm run build         # next build — must pass
```
> `npm run verify` runs all `scripts/verify-*.ts` in one shot and **fails on the exit
> code**, not a printed tally — a guard that dies mid-way still counts as failed. It
> also refuses to run if the guard set has drifted (a `verify-*.ts` with no npm
> script, or vice versa), so "the suite is whole" is asserted, not assumed. Run a
> single domain with `npm run verify:<name>`; `npm run verify -- --check` does the
> drift check alone. None of these ship — they are dev/CI gates, not build steps.

## Deploy
```
# Vercel (recommended): push to the production branch, or
vercel --prod
```
Vercel reads `vercel.json` (crons) and your env vars automatically.

## Verify (smoke, immediately after deploy)
- **`GET https://<app>/api/health`** → `200` and `"status":"ok"`. This is the fastest
  answer to "did the deploy work?" — it reports the commit it's running, proves the
  database is actually reachable (not just configured), and lists which capabilities
  (payments, email, SMS, cron, maps) are switched on.
  - `"status":"degraded"` → still `200`. The app works, but something is half-set —
    read `checks.config` and `capabilities` to see what. Notably it flags
    `STRIPE_SECRET_KEY` set **without** `STRIPE_WEBHOOK_SECRET`, which silently stops
    AutoPay from charging.
  - `503` → the database is unreachable. That is a real outage; nothing else in this
    list will pass either.
  - Point your uptime monitor at this path and alert on the **status code** — `ok` and
    `degraded` both return `200` on purpose, so a missing Twilio key never pages anyone
    at 3am. It answers in ~0.5s and gives up on the database after 3s.
- App loads, you can sign in, every dashboard page renders.
- `GET https://<app>/api/payments/status` → `{ "enabled": true, "webhook": true }`.
- Send a test Stripe webhook from the dashboard → 200, no 500s in Vercel logs.
- `GET https://<app>/api/cron/autopay` with header `Authorization: Bearer <CRON_SECRET>` → `{ ok: true, ... }` (and `403` without the secret).
- Maps proxy is protected: `POST https://<app>/api/geocode` **without** a session → `401`.

---

# After Deploy — functional tests

1. **Website lead test** — In Settings, enable the Booking link to generate a `booking_token`. `POST https://<app>/api/website-lead` with `{ "token":"<booking_token>", "firstName":"Test","phone":"...","address":"...","lawnSqft":4000,"requestedServices":"Lawn Mowing","frequency":"weekly","estimatedPrice":60 }` → `{ ok:true }`. It appears in **Messages → Website Leads** with the badge + lead card.
2. **Quote test** — From that lead, click **Build Quote** → the Quote Builder opens pre-filled → adjust price → Create. The lead badge clears; the property keeps the lawn size/polygon.
3. **AutoPay test** — On a customer with a recurring job: save a card (profile → Add card → hosted Stripe → returns with the card shown), enable AutoPay, complete a recurring visit → invoice flips **paid** within ~2s, customer gets a **receipt**, a `payments` row exists. Double-tap "Done" → still **one** invoice, **one** charge.
4. **One-time payment test** — On an unpaid one-off invoice, **Pay** → hosted Checkout → pay (test card `4242…`) → invoice flips paid via the same webhook. Confirms AutoPay didn't change one-time links.
5. **Refund test** — Refund that payment in Stripe → invoice returns to **unpaid**, a "Payment refunded" notification appears.
6. **Portal test** — Open a customer's portal link: view quotes/invoices/history/photos, accept a quote, save/remove a card, toggle AutoPay, request a service. A bad/expired link shows "isn't valid"; a network blip shows a retry, not a dead link.
7. **Review request test** — Trigger `GET /api/cron/notifications` (Bearer `CRON_SECRET`); a customer with a completed visit yesterday + a Google review URL set receives the review request (and isn't re-sent on a second run).
8. **Website import dedup test** — Submit a second website lead with the **same phone/email** → it attaches to the **existing** customer (no duplicate); exceed the hourly cap → `429`.
9. **Notifications test** — Each event above produces the right in-app notification (bell + `/dashboard/notifications`) live; a failed fetch shows an error + Retry, not "empty."

---

# External Services — setup notes

Env vars and per-service config are above; these are the human steps that gate them:

- **Twilio** — set `TWILIO_FROM` to a real number and complete **A2P 10DLC registration**
  (required for US/CA business texting, can take **days** — start early).
- **Resend** — **verify the sending domain**, then set `RESEND_FROM`.
- **Google Maps** — enable the **Geocoding + Places** APIs; restrict the browser key by
  HTTP referrer and the server key by API.
- **Supabase** — enable **Auth → Leaked Password Protection**; the four storage buckets
  are created by SQL (never the dashboard — see above), and you may tighten their public
  `SELECT` policy so clients can't list all files.

---

# Monitor After Launch

- **Health endpoint** — point your uptime monitor at `GET /api/health` and alert on the
  **status code** (`ok` and `degraded` both return `200` on purpose; `503` = DB unreachable).
- **Stripe webhook** — watch for `500`s / retries in the Stripe dashboard. The webhook
  returns `500` on a DB write failure so Stripe retries — a spike means DB trouble.
- **Cron** — confirm all 12 daily runs appear under Project → Cron (list in `vercel.json`)
  succeed; watch the `sent` count and error logs. A `403` means `CRON_SECRET` is unset.
- **Push delivery** — `select status_code, content, created from net._http_response order by created desc limit 20;`
  (pg_net auto-expires rows ~6h; `sent:N` = delivered, non-200 = a problem).
- **Comms failures** — `notification_log` rows with `status <> 'sent'` indicate Twilio/Resend issues.
- **Supabase advisors** — re-run security + performance advisors periodically; watch slow-query logs as data grows.
- **DB growth** — `messages`, `notification_log`, `road_distance_cache`, `jobs` grow over
  time; revisit indexes/pagination if any get large (see `docs/HARDENING-BACKLOG.md`).
- **App errors** — wire Vercel logs (or Sentry) to catch unhandled errors.

---

# Rollback Plan

**Code (Vercel):** instant — Vercel → Deployments → previous deployment → **Promote to Production** (or `vercel rollback`). The build is immutable; no data migration is tied to a code version.

**Database:** all migrations are **additive + idempotent** (new tables/columns/indexes/policies; no destructive `drop`/`alter type`), so a code rollback needs **no DB down-migration** — older code simply ignores the new columns. There are intentionally no down-migrations.

**Feature kill-switches (no deploy needed):**
- **Disable AutoPay charging globally:** unset `STRIPE_WEBHOOK_SECRET` (the engine refuses to charge without it) or, per customer, turn off AutoPay / remove the card.
- **Stop the AutoPay sweep:** remove the `/api/cron/autopay` entry from `vercel.json` and redeploy, or rotate `CRON_SECRET`.
- **Disable all SMS/email:** remove the Twilio/Resend env vars — every send no-ops cleanly (`commsEnabled()` gate).
- **Disable payments entirely:** remove `STRIPE_SECRET_KEY` — Pay Now / card save hide (`/api/payments/status` → `enabled:false`).
- **Stop website lead intake:** in Settings, disable the Booking link (clears `booking_enabled`) — `/api/website-lead` returns 404; or set `business_settings.website_lead_hourly_limit = 0` is *not* a disable (0 = unlimited) — use the toggle.

**Reverting the one risky migration (`invoices_job_id_key`):** it cannot break existing rows (verified zero duplicate `job_id`s). If ever needed: `drop index if exists public.invoices_job_id_key;` (the app then falls back to the pre-existing soft de-dupe).

**Incident references:** Vercel logs (`console.error/warn` on every webhook/cron/charge failure), `notification_log` (comms audit), `notifications` (owner-facing `payment_failed`/`autopay_review`/`payment_refunded`/`payment_disputed`), `website_leads.raw_submission` (intake audit), and `select status_code, content, created from net._http_response order by created desc` for push delivery.

---

_Operational platform verified deploy-ready and frozen as of 2026-06-25. Remaining non-blocking hardening is tracked in `docs/HARDENING-BACKLOG.md`._
