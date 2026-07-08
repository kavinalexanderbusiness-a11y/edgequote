# EdgeQuote Production Readiness Report

**Date:** 2026-07-02 · **Branch audited:** `feature/crm-automation` (working tree) · **Method:** 9 parallel deep-read subsystem audits (quotes/pricing, scheduling/routing, customers/CRM, messaging/notifications, invoices/payments/Stripe, photos/uploads/Grow, API/security/RLS, design system/a11y/mobile, dashboard/analytics/data layer) + live production DB verification (migrations, function grants, RPC definitions, Supabase security & performance advisors). Every finding was verified in code with file:line; all Critical money/security claims were re-verified against the **live production database**. No fixes were applied — this is audit-only.

---

## Verdict

The core engines are genuinely strong: Stripe/Twilio webhook signature verification is correct and timing-safe, cron routes fail closed, the payment ledger and cadence-guard engines are well designed, the realtime hook is leak-free, and payment amounts are never trusted from the client. **But the app is not launch-ready yet.** There are 7 Critical issues — three money-handling, two compliance/security, two data-loss — plus a band of High issues that cluster around five recurring root-cause patterns. The good news: most Criticals are small, localized fixes (a missing column in an RPC, a missing balance subtraction, a missing consent check, one REVOKE, a strip-generated-columns on undo, a `.limit()`, a `beforeunload` handler).

### Corrections to assumed state (verified live in prod today)

- **All pending migrations ARE applied in production**: `quote_services`, photo-dedup `content_hash`, `route_order`, payment ledger, 3-arg `submit_website_lead`, `day_statuses`, `crm_campaigns`, `payment_methods`. Stale "must run before deploy" notes in memory/comments are wrong.
- **`supabase/schema.sql` has drifted from prod in BOTH directions**: prod has the expanded quote status check + follow-up columns that the repo file lacks (a fresh deploy from the file would break the app); and the file implies `find_customer_by_phone` is authenticated-only while **prod grants PUBLIC/anon execute**.

### Five systemic root causes

Fixing these as *patterns* resolves dozens of findings at once:

1. **Unchecked Supabase writes / optimistic UI with no revert.** `await supabase...insert/update/delete` with the result ignored appears in every subsystem. The worst cases are Criticals (broken quote undo) and Highs (quote vanishes with no job; false "Saved ✓").
2. **Duplicate engines that drifted.** 5 send pipelines (one skips consent — Critical), 4 invoice-balance computations (two charge the wrong amount — both Criticals), 3 customer matchers, 3 "complete job" paths, 2 rain-delay engines, 2 shared "local today" helpers + 5 private copies. Every money/compliance Critical sits at an engine-divergence point. This is the owner's own one-engine principle being violated.
3. **Unbounded queries + PostgREST's silent 1000-row cap.** Not a perf nicety — a *correctness* bug: the schedule calendar and every analytics number silently truncate once history passes ~1000 rows.
4. **Check-then-act without a DB constraint backstop.** Dedupe-log races (double SMS), quote/invoice-number collisions, double Convert-to-invoice.
5. **Errors rendered as empty/zero.** Analytics loaders never check `.error` (zeros get cached), pages blank or spin forever, settings show "Saved ✓" on failure, Grow shows a false "all caught up."

---

## CRITICAL — fix before any real customer transacts

### C1. Portal "Pay" charges the wrong amount — GST silently dropped, invoice becomes unpayable online
- **Why it's a problem:** For a GST-charging business the portal shows "Pay $105" but Stripe charges $100 net. The DB trigger then computes the GST-inclusive total, the invoice lands in `partial`, and the GST remainder is **permanently unpayable online**: a second attempt computes `total(net) − amount_paid(net) = 0` → 409 "already paid."
- **Root cause:** The pay route reads `invoice.gst_percent` from the `portal_invoice_for_payment` RPC, but the RPC returns only `id, invoice_number, service_type, amount, amount_paid, status, customer_id, user_id` — **verified against the live prod function definition**. The dashboard checkout route fetches `gst_percent` itself and is correct; this path diverged.
- **Best solution:** Add `gst_percent` (from `business_settings`) to the RPC's returned JSON, or have the route fetch it via the service-role client like `checkout/route.ts` does.
- **Files:** `src/app/api/portal/pay/route.ts:24-30`; `supabase/schema.sql:3160-3172`; `supabase/RUN-2026-06-27-payment-ledger.sql:103-115`; page math `src/app/portal/[token]/page.tsx:541-543`.

