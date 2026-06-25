# EdgeQuote — Production Deployment Checklist

_Verified against the live database while writing this. "✅ applied" = confirmed present; "⛳ run now" = pending._

---

## 1. SQL migrations (run in this order)

The base schema and most feature migrations are **already applied** (verified): `customers/quotes/jobs/invoices/properties/payments/conversations/messages`, `notifications` + triggers, `push_subscriptions` + `push_config`, `labor_observations`, `day_statuses`, `customers.archived_at` + `reviewed_at`, `business_settings.notif_prefs` + `sms_pricing`, `notification_log.message_id`, `pg_net`, the realtime publication (notifications, messages, conversations, quotes, invoices, jobs, day_statuses), and the FK covering indexes.

**Still pending — run these before launch, in order:**

### ⛳ A. Day Settings (REQUIRED — the per-day crew/hours override fails to save without it)
```sql
alter table public.day_statuses     add column if not exists crew_size int;
alter table public.business_settings add column if not exists default_crew_size int not null default 1;
```

### ⛳ B. Security: lock down trigger functions (RECOMMENDED before launch)
Trigger functions are currently still callable by `anon`/`authenticated` over REST. REVOKE does not affect their use as triggers.
```sql
revoke execute on function public.notify_quote_accepted()        from anon, authenticated;
revoke execute on function public.notify_invoice_paid()          from anon, authenticated;
revoke execute on function public.notify_inbound_message()       from anon, authenticated;
revoke execute on function public.notify_review_received()       from anon, authenticated;
revoke execute on function public.capture_labor_observation()    from anon, authenticated;
revoke execute on function public.push_dispatch()                from anon, authenticated;
revoke execute on function public.bump_conversation()            from anon, authenticated;
revoke execute on function public.sr_to_conversation()           from anon, authenticated;
revoke execute on function public.sync_quote_on_invoice_paid()   from anon, authenticated;
revoke execute on function public.sync_quote_on_job_complete()   from anon, authenticated;
revoke execute on function public.resync_quote_on_job_recurring() from anon, authenticated;
-- pin search_path on the shared updated-at trigger
create or replace function public.handle_updated_at() returns trigger
  language plpgsql set search_path = public as $$ begin new.updated_at = now(); return new; end; $$;
```
_(Leave the `portal_*` and `get_portal_data` functions anon-callable — they are intentionally token-scoped.)_

### ⛳ C. Faster search at scale (OPTIONAL — only once you have thousands of rows)
```sql
create extension if not exists pg_trgm;
create index if not exists customers_name_trgm on public.customers using gin (name gin_trgm_ops);
create index if not exists quotes_qnum_trgm     on public.quotes using gin (quote_number gin_trgm_ops);
create index if not exists invoices_inum_trgm   on public.invoices using gin (invoice_number gin_trgm_ops);
```

### ⛳ D. (If the unified scheduler "schedule_items" feature is in use) — owned by the scheduler work
`public.schedule_items` is **not** in the DB. If the calendar's task/reminder items are needed, run that migration from `supabase/schema.sql`. Not required for core operation.

---

## 2. Environment variables (Vercel)

| Variable | Required? | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ Required | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ Required | Public anon key (RLS-scoped) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Required | Server-only. Used by the Stripe webhook, push-send, and cron. **Never** prefix with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_APP_URL` | ✅ Required | e.g. `https://app.edgepropertyservicesyyc.ca` — builds portal links in server-sent messages |
| `GOOGLE_MAPS_API_KEY` | ✅ Required | Server geocoding / routing |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | ✅ Required | Address autocomplete (browser; restrict by HTTP referrer) |
| `STRIPE_SECRET_KEY` | ⬜ For payments | Leave blank → "Pay Now" stays disabled |
| `STRIPE_WEBHOOK_SECRET` | ⬜ For payments | From Stripe → Developers → Webhooks → signing secret |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | ⬜ For SMS | Sending stays disabled until all three are set |
| `RESEND_API_KEY` / `RESEND_FROM` | ⬜ For email | Requires a verified sending domain |
| `CRON_SECRET` | ✅ Required (reminders) | Vercel sends it as a Bearer token; the cron route validates it |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | ⬜ For push | `npx web-push generate-vapid-keys`; no Firebase/APNs needed |
| `PUSH_SEND_SECRET` | ⬜ For push | Must equal `public.push_config.secret` |

---

## 3. External services to configure

- **Supabase** — DB, Auth, Storage, Realtime. Enable **Auth → Leaked Password Protection**. Buckets `branding` and `job-photos` exist; consider tightening their public `SELECT` policy so clients can't list all files.
- **Stripe** — add a webhook endpoint → `https://<app>/api/stripe/webhook`, copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Subscribe at least to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. _(Refund/expiry events are not yet handled — see limitations.)_
- **Twilio** — a number in `TWILIO_FROM` + **A2P 10DLC registration** (required for US/CA business texting, can take days — start early).
- **Resend** — verify the sending domain; set `RESEND_FROM`.
- **Web Push (VAPID)** — generate keys, set the 4 vars, run the `push_config` UPDATE (below). Works on Chrome/Edge/Firefox/Android and iOS 16.4+ **when installed to the Home Screen**.
- **Google Maps** — enable Geocoding + Places APIs; restrict the browser key by referrer and the server key by API.
- **Vercel** — hosting + Cron (already configured in `vercel.json`: daily `0 14 * * *` → `/api/cron/notifications`).

