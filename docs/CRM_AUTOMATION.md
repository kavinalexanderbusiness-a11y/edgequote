# CRM Automation — Integration Document (FROZEN)

**Status:** Feature-complete & frozen as of 2026-06-26. Migration applied + verified in production.
**Commit:** `f7f293f7cafc02c635e0d34514ff5ec59a113737` ("Describe what you changed") on `main` / branch `feature/crm-automation`.
> ⚠️ The work was bundled by a parallel multi-agent run together with Before/After Studio, AI property-intelligence, and the Marketing-Manager migration. This document lists **only the CRM-Automation pieces**.

Scope delivered: review lifecycle, referral tracking, follow-up radar ("needs follow-up" / "not contacted in X days"), and a unified campaign engine (birthday / anniversary / win-back / recurring broadcast). Everything reuses the **one** comms pipeline (`messages` / `conversations` / `notification_log`), the existing review flag (`customers.reviewed_at`), and the existing `referred_by_customer_id` link. **No customer data is duplicated.**

---

## 1. Files added (11)

| File | Purpose |
|---|---|
| `src/lib/crm/reviews.ts` | Pure review-status derivation (`reviewStatus`, `REVIEW_STATUS_META`, `REVIEW_SOURCES`, `canAskForReview`). |
| `src/lib/crm/campaigns.ts` | Pure campaign helpers: `CAMPAIGN_KINDS`, `CAMPAIGN_PRESETS`, `campaignPeriodKey`, `dateFieldFiresToday`, `broadcastFiresToday`, `describeSchedule`. |
| `src/lib/crm/radar.ts` | `loadFollowUpRadar()` — computes "needs follow-up" + "not contacted in X days" from `last_contacted_at` + conversations. |
| `src/lib/comms/dispatch.ts` | `dispatchToCustomer()` — shared per-channel consent gating + message threading, used by the campaigns cron (mirrors `/api/comms/send`). |
| `src/app/api/cron/campaigns/route.ts` | Daily campaign cron (NEW API route). |
| `src/app/dashboard/grow/crm/page.tsx` | "Customer Automation" hub (review + referral rollups, radar, campaign manager). |
| `src/components/customers/ReviewLifecycle.tsx` | Per-customer review pipeline panel (profile). |
| `src/components/customers/ReferralPanel.tsx` | Per-customer referral tracker (profile). |
| `src/components/grow/CampaignManager.tsx` | Unified campaign create/edit/enable UI. |
| `src/components/grow/FollowUpRadar.tsx` | Follow-up radar panel. |
| `supabase/RUN-2026-06-25h-crm-automation.sql` | The migration (idempotent; mirrored into `schema.sql`). |

## 2. Files modified (9) — ⚠️ shared-file merge surface marked

| File | Change | Shared? |
|---|---|---|
| `src/types/index.ts` | `Customer` CRM fields; `CustomerFormValues` birthday/anniversary; new `Referral`, `CampaignKind`, `CrmCampaign` types. | ⚠️ **SHARED** |
| `supabase/schema.sql` | Appended the full CRM migration section (mirror). | ⚠️ **SHARED** |
| `src/app/dashboard/grow/page.tsx` | Added "Customer Automation" entry card. | ⚠️ **SHARED** |
| `src/lib/comms/templates.ts` | Added `birthday`/`anniversary`/`win_back`/`marketing` MsgTypes + `renderBody()` helper. | ⚠️ shared (low risk) |
| `vercel.json` | Added the campaigns cron entry. | ⚠️ shared (low risk) |
| `src/app/api/cron/notifications/route.ts` | Review request now also skips when `review_declined_at` is set. | low risk |
| `src/app/dashboard/customers/[id]/page.tsx` | Mounted `ReviewLifecycle` + `ReferralPanel`; birthday/anniversary chips; removed the old inline referrals card. | CRM-owned |
| `src/app/dashboard/customers/page.tsx` | Normalize + edit-default birthday/anniversary. | CRM-owned |
| `src/components/customers/CustomerForm.tsx` | Birthday + anniversary date inputs. | CRM-owned |

## 3. Migration