### C2. Owner "Charge card" double-collects on partially-paid invoices
- **Why:** The button shows on any invoice with balance > 0, including `partial`. The engine charges the **full GST-inclusive total of `invoice.amount`** with no `amount_paid` subtraction — a customer who e-transferred half gets their card charged the entire invoice.
- **Root cause:** `attemptAutoPayCharge` was written for freshly-drafted recurring invoices and never adopted the charge-the-balance model the checkout and portal routes use (engine divergence #4 of the four balance computations).
- **Best solution:** In `attemptAutoPayCharge`, charge `invoiceBalance().total − amount_paid` (skip when ≤ 0), reusing `lib/payments/ledger.ts` as the one balance engine.
- **Files:** `src/lib/payments/autopay.ts:49-55, 104-108`; `src/app/dashboard/invoices/page.tsx:412-416`.

### C3. Conversation replies bypass SMS consent — STOP is not enforced (CASL/carrier compliance)
- **Why:** A customer who texted STOP (which sets `sms_opt_in=false` via the inbound webhook) can still be texted from the Messages thread, the customer profile, or any surface embedding `ConversationThread`. Every other sender gates on opt-in; this one path doesn't.
- **Root cause:** `/api/messages/send` re-implemented sending (calls `sendSms` directly, selects only `phone`) instead of using the shared gated `dispatchToCustomer` — the five-pipelines drift.
- **Best solution:** Route it through `dispatchToCustomer` (or minimally select `sms_opt_in` and refuse when false); disable "Reply by SMS" in the composer for opted-out customers.
- **Files:** `src/app/api/messages/send/route.ts:31-36`; `src/components/messages/ConversationThread.tsx:87-106`.

### C4. `find_customer_by_phone` is anon-executable in prod, matches cross-tenant, and STOP flips only one duplicate row
- **Why:** Three compounding problems. (a) **Verified in prod:** the SECURITY DEFINER RPC has PUBLIC + anon EXECUTE grants — anyone holding the publishable anon key can enumerate phone numbers and get back customer id, name, owner `user_id`, and `sms_opt_in` across **all tenants** (PII enumeration). (b) The lookup has no tenant scoping (`order by created_at desc limit 1` across all users), so with one shared Twilio number, inbound texts — including STOP — can land in the *wrong business's* inbox. (c) STOP updates only the single matched row, so a duplicate customer row with the same phone keeps `sms_opt_in=true` and cron/campaigns keep texting an opted-out number.
- **Root cause:** Prod grants drifted from the schema file's intent (default PUBLIC execute never revoked); single-row unscoped lookup; per-row consent update.
- **Best solution:** Immediately: `revoke execute on function public.find_customer_by_phone(text) from public, anon, authenticated;` (service_role keeps its explicit grant, so the webhook is unaffected). Then: scope matching per tenant and make STOP/START update every customer row sharing the normalized phone within the tenant.
- **Files:** `supabase/schema.sql:1501-1514`; `src/app/api/sms/inbound/route.ts:52-65`; prod grants (live DB).

### C5. Quote-delete "Undo" is broken — deletions are unrecoverable
- **Why:** Delete is undo-based (no confirm), and on mobile the trash button is always visible. The Undo re-inserts the full `select *` row — but `quotes.man_hours`, `subtotal`, `total` are `GENERATED ALWAYS ... STORED`, so Postgres rejects the insert (428C9). The error is never checked, so Undo silently does nothing; cascade-deleted `quote_services` rows are gone too. One accidental tap = a customer quote permanently lost.
- **Root cause:** Unchecked insert of generated columns; child rows not snapshotted. Bulk undo has the identical bug.
- **Best solution:** Strip generated columns and restore `quote_services` children on undo (or soft-delete quotes); check the insert error and toast on failure. Same class of check needed for the invoice undo (see H4).
- **Files:** `src/app/dashboard/quotes/page.tsx:46-53`; `src/components/quotes/QuoteList.tsx:181-194, 304`; `supabase/schema.sql:61-63`.

### C6. Schedule page silently truncates at 1000 rows — future jobs vanish from the calendar
- **Why:** Every schedule view, the optimizer, cadence validation, Schedule Health, and undo snapshots read one unbounded `select('*')` of ALL jobs ever. PostgREST caps at 1000 rows *without an error*, ordered by `scheduled_date` ascending — so once history + pre-generated recurring visits pass 1000 (≈40 weekly customers within a season), the **furthest-future jobs disappear** from the calendar and every engine. The owner double-books; the optimizer validates against an incomplete timeline.
- **Root cause:** No bound/pagination on `fetchJobs`; `quotes`, `job_recurrences`, and line-item fetches similarly unbounded; no error checks.
- **Best solution:** Bound the primary fetch to the operational window (trailing ~60 days + all future, paginated with `.range()`), fetch history on demand, and check errors.
- **Files:** `src/app/dashboard/schedule/page.tsx:423-476`.

### C7. Background upload queue loses photos on tab close — while telling the user it's safe to leave
- **Why:** A crew member drops 20 photos, sees "Uploading in the background — keep working," locks the phone or the mobile browser discards the tab — every queued/paused/in-flight photo is gone with no warning and no record. Bad connections (the norm in the field) maximize the exposure window.
- **Root cause:** The queue is a memory-only module store; there is **no `beforeunload` handler anywhere in `src`** (verified) and no persistence. The code comment acknowledges files can't survive reload, but the UI says the opposite.
- **Best solution:** Register a `beforeunload` guard while any item is non-terminal + show "don't close yet" in the tray; longer-term persist queued blobs to IndexedDB and resume on launch.
- **Files:** `src/lib/uploadQueue.ts:52-64, 206-214`; `src/components/photos/BeforeAfterUploader.tsx:296`.

---

## HIGH

### Money & billing

- **H1. AutoPay-charged invoices stay stuck in `draft` forever.** Both AutoPay entry points charge drafts; the status trigger explicitly preserves `draft`, and nothing promotes a charged draft. The customer is charged + receipted while the invoice sits in "Drafts to review," is excluded from Outstanding, remains editable, and `syncDraftInvoiceAmounts` will re-price the already-charged draft. *Fix:* promote out of `draft` at charge time (or let the trigger flip drafts with `amount_paid > 0`); make draft-sync skip paid drafts. — `supabase/schema.sql:3123-3124`; `src/lib/payments/autopay.ts:54`; `src/app/api/cron/autopay/route.ts:48`; `src/lib/invoicing.ts:114, 243, 265`; `src/app/api/stripe/webhook/route.ts:170`.
- **H2. Immutable idempotency key `autopay:<invoiceId>` blocks legitimate retries.** After a decline, a retry with a replaced card 400s (`idempotency_error`) surfaced as a generic decline for 24h; after a **full refund**, the existing payment row makes the invoice **forever** unchargeable (dedupe checks row existence, not status). *Fix:* attempt-scoped key (invoice + payment-method + date); filter the DB dedupe on `status='paid'`. — `src/lib/stripe/config.ts:206`; `src/lib/payments/autopay.ts:101-102`; `webhook/route.ts:238`.
- **H3. Deleting an invoice with a payment in flight makes the webhook permanently unrecordable.** The payment insert hits an FK violation → webhook 500s → Stripe retries ~3 days → gives up. Money exists in Stripe, nowhere in EdgeQuote, nobody told. *Fix:* on FK violation record with `invoice_id = null` + owner notification; block deleting invoices with live sessions. — `src/app/api/stripe/webhook/route.ts:75-93, 158-167`; `src/app/dashboard/invoices/page.tsx:226-237`; `supabase/schema.sql:977`.
- **H4. Undo-restoring a deleted paid invoice fabricates full balance owing.** The restore row omits `amount_paid`, `paid_at`, `payment_method`, `discount_*`; payments were FK-nulled. Restored invoice says `paid` but shows the full total due with live Pay/Charge buttons — one tap re-bills a customer who already paid. *Fix:* restore the missing columns and re-link the orphaned payments (or soft-delete invoices with payments). — `src/app/dashboard/invoices/page.tsx:213-237`.
- **H5. Partial refunds and disputes never touch the ledger, and there's no refund UI on paid invoices.** `amount_paid` stays overstated; reports wrong. `recordRefund` exists but is only reachable from the overpayment resolver. *Fix:* ledger a negative row on partial `charge.refunded` (idempotent per charge+amount); expose "Record refund" on paid invoices. — `webhook/route.ts:221-258`; `src/components/payments/InvoicePaymentControls.tsx:84-103`; `src/lib/payments/ledger.ts:107-118`.
- **H6. Double-invoice race on Convert-to-Invoice.** Manual Convert racing the job-completion auto-draft (or two tabs) both pass SELECT-then-INSERT; `invoices(quote_id)` has no unique index (manual convert inserts `job_id: null`, so the job_id partial unique can't catch it). Customer billed twice. *Fix:* partial unique index on `invoices(quote_id) where job_id is null` + conflict handling + re-entry guard. — `src/app/dashboard/quotes/[id]/page.tsx:318-389`; `src/components/quotes/QuoteList.tsx:109-137`; `src/lib/invoicing.ts:164-181`; `supabase/schema.sql:424, 437`.

### Broken workflows & silent data corruption

- **H7. `quote_services` writes are unchecked and non-atomic.** Edit does delete-then-insert with neither checked: delete-ok/insert-fail loses the breakdown while `initial_price` keeps the sum; the PDF then prints line rows whose sum ≠ the printed total (customer-facing contradiction). *Fix:* check every write; replace with one RPC/upsert so rows + cache change together. — `src/app/dashboard/quotes/new/page.tsx:178-196`; `src/app/dashboard/quotes/[id]/page.tsx:159-183, 440-448`; `src/components/quotes/QuotePDF.tsx:80, 158-203`.
- **H8. Auto-draft invoice drops the travel fee** when `show_travel_separately` is off (the default): auto path bills `initial_price` only, manual Convert bills `quote.total` (= initial + travel). Same job, two amounts; owner silently loses travel revenue. *Fix:* the toggle must govern display only, never the amount. — `src/lib/invoicing.ts:33-49, 76-98, 200-204`; `supabase/schema.sql:63`.
- **H9. Quick-schedule can vanish an accepted quote with no job created.** If the job insert fails (error ignored), the quote still flips to `scheduled` — it disappears from "Accepted — not yet scheduled" AND Today's Priorities while no job exists. Committed revenue silently lost by the card that exists to prevent exactly that. *Fix:* check the insert before flipping status (or one RPC). — `src/components/dashboard/UnscheduledAccepted.tsx:50-63`.
- **H10. Every sender dedupes check-then-send — double-message races.** Campaign cron sends **before** writing the dedupe log (the unique constraint only blocks the second *log row*, after the second SMS went out); reminder cron's `alreadySent` ignores channel (one sent channel suppresses retry of the failed one — the "failed-reminder retry" fix only holds when *every* channel failed); `/api/comms/send` uses a non-unique dedupe index. Overlapping runs (Vercel retry, manual `?secret=` trigger) double-text customers. *Fix:* claim-then-send — insert the log row under a unique key first, send only if the insert won; make reminder dedupe per (job, template, channel). — `src/app/api/cron/campaigns/route.ts:104-149`; `src/app/api/cron/notifications/route.ts:45-66`; `src/app/api/comms/send/route.ts:38-41, 115-117`; `supabase/schema.sql:914, 3016-3028`.
- **H11. Campaign cron dies mid-run and drops birthday/anniversary sends forever.** Sequential per-recipient awaits with no `maxDuration`, no batching, no partial-run visibility — a timed-out run's unsent birthdays never match tomorrow. `MAX_AUDIENCE` also slices *before* day-of filtering, so past 2000 customers, people whose birthday IS today can be cut. `recurring_only` fails closed and silent on query error (campaign "ran," sent to zero). *Fix:* filter date matches in SQL, batch with bounded concurrency, set `maxDuration`, report processed/total, check errors. — `src/app/api/cron/campaigns/route.ts:25, 76-100, 119-149`.
- **H12. CSV import bypasses the dedup engine entirely.** The most common import scenario (owner switching tools, overlapping lists) mass-creates duplicate customers + properties with no warning; the properties insert error is unchecked (success screen can lie). *Fix:* run rows through `findCustomerMatch` (and intra-file) with skip/merge choices in the preview. — `src/app/dashboard/customers/import/page.tsx:91-119`; engine `src/lib/dedup.ts:21`.
- **H13. Three divergent customer matchers; the canonical one misses country-code variants.** `+1 403 555 0100` ≠ `(403) 555-0100` in the client matcher (exact-digit compare), while the intake SQL compares last-10 — so intake and the app disagree about who exists; intake's address match is raw equality, missing the normalizer's "St vs Street" cases. *Fix:* last-10 comparison in `normalizePhone` matching; port address-key normalization into `submit_website_lead`. — `src/lib/customers.ts:14-17, 71-75`; `supabase/schema.sql:2708-2723`.
- **H14. Deleting a campaign (or delete→Undo) destroys its dedupe history → same-period re-sends.** `crm_campaign_log` rows cascade-delete and undo doesn't restore them; tomorrow's cron re-messages everyone already messaged this period. *Fix:* soft-delete campaigns, or snapshot+restore log rows in the undo. — `src/components/grow/CampaignManager.tsx:111-117`; `supabase/schema.sql:3020`.
- **H15. Shared Send dialog sends quote/invoice messages with an EMPTY portal link.** The dialog's client-side render never supplies `portalLink`/`quoteLink`/`invoiceLink`, and single-recipient sends always use the previewed body — customers get "pay using the link below:" followed by nothing, from the Quote and Invoices pages. *Fix:* resolve links at compose time (or server-render via `previewOnly`; don't send bodyOverride when unedited). — `src/components/comms/SendMessageDialog.tsx:108-151`; `src/lib/comms/templates.ts:316-318`.
- **H16. Inbound SMS webhook silently rejects ALL messages if `NEXT_PUBLIC_APP_URL` is unset/mismatched.** Signature verification reconstructs the URL from that env var (apex vs www, preview URL → every inbound 403s with zero logging). Customer replies — including STOP — vanish. *Fix:* derive the URL from the request headers with env fallback; log/alert signature failures; add webhook health to the Communications Test card. — `src/app/api/sms/inbound/route.ts:16-22, 39-49`.

### Scheduling

- **H17. Open-ended recurring series silently end after 26 visits (~6 months).** Nothing tops up the horizon — no cron, no on-load extension. Weekly customers fall off the schedule mid-season with no signal on the calendar. *Fix:* roll the horizon on schedule load (or cron) when remaining future visits drop below a threshold. — `src/lib/recurrence.ts:6-7, 27-29`; creation paths `src/app/dashboard/schedule/page.tsx:724-788, 868-905`.
- **H18. Optimizer's search cost ignores per-day capacity overrides.** `contribOf` uses flat business capacity while the before/after metrics use `capMinFor(date)` — it happily moves work onto a day the owner cut to 4h, then its own metrics contradict the plan. *Fix:* thread the date into `contribOf` so overload uses `capMinFor`. — `src/lib/optimizer.ts:505-508, 675-679, 715-756` vs `832-854`.
- **H19. Schedule mutations fail silently with no revert.** Job move (drag/Move-to) is optimistic with the update result unchecked — on field connectivity failures the calendar lies until reload, and a bogus Undo is offered for a move that never persisted. Manual route reorder (`applyOrder`/`resetOrder`) never checks its `Promise.all` either. *Fix:* check errors, revert optimistic state, toast. — `src/app/dashboard/schedule/page.tsx:1331-1342`; `src/components/schedule/DayOpsPanel.tsx:281-344`.
- **H20. Day Ops "Rain delay" uses a duplicate, weaker engine.** It bumps all remaining jobs to one `nextWorkday()` with no blocked-day skip, no capacity check, no cadence ceiling — can pile 8h onto a Vacation day and create same-day duplicate mows on top of already-generated next visits, exactly what `planRainDelay` prevents. *Fix:* route the button through `planRainDelay`. — `src/app/dashboard/schedule/page.tsx:1296-1319` vs `src/lib/disruption.ts:43-52`, `src/lib/optimizer.ts:256-306`.

### Data correctness at scale & error handling

- **H21. Unbounded full-table queries across every analytics surface — silent 1000-row truncation = wrong numbers, not slow ones.** Offenders (all missing `.limit()`/window, most `select('*')`): `src/app/dashboard/page.tsx:22-24`; `TodaysPriorities.tsx:52-55`; `UnscheduledAccepted.tsx:28-31`; `WeekendOutlook.tsx:45-46`; `AcquisitionInsights.tsx:25-28`; `MissedJobs.tsx:43-50`; `src/lib/analyticsData.ts:36-38`; `suggestionsLoad.ts:22-37` (11 parallel full-table fetches); `businessIntelligence.ts:341-348`; `revenueIntelligence.ts:489-494`; `labor.ts:469-471`; `customerHealth.ts:183-187`; `winLoss.ts:126-128`; `weatherImpact.ts:203-206`; `geo.ts:50-53`; `prospect.ts:37-40`; `prefetch.ts:32-36`; pages `reactivation:73-75`, `data-quality:47-51`, `neighbors:66-68`, `saturation:80-81`, `routes:53-54`, `review:41-43`, `pricing-recovery:49-52`; `quotes/page.tsx:25-40`; `quoteLearning.ts:343-347`; plus the messages thread (`ConversationThread.tsx:42-48`) and Studio (`BeforeAfterStudio.tsx:131-154`). *Fix:* date-windowed filters + column lists + explicit limits with an over-limit sentinel (copy `businessMemory.ts:158-160`), or SQL rollups.
- **H22. Analytics loaders swallow errors — failed fetches render (and cache) zeros; half the pages blank or spin forever on failure.** Loaders destructure only `.data` (zeroed BI reports get sessionStorage-cached for 5 min); Intelligence/Revenue/Weather render `null` on failure; Routes/Reactivation/Data-Quality/Neighbors/Measurements never reach `setLoading(false)`; SuggestionsCenter shows a false "You're all caught up." *Fix:* check `.error` and throw; copy the Profitability/Saturation error+retry pattern; never cache an errored result. — `businessIntelligence.ts:340-349`; `intelligence/page.tsx:22-47`; `revenue-intelligence/page.tsx:34-59`; `weather/page.tsx:49`; `routes/page.tsx:42-105`; `SuggestionsCenter.tsx:44-48, 120-124`; gold standard: `profitability/page.tsx:52, 88-92, 153-157`, `invoices/page.tsx:73-74`.
- **H23. `useBusinessData`'s error state can never render — Settings/Templates hang on "Loading…" forever.** The `useSyncExternalStore` snapshot is the unchanged `null` store, so the error emit never re-renders. *Fix:* give the snapshot a new identity on error. — `src/hooks/useBusinessData.ts:61, 70, 88-89`; `settings/page.tsx:196`; `templates/page.tsx:98`.
- **H24. Every Settings save wipes base coordinates.** Saving *any* field nulls `base_lat/lng`; until a map page happens to re-geocode, Weather shows the Calgary default for a non-Calgary business and route economics zero out. *Fix:* null coords only when `base_address` changed (or geocode on save). — `src/app/dashboard/settings/page.tsx:158`; `src/lib/weatherImpact.ts:216-220`.
- **H25. Settings writes never check errors — false "Saved ✓".** Failed updates still flash Saved (main form, logo scale/upload, travel tiers, dashboard layout, automation toggles — a failed toggle leaves reminders in the opposite state the UI shows, compliance-adjacent). *Fix:* one save-with-feedback helper; check every write; revert optimistic toggles. — `settings/page.tsx:63-69, 119-133, 135-164, 181-188`; `DashboardSections.tsx:36-40`; `AutomationToggles.tsx:31-36`; `templates/page.tsx:61-73`.

### Public surface & upload pipeline

- **H26. Public write endpoints have no rate limiting.** `submit_booking` (anon, creates customer+property+quote+request per call — the sibling `submit_website_lead` got a cap, this didn't), `/api/booking/notify` (unauthenticated email amplification with client-supplied content sent to the owner's real inbox), and `portal_request_service` (unbounded writes + notification storms on a leaked token). *Fix:* per-owner hourly caps inside the RPCs (reuse the website-lead pattern); re-read booking details server-side instead of echoing the client's strings. — `supabase/schema.sql:1276-1382, 878-888`; `src/app/api/booking/notify/route.ts:12-27`.
- **H27. Upload pipeline reliability trio.** (a) Retry backoff is dead code — after a failure `pump()` re-runs the item synchronously, burning all 4 attempts in seconds on flaky connections (the timer fires later into a no-op). (b) JobPhotos — the primary in-field capture — bypasses the resilient queue entirely and swallows all errors (photo just doesn't appear; crew believes it saved). (c) Session-signature dedup silently skips re-submitted files (including a legitimate re-upload after a permanent failure) while toasting success. *Fix:* honor `nextAttemptAt` in `pump()`; route JobPhotos through `enqueueUploads`; scope signatures to (sig, property, job), clear on completion, and toast honestly. — `src/lib/uploadQueue.ts:104-118, 159-203`; `src/components/photos/JobPhotos.tsx:56-82`; `src/lib/photos.ts:94-132`.

### Accessibility & mobile blockers

- **H28. The dialog layer is keyboard/SR-broken app-wide.** `ui/Modal` has no focus trap and no focus restore (every confirm + SendMessageDialog inherit it); **ten** hand-rolled overlays never migrated to Modal (most lack Escape, dialog semantics, and scroll-lock: ScopeDialog, JobPhotos lightbox, CustomerList SMS-confirm, moveConfirm, OptimizeSchedule, RainDelayCenter, QuoteMeasure, BeforeAfterStudio, Sidebar drawer); and ~9 uncoordinated document-level Escape listeners mean one keypress closes multiple layers or fires while typing (Escape while composing on Messages closes the thread). *Fix:* trap+restore in Modal once; migrate the overlays; a shared escape-layer stack (innermost consumes, all check `defaultPrevented`). — `src/components/ui/Modal.tsx:36-97`; files listed per finding in the a11y section source.
- **H29. Toasts are never announced to screen readers.** `toast` is the app's only success/error/undo channel (it replaced `alert()`), yet the container has no `aria-live`/`role="status"` — non-sighted users get zero feedback, and the time-limited Undo (the recovery path for deletions) is purely visual. *Fix:* `role="status" aria-live="polite"` on the stack (alert for error tone); pause auto-dismiss on hover/focus for Undo toasts. — `src/components/ui/Toaster.tsx:24, 38`; `src/lib/toast.ts:45-54`.
- **H30. Light theme fails contrast on nearly all status/tone UI.** The tone system hardcodes dark-palette classes (`text-emerald-400`, toast text `-200` ≈ 1.3-2.8:1 on light surfaces — effectively invisible); ~310 occurrences across ~80 files including all form error text. *Fix:* tokenize tones as CSS variables per theme (like `--c-accent`) and sweep. — `src/lib/tone.ts:10-27`; `Toaster.tsx:12-18`; `Input.tsx:35`; `Select.tsx:27,42`; `globals.css:8-49`.
- **H31. AddressAutocomplete is keyboard-unusable — including the customer-facing booking form.** No ArrowUp/Down/Enter handling at all (suggestions are mouse/touch-only; Enter submits the form); no combobox ARIA. *Fix:* port CustomerPicker's keyboard handling + proper listbox semantics. — `src/components/ui/AddressAutocomplete.tsx:135-163`; consumers `book/[token]/page.tsx:237`, `CustomerForm.tsx:121`, `neighbors:255`, `settings:309`.

---

## MEDIUM

### Payments & invoices
1. **"Raise total" leaves status stuck `overpaid`** — the recompute trigger only fires on `payments` changes, never on `invoices.amount` edits. Add an invoices-side trigger or inline recompute. — `InvoicePaymentControls.tsx:59-68`; `schema.sql:3108-3134`.
2. **`recompute_invoice_paid` lost-update race** — sums payments before locking the invoice row; concurrent webhook + manual entry can drop one payment from `amount_paid` until the next ledger event. Add `select … for update`. — `schema.sql:3108-3134`.
3. **Every "Pay" click mints a fresh 24h checkout session** — two live links can both be paid (double-collect surfacing as `overpaid`). Set short `expires_at` and/or reuse the open session per unchanged balance. — `stripe/config.ts:45-88`; `checkout/route.ts:40-45`; `portal/pay/route.ts:33-37`.
4. **Forever-dedupe swallows later money events** — `notifyOnce` on (user, type, entity) with no time bound: the full refund after a partial, or this month's decline after last month's, is silent. Key on event distinguishers or a time window. — `webhook/route.ts:53-60, 197-213`; `autopay.ts:166-179`.
5. **"Charge card" renders on one-time-job invoices but the engine always refuses (`not-recurring`)** with an unmapped generic error. Allow deliberate manual charges or hide the button + map the reason. — `invoices/page.tsx:94-114, 412-416`; `autopay.ts:57-62`.
6. **`checkout.session.async_payment_failed` unhandled** — delayed-settlement failures (e.g. PADs) are fully silent while the customer believes they paid. — `webhook/route.ts:63-104`.
7. **Invoice PDF ignores `amount_paid`** — a partial invoice's PDF demands the full total (double-payment-inducing; portal disagrees). Add Paid/Balance rows via `invoiceBalance`. — `InvoicePDF.tsx:157-189`.
8. **Quote/invoice numbers can collide** — client-side max+1 with no unique constraint; two tabs mint the same customer-facing number. Unique index on `(user_id, number)` + retry. — `lib/utils.ts:45-52`; `invoicing.ts:224-225`; `schema.sql:38, 392`.
9. **AutoPay anomaly baseline mixes all of a customer's recurring services** — legit invoices held (silently) or off-amount ones passed. Scope the median per service/recurrence. — `autopay.ts:88-97, 132-144`.

### Quotes & pricing
10. **Quantity 0 billed as quantity 1** — `serviceLineTotals` coalesces any non-positive qty to 1; an explicit 0 still bills full price into the PDF/invoice. — `quoteServices.ts:28-36`.
11. **Nameless service lines counted in the preview total but dropped on save** — saved quote is lower than what the owner just saw, no warning. Align the preview filter or require the name. — `QuoteBuilder.tsx:159-161`; `new/page.tsx:129-133`.
12. **Edit round-trip diverges from create** — overgrowth multiplier resets to 1 (re-applying it double-multiplies the baked rate); fee recovery is baked on create but not when an engine price is applied during edit. Store raw rate + multiplier once; one shared bake point. — `[id]/page.tsx:117-118, 136-147, 548-549`.
13. **"Roll travel into total" toggle does nothing on the quote PDF** — travel always prints as its own row, contradicting the setting. — `QuotePDF.tsx:186-209`.
14. **"PDF & mark sent" marks sent even when PDF generation failed** — arms follow-up clocks for an undelivered quote. Return success from `handleOpenPdf`. — `[id]/page.tsx:209-244`.
15. **QuoteStatusControl: optimistic, unchecked, stale** — failed updates keep the new pill; the list's control never re-syncs after realtime refetch (portal acceptance not reflected). — `QuoteStatusControl.tsx:19-38`.
16. **Multi-service quotes poison the pricing model** — quote learning trains the primary service on the summed `initial_price` ($60 mow + $500 mulch ⇒ mowing "won at 9×"), drifting recommendations to the clamp. Join `quote_services`, train row 0's net. — `quoteLearning.ts:64-71, 121-135, 343-347`.
17. **Bulk Duplicate/Convert are lossy vs their single counterparts** — no `quote_services` copy, no `line_items` on bulk-converted invoices. Extract shared helpers. — `QuoteList.tsx:109-165`.
18. **`schema.sql` drift breaks fresh deploys** — quote status check constraint and follow-up columns exist in prod but not the file; the file's own function inserts columns the file never creates. Add the idempotent ALTER block. — `schema.sql:66-67` vs `:1032, 1301-1308`.
19. **Builder preview omits fee-recovery markup applied at save** — type $100, save, see $103; erodes trust. Apply the multiplier in the preview. — `QuoteBuilder.tsx:161`; `new/page.tsx:128-158`.
20. **Builder re-render storm** — root-level `watch()` + per-keystroke JSON.stringify autosave re-renders the whole builder per keystroke; input lag on mid-range phones. Scope with `useWatch`. — `QuoteBuilder.tsx:91-98`; `useAutosave.ts:88-115`.

### Scheduling & routing
21. **Round-trip vs one-way drive totals mixed** — the Directions path includes the return-to-base leg; NN fallback/cached/manual order don't ("day got 30% shorter" after a manual reorder). Pick one convention. — `api/route/route.ts:33, 56-62`; `lib/route.ts:61-183`.
22. **Property-less jobs get their TITLE geocoded on every Day view open** — wasted quota + phantom coordinates from Google "resolving" "Lawn Mowing — John Smith". — `DayOpsPanel.tsx:247-255`; `route.ts:35-53`.
23. **Best-day pickers and move warnings are blind to blocked days** — recommenders one-tap book onto Rain/Vacation days. Pass `blockedDates` into `recommendScheduleDays`/`evaluateScheduleMove`. — `route.ts:326-411`; `WeeklyScheduler.tsx:78-87`; `BestDaySuggestions.tsx:65-67`.
24. **Weather Ops manual strategies bypass cadence + per-day capacity** — Tomorrow/Next-workday/Specific-date can stack a weekly visit inside its next sibling's floor and show rosy utilization on reduced-crew days. — `RainDelayCenter.tsx:121-171`.
25. **No realtime on jobs** — phone + desktop sessions never see each other's moves/completions; the optimizer applies against a stale snapshot. Add `useRealtimeRefresh('jobs', …)`. — `schedule/page.tsx:485`.
26. **Up to ~13 synchronous whole-schedule optimizer runs per state change** — main-thread freezes on mobile after every tap at season scale. Debounce/idle-schedule the suggestions memo. — `schedule/page.tsx:214-252`; `optimizer.ts:1238-1369`.
27. **Blocked day with jobs shows "Room for ~8h"** — `dayLoad` coerces capacity 0 to the default 8h, contradicting the Day Settings bar above it. Distinguish 0 from unset. — `route.ts:465-469`.
28. **Touch scroll on calendar chips triggers accidental job moves** — drag activates after 6px with no long-press; busy cells are mostly chip surface. Require ~300ms hold on touch. — `Calendar.tsx:62-63, 111, 193-254`.
29. **Three "complete a job" paths behave differently** — Done stamps `completed_at`/automation/undo; quick-edit and form completion skip all three (travel learning silently starves). Funnel through `completeJob`. — `schedule/page.tsx:845-864, 1070-1109`.
30. **`fetchJobs` has zero error handling** — transient failure renders an empty calendar ("my schedule is wiped"); expired session throws on `user!.id`. — `schedule/page.tsx:423-476`.

### Customers & CRM
31. **Customer Health scores archived customers** — the one engine that forgot `.is('archived_at', null)`. — `customerHealth.ts:182-189`.
32. **FollowUpRadar's realtime is permanently dormant** — `filter: null` means "stay dormant" to the hook; both subscriptions are dead code, plus an out-of-order threshold race. — `FollowUpRadar.tsx:24-30`; `useRealtime.ts:29-31`.
33. **Customer create/edit failures are silent and clear the autosave draft** — console-only error; the form closes as if saved. — `customers/page.tsx:69-124`; `CustomerForm.tsx:48` (same pattern in the quote builder: `QuoteBuilder.tsx:98`).
34. **Editing a customer's address rewrites the primary property in place** (keeping stale sqft/polygon — new address priced with the old lot) or does nothing when no primary exists. Offer new-property-vs-typo; reuse `ensurePropertyForCustomer`. — `customers/page.tsx:104-124`.
35. **Archived customers invisible to dup detection at every entry point** — returning customers get re-added as true duplicates. Include archived (flagged, "Restore instead"). — `customers/page.tsx:38, 190`; `quotes/new/page.tsx:75`.
36. **Automated sends can deliver blank/broken links** — cron never resolves `{{portal_link}}` for owner template overrides (only `custom_body` is checked); review requests go out with an empty `{{review_link}}` when unconfigured; cron-context `portalUrl` emits a relative URL if `NEXT_PUBLIC_APP_URL` is unset. — `cron/campaigns/route.ts:109-124`; `cron/notifications/route.ts:64`; `lib/portal.ts:62-68`.
37. **Feb 29 birthdays never fire in non-leap years; CRM preview (local) disagrees with cron (UTC) by a day.** — `crm/campaigns.ts:92-97`; `grow/crm/page.tsx:36-47`.
38. **Consent toggle is optimistic with no error handling** — the pill can show opted-out while the DB (which the cron reads) says opted-in. Revert + toast on error. — `CustomerComms.tsx:37-50`.
39. **Customer list "Delete" button actually archives** (mislabeled destructive affordance) + a second parallel local toast system in the same component. — `CustomerList.tsx:44-46, 146-152, 275-289`.

### Messaging & notifications
40. **Texts from unknown numbers are silently discarded** — a prospect texting the business number creates nothing (no lead, no notification): an invisible lost-revenue hole. Reuse the intake seam. — `sms/inbound/route.ts:52-54`.
41. **"ONE comms pipeline" is actually five** — route/dispatch/receipt/messages-send/cron each re-implement gating+threading+logging; the drift already produced C3, and cron sends never thread into conversations (`message_id` unlinked). Converge on `dispatchToCustomer`. — `comms/send/route.ts:84-117`; `dispatch.ts:38-64`; `receipt.ts:45-77`; `cron/notifications:65-66`.
42. **Composed reply destroyed on API rejection** — HTTP 400 path skips the rollback that the network-failure path has; the draft is also gone from localStorage. — `ConversationThread.tsx:93-105`.
43. **Failed sends render as normal bubbles** (tiny "· error" suffix), preview shows "You: …", no retry affordance; and Messaging Usage counts failed/disabled rows as spend. — `messages/send/route.ts:36`; `ConversationThread.tsx:188`; `MessagingUsage.tsx:43-48`.
44. **Thread reloads the entire history + audit log on every realtime event** — unbounded and re-fetched per event; append the new row instead. — `ConversationThread.tsx:42-48, 79-85`.
45. **Unread badge/"Mark all read" only operate on the fetched window** (20/100) — older unread rows linger forever; client badge fights the push badge. Use a count query + `update where read=false`. — `NotificationBell.tsx:51-56, 130-134`.
46. **Template editor wipes override keys it doesn't know** (receipt/introduction/campaign types deleted on save); push fan-out failures invisible (only 404/410 handled) and `tag: note.type` collapses same-type notifications on-device. — `MessageTemplateEditor.tsx:37-46`; `push/send/route.ts:77-95`.

### Photos, uploads & AI
47. **Auto-detect force-splits every drop into before+after** — can pair two "after" shots into `marketing_assets` with high confidence; there's no "all one kind" outcome. — `autodetect.ts:23-73`; `uploadQueue.ts:131-141`.
48. **`ensurePair` ignores insert errors** (false "paired" toast) and picks pair photos by enqueue order, overriding the Studio's earliest/latest-by-`taken_at` logic. — `autopair.ts:184-226`; `uploadQueue.ts:128-143`.
49. **Multi-visit uploads with an unresolved job orphan photos from the Studio forever** (uploads succeed with `jobId: null`; no post-hoc attach UI). Gate upload on job resolution. — `BeforeAfterUploader.tsx:247-284`; `pairs.ts:99-119`.
50. **Staging a large drop decodes every photo at full resolution in parallel** — iOS tab-kill risk (which also wipes the batch, see C7). Pool + downscaled decode for the 8×8 hash. — `BeforeAfterUploader.tsx:194`; `dedup.ts:119-146`.
51. **HEIC/undecodable images upload as fake JPEGs** — full-size originals with `contentType: 'image/jpeg'`, broken thumbnails/Studio/portal, no hash, no EXIF. Reject undecodable non-web formats. — `photos.ts:47-93`.
52. **Retry after a lost response duplicates photos and orphans storage objects** — fresh random path per attempt, no dedupe-on-insert. Deterministic path + `upsert: true`. — `photos.ts:81-122`.
53. **AI select route: no rate limit, unvalidated client URLs forwarded to Anthropic, cost-saving downscale off by default, all failures collapse to one message.** — `grow/before-after/select/route.ts:23-132`; `ai/anthropic.ts:103-163`.
54. **Studio/JobPhotos render 1600px originals as 48-176px thumbnails** with unbounded queries — tens of MB per view on mobile data. — `BeforeAfterStudio.tsx:125-160, 676-719`; `JobPhotos.tsx:126-138`.
55. **Uploader unmount cleanup revokes nothing (stale closure over `[]` deps)** — multi-MB object-URL leaks per open/stage/close. — `BeforeAfterUploader.tsx:135`.

### Dashboard, data layer & platform
56. **Weather page uses UTC "today"** — from ~5-6pm Calgary time the "Today" card shows tomorrow (labels only; the math layer is correct). Use `localTodayISO()`. — `weather/page.tsx:37`.
57. **Dashboard greeting + month windows computed in server timezone** — "Good morning" at 6pm; month stats flip hours off around month end. — `dashboard/page.tsx:37-38, 74-75`.
58. **One dashboard open fires ~25 queries with 4 duplicate full quote scans and 5 job scans** — each card owns its fetch; the shared stores aren't used here. — `dashboard/page.tsx:21-26` + card files.
59. **`invalidateAnalyticsCore()` is dead code** — zero call sites; completed jobs don't appear on Profitability/Saturation for up to 2 min and the BI/labor/suggestions caches are never invalidated by any mutation. — `analyticsData.ts:50-64`.
60. **Routes page date changes race** — the slower older request can clobber the newer date's data (yesterday's route under today's header). Sequence-guard or abort (pattern exists at `ConversationThread.tsx:48`). — `routes/page.tsx:42-105`.
61. **Data Quality duplicate detection is O(n²) on the render path** — multi-second stalls at ~1000 customers, re-run after every fix action. Index by phone/email/address maps. — `data-quality/page.tsx:113-122`.
62. **sessionStorage caches entire row sets** — quota exhaustion makes the cache layer silently no-op; hover-prefetch fills what remains. Cache computed reports; bound prefetch. — `analyticsData.ts:57`; `prefetch.ts:39-45`; `clientCache.ts:20`.
63. **Dashboard cards render nothing while loading** — sparse paint, then sections push content down one by one; the button you were about to tap moves. Skeletons for always-rendered sections. — `TodaysPriorities.tsx:174`; `WeekendOutlook.tsx:103`; `AcquisitionInsights.tsx:55`; `DashboardTopSuggestions.tsx:56`.
64. **Maps proxies: no per-user throttle or server cache on billable third-party calls** (a `road_distance_cache` table exists — unused server-side); Google `error_message` passed to the client. — `api/geocode:33-51`, `distance:21-41`, `distance-matrix:29-48`, `route:23-46`.
65. **Cron secret accepted via `?secret=` query param** on all three cron routes — leaks into access logs/history; gates money-moving and bulk-messaging endpoints. Header-only + constant-time compare. — `cron/autopay:19`; `cron/campaigns:39`; `cron/notifications:22`.
66. **RLS `auth.uid()` initplan re-evaluation** — 163 advisor warnings across ~45 tables (confirmed live): per-row evaluation degrades every large scan. Mechanical `(select auth.uid())` rewrite. — `schema.sql` all `create policy` blocks.
67. **SECURITY DEFINER trigger/helper functions retain default PUBLIC execute** (confirmed live — the known "REVOKE anon" hardening item, still open); `raw_submission` stored with no payload-size bound; public buckets (`job-photos`, `booking-uploads`, `branding`) allow **listing** all files — customer property photos enumerable; `push_config` RLS-enabled-no-policy; 3 functions with mutable `search_path`; leaked-password protection off. — `schema.sql` definer fns; `lib/intake.ts:35-64`; storage policies.

### UI consistency
68. **Two disagreeing status-color sources; the "ONE badge" is dead code** — `ui/Badge` has zero importers while legacy maps (which disagree with the tone maps on `scheduled`/`completed`) still ship, plus 87 hand-spelled tint chips across 40 files. — `ui/Badge.tsx`; `types/index.ts:283-288, 848-856`.
69. **Shell primitives built but unadopted** — `List` 0 consumers, `Menu` 1, `Tabs` 1, `Modal` 1(+ConfirmHost); three parallel menu/positioning engines (Messages inline, DayStatusMenu, NotificationBell) with divergent keyboard behavior. — `ui/*`; `DayStatusMenu.tsx:55-89`; `NotificationBell.tsx:85-146`.
70. **Touch targets well under 44px on high-frequency controls** — toast dismiss X (14px, next to Undo), DetailHeader back (16px), Modal close (28px), list checkboxes (16px), Toggle 40×24. Fix in the primitives via min hit areas. — `Toaster.tsx:46`; `DetailHeader.tsx:26-31`; `Modal.tsx:79-86`; `Toggle.tsx:24-28`.
71. **Three loading-state patterns across sibling pages** (skeleton / bare "Loading…" / nothing) — adoption stopped mid-sweep. — `measurements:35`; `quotes/new:258`; `notifications:79`; `TodayJobs.tsx:53` et al.
72. **Native `confirm()`/`alert()` persist** — including the customer-facing portal (which lacks ConfirmHost/Toaster mounts entirely). — `portal/[token]/page.tsx:160-162, 846, 1006`; `PaymentMethodCard.tsx:68`; `JobPhotos.tsx:85`.
73. **Hover-revealed / title-only affordances invisible on touch+keyboard** — QuoteList row Delete (focusable while invisible), icon-only row-open nested `<Button>` inside `<Link>`, title-only status-pill behaviors. — `QuoteList.tsx:282, 296-313`; `invoices/page.tsx:385-399`.
74. **Fixed bottom overlays ignore safe-area insets in the installed PWA** — the toast's Undo and modal footer buttons can sit behind the iOS home indicator (InstallPrompt already does it right). — `Toaster.tsx:24`; `Modal.tsx:58`.
75. **CustomerPicker/CommandPalette combobox gaps** — Enter both opens the list and submits the form; slug-id label collisions; missing `aria-activedescendant`/listbox roles; palette results for invoices/jobs/messages navigate to list pages, not the record; JobForm still uses the plain `<select>` CustomerPicker was built to replace. — `CustomerPicker.tsx:34, 77-99`; `CommandPalette.tsx:64-251`; `JobForm.tsx:404-407`.

---

## LOW

1. Portal token entropy rests on the 8-char suffix (~39 bits) with no throttle/expiry on `get_portal_data` — acceptable, add throttling for defense-in-depth. — `lib/portal.ts:14-56`.
2. `portal/setup-card` mints orphan Stripe customers when the service-role key is absent (silent `if (svc)` skip). — `portal/setup-card/route.ts:29-31`.
3. `record_booking_measurement` accepts an arbitrary `p_quote_id` (integrity, not exposure). — `schema.sql:1420-1436`.
4. JobForm's duplicate-series check uses UTC "today" (evening off-by-one). — `JobForm.tsx:313`.
5. Monthly recurrences anchored on the 29th–31st drift permanently to the 28th (iterative stepping). — `recurrence.ts:9-13, 30-38`.
6. DaySettingsBar time inputs fire a DB upsert + full reload per change event (out-of-order races on slow connections); debounce/commit-on-blur. — `DaySettingsBar.tsx:96-105`.
7. Nested `<button>` inside calendar day-cell `<button>` — invalid markup, SR noise. — `Calendar.tsx:293-330`.
8. Customer list search ignores phone and address ("who called me?" fails) though CustomerPicker matches both. — `CustomerList.tsx:65-69`.
9. CommsHealth inline add email/phone saves with zero format validation ("asdf" clears the warning). — `CommsHealth.tsx:39-48`.
10. Non-EXIF photos get `taken_at = upload time` (ordering + dedup miss for late bulk uploads); EXIF parser bails on the first APP1 segment even when it's XMP. — `exif.ts:36-48, 136-140`; `photos.ts:105-107`.
11. Hover-only remove/dismiss controls invisible on touch (staged-photo X, tray dismiss X). — `BeforeAfterUploader.tsx:484-486`; `UploadQueueWidget.tsx:81-85`.
12. Uploader drop zone not keyboard-openable; JobPhotos lightbox lacks Escape/focus handling (and uses native confirm). — `BeforeAfterUploader.tsx:366-376`; `JobPhotos.tsx:142-179`.
13. JobPhotos optimistic remove/retag/caption never check results — offline edits silently revert; row deleted before storage with neither checked. — `JobPhotos.tsx:84-102`; `photos.ts:135-147`.
14. Studio "All platforms" batch download can silently save only the first file (Chrome multi-download gate); ZIP or sequential. — `BeforeAfterStudio.tsx:443-461`.
15. PWA `themeColor` hardcoded dark — light-mode users get a dark status bar. — `layout.tsx:31-36`.
16. Tabs: tablist semantics without arrow-key nav or `aria-controls`/tabpanel wiring; Menu trigger missing ArrowDown-to-open. — `Tabs.tsx:28-46`; `Menu.tsx:31-35`.
17. Ad-hoc empty states drift from InlineEmpty/EmptyState (QuoteList, JobPhotos). — `QuoteList.tsx:252-255`; `JobPhotos.tsx:124`.
18. No app-wide offline indication despite PWA (upload tray has the listener pattern to reuse). — `sw.js:29-31`; `UploadQueueWidget.tsx:22-24`.
19. Two shared "local today" helpers + five private copies (the exact drift class behind the UTC bugs); orphaned `MissedJobs`/`FollowUpQuotes` components with live fetch/mutation logic; StatsGrid shows the same number in two tiles; Profitability weeks start Sunday, splitting a Fri-Sun work week. — `lib/utils.ts:32`; `lib/geo.ts:13`; `MissedJobs.tsx`; `StatsGrid.tsx:22-51`; `profitability/page.tsx:115`.
20. Campaign cron `.in()` with up to 2000 UUIDs (~70KB URL) can be gateway-rejected. — `cron/campaigns/route.ts:96-100`.

---

## Verified solid (no action needed)

- **Stripe webhook:** raw-body signature verification, 5-min replay window, timing-safe compare; idempotent upserts on `stripe_session_id`; DB-write failures return 500 so Stripe retries (the 7df1173 payment-loss fix holds); refund/dispute branches guarded.
- **Twilio inbound:** HMAC verified timing-safe, fails closed, idempotent on `MessageSid`, never 500s Twilio into a retry storm.
- **Cron routes:** require `CRON_SECRET`, 403 when unset (fail closed), no-op safely on missing env.
- **Owner API routes:** all authenticate and scope by `user_id`; charge amounts always recomputed server-side.
- **Ledger engine:** discount math ($ capped at gross, % at 100), quote→job conversion avoids double-counting extras, `sent_at` stamped once, follow-up double-tap guards.
- **Scheduling:** the per-day capacity engine is correctly consumed by DaySettingsBar/Day Ops/planRainDelay/metrics (gaps only in the optimizer search cost + RainDelayCenter manual paths, filed above); optimizer cadence hard constraints + pre-apply revalidation sound; day-status writes optimistic-with-reconcile.
- **Realtime hook (`useRealtime.ts`):** unique channels, debounce, cleanup, wake-refetch — no leaks in any subscriber.
- **CRM:** cron respects archived + opt-outs; `last_contacted_at` trigger correct; referral bridging idempotent; archive undo genuinely reverts.
- **Uploads:** auto-pair idempotency DB-backed; canvas CORS correctly avoided; analyze-pipeline races guarded by `analyzeSeq`; photo-dedup migration degrades gracefully.
- **Theme:** pre-hydration script prevents flash; Input/Select/Textarea label association correct; data tables have overflow wrappers; no 375px layout breaks found.

---

## Recommended fix order

**Wave 1 — before any real customer transacts (days):** C1–C7, H1–H6 (money), H10 (double-sends), H16 (inbound webhook URL). Run immediately (safe, webhook keeps service_role):

```sql
revoke execute on function public.find_customer_by_phone(text) from public, anon, authenticated;
```

**Wave 2 — before/at launch (week):** H7–H15, H17–H27 (workflow corruption, scale correctness, public-surface throttles, upload reliability), Medium #65 (cron secret), #67 (REVOKE sweep + bucket listing policies), #1–#9 (payments mediums).

**Wave 3 — the already-planned app-wide polish pass:** H28–H31 (dialog/a11y/tone-token/keyboard) + the UI-consistency and loading-state mediums — these fold naturally into the deferred `final-launch-polish-pass`, now with a concrete file-level worklist.

**Wave 4 — scale hygiene:** RLS initplan rewrite (#66), unbounded-query sweep beyond the Critical/High surfaces, unindexed FKs, dead-code deletion (Badge/List adoption, MissedJobs/FollowUpQuotes, duplicate helpers).