# EdgeQuote → Multi-Industry Field Service Platform

**Architecture review — 2026-07-15.** Design only. Reconciled against `origin/main` at the time of writing. No rebuilds; every item below reuses an existing engine.

## Thesis

EdgeQuote does not need to become a multi-industry platform. It **already is one** — it just has lawn-care defaults welded into a handful of places where they should be data. The work is *configuration hardening*, not re-architecture. Two independent audits and a live-schema check agree: **37 of 40 `business_settings` columns are already industry-neutral, `service_templates` already is the neutral service catalogue, and `DEFAULT_TEMPLATES` contains zero lawn words.** The gap between "lawn app" and "field-service platform" is roughly a dozen small changes, most of which are one file each.

The requirements are already met at the architecture level: one codebase, one UI, one scheduling engine (algorithmic, in `lib/dayStatus` + routing), one CRM, one payments ledger, one automation engine, one AI engine (`lib/ai/assist.ts` + the marketing gateway). None of them need a second implementation for a new trade. Industry difference is expressed through **configuration** (`business_settings`), **capabilities** (the `modules.ts` registry + `enabled_modules`), **service templates** (`service_templates` with 6 `pricing_display_type`s), and now **seasonality** (`service_seasons`) — never through a fork. *(Canonical home for this "one engine per responsibility" principle: PRODUCT-VISION.md §5.1.)*

**The one principle that keeps it that way:** a trade is *data the business already gave us* (their service names, their templates, their seasons), never a fact the code assumes or an enum the code branches on. Every item below moves one hardcoded assumption into that data.

---

## What is already neutral (do NOT touch)

- **`service_templates`** — owner-defined `name`, free-text `category`, `default_rate`, and `pricing_display_type` ∈ {`starting_from`, `hourly`, `per_sqft`, `per_linear_ft`, `starting_from_materials`, `hourly_materials`}. A window cleaner, a pool company, and a pressure washer all express their pricing model today with zero code change. **This file is the model the rest of the app should copy.**
- **`business_settings.message_templates`** — sparse jsonb overriding every message; all 26 defaults are overridable and already neutral.
- **`modules.ts` + `enabled_modules`** — the capability registry. Nav renders from it filtered per-business; a trade turns features on/off here. Add a module = one registry entry.
- **`business_type` column** (shipped `acd2384`, phase 1) — the business can now *state* its trade. This is a labelling/telemetry seam and a future default-seeder — **it must never become a branch point.** No engine should ever read `business_type` and change behaviour; that would re-introduce the fork this whole effort removes.
- **`pricing_mow_rate`** — a NAME, not a semantic (`mowRatePer1000` = "$ per 1,000 ft²"). Welded to the public `get_booking_business` RPC. **Relabel the UI, never rename the column.**
- **`lawn_sqft` / `front_lawn_sqft` / `back_lawn_sqft`** — 74 refs and returned by `get_portal_data`, a SECURITY DEFINER RPC whose shrinking `pg_get_functiondef` length is a known regression tripwire. It's a measured area; **rename the label the model/UI sees, never the column.**

---

## Already shipped by parallel work (reconciliation)

This effort is being executed incrementally on `main`. Landed as of this writing:

- **Send-path & chrome neutrality** — `9bbbc12`, `05fcdee`, `eb72d3e` (the `company_name` DB default is now `''`, not `'Edge Property Services'`; every customer-facing fallback routes to the neutral `'your service provider'`; Sidebar reads `company_name`).
- **AI trade-neutrality** — the assist engine (`a1c426b`: customer summaries, drafts, review replies, quote scope, job notes now read the trade from context via a shared `TRADE` rule) and the marketing gateway (`b158990`, `02f2d0b`, `7735800`). Both fail safe: no trade in context → generic wording, never a guess.
- **Business-type column** — `acd2384`.

---

## Ranked change list

Ranked by **blast radius of the defect**, not effort. P0 is a silent money/retention correctness bug; the rest are progressively cosmetic.

### ✅ P0 — Seasonality engine is trade-blind → reactivation false-flags *(DONE in this change)*