**`supabase/RUN-2026-06-25h-crm-automation.sql`** (idempotent/additive; 42 guard clauses; mirrored at the end of `schema.sql`, lines ~2782+). Applied + verified in prod.

> **Migration label note:** three files share the `2026-06-25h` date label (`-crm-automation`, `-ai-property-intelligence`, `-marketing-manager`) — distinct filenames, no SQL collision. Only the CRM file touches `customers` columns / `referrals` / `crm_*`. Apply order is irrelevant (all additive + idempotent).

**Columns added to `customers`:** `review_requested_at`, `review_source`, `review_rating`, `review_declined_at`, `birthday`, `anniversary`, `last_contacted_at`.

**Tables created:** `referrals`, `crm_campaigns`, `crm_campaign_log`.

**Indexes / constraints:** `referrals_user_idx`, `referrals_referrer_idx`, `referrals_referred_idx`, `referrals_link_uniq` (partial unique on `(referrer_customer_id, referred_customer_id) where referred_customer_id is not null`), `crm_campaigns_user_idx`, `crm_campaign_log_campaign_idx`, `crm_campaign_log_customer_idx`, **unique `(campaign_id, customer_id, period_key)`** on `crm_campaign_log` (the dedupe guarantee).

**RLS:** owner-only — 4 policies each on `referrals` + `crm_campaigns`; select+insert on `crm_campaign_log` (10 total).

**Realtime publication adds:** `referrals`, `crm_campaigns`, `crm_campaign_log`.

**One-time backfills:** `customers.last_contacted_at` from outbound `messages`; `referrals` rows from existing `referred_by_customer_id` links (both idempotent).

## 4. Functions (SECURITY DEFINER)

| Function | Type | Notes |
|---|---|---|
| `crm_stamp_review_requested()` | new | Stamps `review_requested_at` on a sent `review_request`; guarded `where reviewed_at is null and review_declined_at is null`. |
| `crm_touch_last_contacted()` | new | Sets `last_contacted_at` on OUTBOUND messages only (forward-only `greatest`). |
| `crm_sync_referral()` | new | Bridges `referred_by_customer_id` → a `joined` `referrals` row (idempotent upsert). |
| `portal_mark_reviewed(text)` | redefined | Now also sets `review_source = coalesce(..,'Google')`. Behaviour otherwise unchanged. |
| `set_updated_at()` | reused | Created only if missing (fallback). |

## 5. Triggers

| Trigger | Table | Event |
|---|---|---|
| `trg_crm_stamp_review_requested` | `notification_log` | AFTER INSERT |
| `trg_crm_touch_last_contacted` | `messages` | AFTER INSERT |
| `trg_crm_sync_referral` | `customers` | AFTER INSERT OR UPDATE OF `referred_by_customer_id` |
| `trg_referrals_updated` | `referrals` | BEFORE UPDATE (`set_updated_at`) |
| `trg_crm_campaigns_updated` | `crm_campaigns` | BEFORE UPDATE (`set_updated_at`) |

> The pre-existing `trg_notify_review_received` (on `customers.reviewed_at`) is **unchanged** and still fires the in-app/push notification.

## 6. API routes

| Route | Status | Notes |
|---|---|---|
| `GET /api/cron/campaigns` | **NEW** | Daily campaign engine. Auth via `CRON_SECRET`; service-role; no-ops without comms creds; processes **only `enabled` campaigns**. |
| `GET /api/cron/notifications` | **modified** | Review requests now skip `review_declined_at` customers too. |
| `POST /api/comms/send` | reused | Called by `ReviewLifecycle` for "Send review request"; stamps Requested via the `notification_log` trigger. |

All owner CRUD (recording referrals, creating/editing/enabling campaigns, marking reviewed/declined, editing birthday/anniversary) goes through the **Supabase client under RLS** — **no new API routes**.

## 7. Crons (`vercel.json`)

| Path | Schedule | Status |
|---|---|---|
| `/api/cron/campaigns` | `0 15 * * *` (≈9 AM MT) | **NEW** |
| `/api/cron/notifications` | `0 14 * * *` | existing (handler modified) |

