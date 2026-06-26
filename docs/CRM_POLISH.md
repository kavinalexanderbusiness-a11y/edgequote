# CRM Premium Polish Pass

**Date:** 2026-06-26 · **Branch:** `feature/crm-automation` · **Scope:** no new features — quality only.
**Build/typecheck:** `tsc --noEmit` exit 0; `next build` exit 0.

Goal: make the existing CRM surfaces feel polished, premium, and effortless at scale (hundreds of paying customers). Every change is UX / accessibility / consistency / loading-empty-state quality. No new functionality, no schema/data changes. Frozen pricing files and other agents' in-progress files were not touched.

Files changed (all CRM-owned, plus one additive shared-primitive prop):
`components/ui/Toggle.tsx`, `components/customers/ReviewLifecycle.tsx`, `components/customers/ReferralPanel.tsx`, `components/grow/CampaignManager.tsx`, `components/grow/FollowUpRadar.tsx`, `app/dashboard/grow/crm/page.tsx`.

---

## By goal

### Remove duplicate UI / merge duplicated components
- **CampaignManager enable/disable switch → shared `Toggle`.** Was a hand-rolled `w-11 h-6` switch — the 2nd–3rd copy of that markup in the app. Now uses `components/ui/Toggle`, so the toggle look + a11y is defined once. (The Settings `AutomationToggles` still hand-rolls its own; it's non-CRM and left for a future cleanup — noted, not touched.)
- **Form controls → design-system primitives.** Hand-rolled `<input>/<select>/<textarea>` across ReferralPanel, ReviewLifecycle, and CampaignManager replaced with the shared `Input` / `Select` / `Textarea`. One input look, one focus treatment, everywhere.
- **Empty states → shared `InlineEmpty`.** ReferralPanel, CampaignManager, and FollowUpRadar each had a bespoke `<p className="…text-center…">`. Now one primitive with a consistent icon + spacing.
- **(Earlier, committed `efd0280`) the `Menu` primitive** replaced the campaign "New" dropdown's bespoke absolute div — now reusable app-wide.

### Improve loading states
- **Skeletons instead of spinners / blank panels.** CampaignManager and FollowUpRadar now render row-shaped skeletons while loading (no spinner, no layout jump when data lands). 
- **No more "flash of empty/zero."** ReferralPanel previously flashed *"No referrals tracked yet"* before its query resolved; it now shows skeleton rows until loaded. The CRM hub's Reviews/Referrals rollups previously rendered **0 / 0 / 0** on first paint — now skeletons until the counts arrive (and the "avg ★" pill is hidden until loaded).

### Improve empty states
- All CRM empty states use `InlineEmpty` with a meaningful icon and copy that says what to do next ("record who they send your way", "tap New to add a campaign", "everyone's been contacted recently — nothing to chase").

### Improve accessibility
- **Icon-only buttons now have `aria-label`** (were `title`-only, which screen readers don't reliably announce): ReferralPanel row actions (join/decline/reward/remove, named with the person), CampaignManager delete, the CRM-hub back button.
- **Live region** for the review-request result: `role="status" aria-live="polite"` so "Review request sent / not sent" is announced.
- **Star rating** is now a real `radiogroup` (`role="radio"` + `aria-checked`); the read-only display stars expose `role="img"` with an "N of 5 stars" label.
- **Toggle / segmented controls** expose state: campaign toggle (`Toggle` `role="switch"`), channel pills (`aria-pressed`), radar threshold pills (`aria-pressed` + `role="group"`).
- **Disclosure semantics:** the campaign row and the radar "show all" expose `aria-expanded`.
- **Visible keyboard focus** (`focus-visible:ring-2 ring-accent/40`) added to every interactive element that lacked it — menu items, toggles, pills, row links, icon buttons, the back button. (The shared `Menu` already ships full keyboard nav.)
- Referral list is now a semantic `<ul>/<li>`.

### Improve mobile responsiveness
- **No more iOS zoom-on-focus.** All replaced inputs use the design-system `text-base sm:text-sm` (16px on phones); the inline campaign-schedule number/`select` inputs were bumped to the same via a shared `NUM_INPUT` class (they were 14px → caused Safari to zoom).
- **Bigger touch targets:** icon action buttons `p-1.5 → p-2`; channel + threshold pills `py-0.5 → py-1/1.5`.
- **Layouts wrap on narrow screens:** the campaign schedule rows (birthday/anniversary/win-back) are now `flex-wrap`; the campaign editor indent is `pl-0 sm:pl-12` (full width on phones instead of a wasted 48px gutter).

### Improve review / referral flows
- Review outcome capture uses labeled `Select` (source) + `Input[type=date]` with a live `aria-live` send result; stars are keyboard-operable.
- Referral actions are clearer and named per-person for assistive tech; the panel no longer flickers an empty state during load.

### Improve campaign UX
- Premium loading skeletons; standardized, labeled, mobile-safe editor fields; `aria-pressed` channel pills; the enable switch matches the rest of the app.

### Improve messaging UX
- Within CRM scope, the review-request send now announces its outcome (success / "not connected" / "no consent") via a polite live region instead of a silent state change. (The Messages **inbox** is not CRM-owned and was intentionally left untouched.)

### Reduce clicks / simplify workflows
- The existing CRM flows were already short (create-from-preset opens the editor in one step; enable is an inline toggle; review/referral outcomes are recorded inline). No artificial steps were found to remove **without adding features**, so this pass focused on making those one- and two-tap flows feel solid and predictable (consistent controls, instant skeletons, clear focus) rather than re-routing them. The biggest real click/availability win — making the clipped "New" menu usable — shipped in the prior commit `efd0280`.

### Improve performance
- Assessed; **no change required.** The CRM surfaces are already lean: realtime runs over the shared multiplexed socket (`useRealtimeRefresh`), rollup counts use `head:true`/`count:'exact'` (no row payloads), and lookups hit indexed columns added in `RUN-2026-06-25h`. Skeletons replace spinners at equal cost. No N+1s or unbounded fetches were introduced or found in the CRM components.

---

## Per-file summary

| File | Changes |
|---|---|
| `ui/Toggle.tsx` | + optional `ariaLabel` + `disabled` props, focus ring (additive, backward-compatible). |
| `customers/ReviewLifecycle.tsx` | `Select`/`Input` for source+date; `aria-live` send status; radiogroup stars; `Button`-ified actions. |
| `customers/ReferralPanel.tsx` | loading skeleton; `Input` form fields; `InlineEmpty`; `aria-label`ed actions; `<ul>` semantics; bigger targets + focus rings. |
| `grow/CampaignManager.tsx` | shared `Toggle`; skeleton loading + `InlineEmpty`; `Input`/`Textarea`; mobile-safe wrapping schedule inputs; `aria-pressed` pills; `aria-expanded`/`aria-label` on row + delete; mobile editor width. |
| `grow/FollowUpRadar.tsx` | skeleton loading; `InlineEmpty`; `aria-pressed`/`role=group` threshold pills; focus rings; `aria-expanded` show-all. |
| `grow/crm/page.tsx` | rollup loading skeletons (no zero-flash); guarded avg pill; back-button `aria-label` + focus ring. |

## Not touched (deliberately)
- Frozen pricing files (`servicePricing.ts`, templates editor pricing, etc.).
- Other agents' in-progress files (Before/After, property-intelligence, `anthropic.ts`).
- Shared `types/index.ts`, `schema.sql`, `grow/page.tsx` — left until Marketing Studio / AI Vision merge.
- Messages inbox + Settings AutomationToggles — outside CRM ownership.