`lib/seasons.ts` mapped a service to its season by **hardcoded English lawn/snow keywords**. A genuinely seasonal non-lawn trade (pool opens in spring, pest ramps in summer) matched nothing → fell to `year_round` → no season-end date → the reactivation/health engines could not distinguish *"their season ended naturally"* from *"we lost them"*, and flagged every off-season customer as lapsed. **17 consumers** depend on this engine. tsc and build both pass with the bug present, because a wrong season is a wrong *value*, not a type error.

**Fix (shipped here, zero migration):** an owner-defined `match` keyword list on a season now resolves it, so any trade declares its own season through the **existing `service_seasons` jsonb** — no industry picker, no schema change. `seasonForService` consults custom seasons first, then falls back to the untouched lawn/snow hint logic (snow-before-lawn priority preserved exactly). `settingsToSeasons` now **carries through custom season keys** (it silently dropped anything but lawn/snow before). Proven by `npm run verify:seasons` — 20 checks: lawn byte-for-byte unchanged, pool now seasonal with a real end date, plumber correctly seasonless, legacy data identical.

**Immediate follow-on (NOT in this change — see P1):** the Settings UI still only edits the two built-in seasons, so an owner can't yet *add* a custom season from the app. The engine is ready the moment they can.

### P1 — Let an owner define a custom season in Settings

The engine now honours custom seasons; the Settings editor (`dashboard/settings/page.tsx`, ~line 515) still renders exactly two hardcoded editors (`seasons.lawn`, `seasons.snow`). **Reuse** the existing season-editor component in a map over `Object.entries(seasons)` + an "Add season" row (label, keywords, date anchors) that writes a new key into the same `service_seasons` jsonb. No migration. This is what makes P0 reachable in production; it's ranked below P0 only because the engine correctness is the load-bearing half.

### P2 — Product chrome that tells a non-lawn business it's a lawn app

- **`CAMPAIGN_KINDS.seasonal.blurb`** = *"spring cleanups, fall aeration, snow bookings"* — un-overridable UI text; the single most on-the-nose place the product outs itself. 2-line fix. `referral.blurb` *"refer a neighbour"* → *"refer someone"*.
- **No blank `kind:'seasonal'` campaign preset** — the only route to a seasonal campaign is clicking "Fall cleanup & aeration" and rewriting it. Add one `CAMPAIGN_PRESETS` row with no `custom_body` (falls through to the neutral `seasonal_offer` default); `saveAsPreset` then lets a pool company keep "Pool opening" forever.

### P3 — Closed catalogue constants that cage non-lawn trades

- **`SERVICE_CATEGORIES`** (`types/index.ts:941`) — a closed 6-item dropdown; pool/pest/handyman file everything under "General". The DB column is already free `text` — **the constant is the cage.** Derive the options from `DISTINCT service_templates.category` + allow free entry. No migration.
- **Booking funnel** hardcodes `'Lawn Mowing'` + sqft-only pricing (`BookingClient`). A `public_services` RPC and the template catalogue already exist — let booking pick from them.
- Residual `'Lawn Mowing'` literals in `JobForm` / `quotes/new` / `leads.ts` seeds — derive from the first active `service_templates` row (the pattern `9bbbc12` already established for quick-add).

---

## Explicitly out of scope (churn with a regression tripwire)

- **Do NOT generalise `suggestions.ts` lawn↔snow cross-sell** (~15 refs). It's an industry *insight*, not a blocker; it degrades silently (just won't fire for a pool co). Separate, larger piece.
- **Do NOT rename** `pricing_mow_rate`, `lawn_sqft`, or the season keys `lawn`/`snow` — all welded to public RPCs; relabel UI/prompt text instead.
- **Do NOT make `business_type` a branch point** — it labels, it may seed defaults, it never changes engine behaviour.
- `SERVICE_TYPES` + `OVERGROWTH_LEVELS` (`types/index.ts`) are dead (zero importers) — delete, don't "fix".

---

## Why this is the strongest long-term shape

Every industry difference lands in one of four owner-editable surfaces — **configuration** (`business_settings`), **capabilities** (`modules.ts`/`enabled_modules`), **service templates** (`service_templates`), **seasonality** (`service_seasons`) — and every engine reads those surfaces instead of asking "what industry is this?". Adding the 17th trade is then a data exercise (the owner names their services and seasons), not an engineering one. The app never grows an industry `switch`, so it never grows N codepaths to keep in sync. That is the difference between a platform and a pile of forks.