## 8. Dependencies

- **npm:** none added (`package.json` unchanged). Reuses `next`, `react`, `@supabase/supabase-js`, `lucide-react`, `react-hook-form`.
- **Internal libs:** `lib/comms/{send,templates,conversation,skipReasons}`, `lib/comms/dispatch` (new), `lib/portal` (`ensurePortalToken`/`portalUrl`), `lib/followup` (`daysSince`), `lib/utils`, `hooks/useRealtime`, `components/ui/*`, `components/layout/PageHeader`.
- **DB prerequisites (must pre-exist):** tables `customers`, `messages`, `conversations`, `notification_log`, `business_settings`, `customer_portal_tokens`, `job_recurrences`; the `uuid-ossp` extension (`uuid_generate_v4`); the `supabase_realtime` publication.
- **Env (all pre-existing — none new):** `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM`, `RESEND_API_KEY`/`RESEND_FROM`, `NEXT_PUBLIC_APP_URL`.

## 9. Behavioral guarantees (verified 2026-06-26)

1. Campaigns ship **disabled** (`enabled default false`); cron filters `.eq('enabled', true)`.
2. Every send passes per-customer `sms_opt_in` / `email_opt_in` via `dispatchToCustomer`.
3. Dedup = in-cron `period_key` pre-check **and** the DB unique constraint.
4. Review asks stop after `reviewed_at` OR `review_declined_at` (trigger guard + notifications-cron skip).
5. Referral tracking works for existing customers (backfill + trigger) and new ones (insert trigger).
6. Build + typecheck clean.

---

## Merge checklist

Do this when integrating the `feature/crm-automation` work alongside **Marketing Studio**, **AI Vision**, and the **pricing display fix**. (CRM already lives in `f7f293f` on `main`; this checklist governs reconciling the **shared files** as the other features land.)

### Before merging
- [ ] Confirm the three pending features (Marketing Studio, AI Vision, pricing display fix) are merged FIRST.
- [ ] `git fetch` + start from the latest `main`.
- [ ] `npm run typecheck` → clean.
- [ ] `npm run build` → clean.

### Reconcile shared files (keep ALL sections — these are additive)
- [ ] `src/types/index.ts` — keep CRM types (`Customer` CRM fields, `Referral`, `CampaignKind`, `CrmCampaign`, `CustomerFormValues` birthday/anniversary) **and** any types the other features add.
- [ ] `supabase/schema.sql` — keep every appended migration section (CRM + AI Vision + Marketing Studio + pricing). Order doesn't matter; never drop a section.
- [ ] `src/app/dashboard/grow/page.tsx` — keep all entry cards (Customer Automation + Before/After + any new ones).
- [ ] `src/lib/comms/templates.ts` — keep the 4 CRM MsgTypes + `renderBody` alongside any other template additions.
- [ ] `vercel.json` — keep all cron entries (`campaigns`, `notifications`, `autopay`, …).
- [ ] `src/app/api/cron/notifications/route.ts` — keep the `review_declined_at` skip.

### Database
- [ ] Confirm `RUN-2026-06-25h-crm-automation.sql` is applied to prod (it is — re-running is a safe no-op).
- [ ] Confirm the other `2026-06-25h` migrations (`-ai-property-intelligence`, `-marketing-manager`) are also applied/tracked.
- [ ] `get_advisors` (security + performance) after all DDL lands.

### Post-merge smoke tests
- [ ] `/dashboard/grow/crm` loads; rollups + radar + campaign manager render.
- [ ] Create + enable a Birthday campaign; confirm it persists.
- [ ] Customer profile: set a birthday + a review ★ rating; chips + counts update.
- [ ] `GET /api/cron/campaigns?secret=$CRON_SECRET` → `{ ok: true, campaigns, processed, sent }`.
- [ ] A sent campaign appears as an outbound bubble in the customer's Messages thread + comms history.

### Sign-off
- [ ] Campaigns remain disabled by default after deploy (no unsolicited sends).
- [ ] Consent + dedup confirmed in a live test send.
- [ ] Tag/record the merge commit.