---

## 4. Manual setup steps

1. Run pending migrations **A** and **B** above (and C/D if applicable).
2. Set all required env vars in Vercel → redeploy.
3. **Push:** `npx web-push generate-vapid-keys` → set the VAPID vars + `PUSH_SEND_SECRET`, then once:
   ```sql
   update public.push_config
     set endpoint_url = 'https://<your-app>/api/push/send',
         secret       = '<same value as PUSH_SEND_SECRET>';
   ```
   _(Already configured and verified delivering on the current project.)_
4. **Stripe:** create the webhook endpoint, set `STRIPE_WEBHOOK_SECRET`.
5. **Twilio:** complete A2P 10DLC; set the three Twilio vars.
6. **Resend:** verify domain; set `RESEND_FROM`.
7. Enable Supabase **Leaked Password Protection**.
8. _(Optional)_ add `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` to `/public` for crisp PWA icons.

---

## 5. Production verification checklist (smoke test after deploy)

- [ ] **Auth** — sign in; every dashboard page loads; signing out returns to `/login`.
- [ ] **Lead → Quote** — add a customer, measure a property, build + save a quote.
- [ ] **Send** — send the quote by SMS/email (if comms configured); it appears in the customer's thread + notification log.
- [ ] **Portal** — open the customer's portal link; Accept a quote; Request a service; toggle consent; (if review URL set) mark reviewed.
- [ ] **Schedule** — convert the accepted quote to a job; it appears on the calendar.
- [ ] **Day Settings** — open a day; change **crew** and **hours**; confirm it **saves** (this is what migration A unblocks) and capacity updates live.
- [ ] **Disable a day** (right-click → Rain) → Auto Optimize routes around it; Weather Ops "Disable Day & Auto Optimize" moves jobs + shows the summary.
- [ ] **Complete a job** → a draft invoice is created.
- [ ] **Invoice → Payment** — "Pay Now" opens Stripe Checkout; after paying, the webhook flips the invoice to **paid** and a payment row is recorded (check within a minute).
- [ ] **Notifications/Push** — accept a quote / pay an invoice → the in-app bell updates live; if push is enabled and the PWA is installed, a push arrives and tapping it opens the right screen.
- [ ] **Realtime/multi-tab** — open the same list in two tabs; a change in one reflects in the other without refresh.
- [ ] **Reminders** — manually GET `/api/cron/notifications` with the `CRON_SECRET` bearer; verify tomorrow's reminders / yesterday's review requests send (and don't duplicate on a second call).
- [ ] **Mobile/PWA** — install to Home Screen; safe-area + touch targets look right; offline shows the branded offline page.

---

## 6. Monitor after launch

- **Stripe webhook** — watch for `500`s / retries in the Stripe dashboard (the webhook now returns 500 on a DB write failure so Stripe retries — a spike means DB trouble).
- **Cron** — confirm the daily run succeeds; watch the `sent` count and any error logs.
- **Push delivery** — `select status_code, content, created from net._http_response order by created desc limit 20;` (pg_net auto-expires rows ~6h; `sent:N` = delivered, non-200 = a problem).
- **Supabase advisors** — re-run security + performance advisors periodically; watch slow-query logs as data grows.
- **Comms failures** — `notification_log` rows with `status <> 'sent'` indicate Twilio/Resend issues.
- **DB growth** — `messages`, `notification_log`, `road_distance_cache`, `jobs` grow over time; revisit indexes/pagination if any get large.
- **App errors** — wire Vercel logs (or Sentry) to catch unhandled errors.

---

## 7. Known limitations (not worth blocking launch)

- **Refunds/expiries:** the Stripe webhook handles successful payments only. A refund or expired session won't auto-revert the invoice — handle manually for now (add `charge.refunded`/`checkout.session.expired` handlers before high payment volume).
- **Partial payments:** an invoice is paid-or-not; no partial-balance tracking.
- **Recurring autopay / card-on-file:** not built. A non-disruptive design is documented (add `customers.stripe_customer_id` + a `payment_methods` table + a `portal_setup_autopay` SetupIntent flow, reusing the existing webhook) — additive, no retroactive migration.
- **Multi-tab exact-simultaneous actions:** completing the *same* job in two tabs at the same instant can race the draft-invoice creation. Single-user double-clicks are guarded; the two-tabs case wants a partial unique index (a small follow-up migration).
- **Analytics at scale:** the dashboard + intelligence loaders fetch all rows; fine for hundreds, move to SQL aggregates when you reach thousands. Same for the `auth.uid()`-per-row RLS optimization.
- **SMS cost is an estimate** (configurable in Settings → Messaging); actual carrier charges vary. MMS shows "Estimate unavailable."
- **Secondary pages** keep a simple loader rather than a skeleton (cosmetic only).
