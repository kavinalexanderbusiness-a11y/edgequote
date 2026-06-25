# UX Consistency Pass — Handoff

Branch: `ux-consistency-pass` (worktree at `../edgequote-ux`), branched from the
last clean commit `a94ffcc`. **Does not touch** the uncommitted AutoPay/Stripe/
scheduler work in the main worktree.

## What this is
A pure front-end consistency + polish pass. The app already had a real design
system; adoption was uneven. This makes every screen draw from one set of
primitives so EdgeQuote feels like one application.

- **Net effect:** 40 files, +1019 / −771 (much of the "+" is the new shared
  primitives; page code shrank as per-page `Stat`/`Tile`/`Metric`/`Section`/
  `Empty` reimplementations were deleted).
- **Compiles clean:** `npx tsc --noEmit` and `npx next build` both pass.

## Deploy / migrate
- **SQL migrations: none.**
- **Env vars: none.**
- **Manual setup: none.**
- This is presentation-only — no schema, API, or data-flow changes.

## How to ship it
1. Review the branch: `git log a94ffcc..ux-consistency-pass` (7 commits).
2. Merge into your release flow once the AutoPay branch is settled, OR
   cherry-pick the commits. There are no migrations to coordinate.
3. Re-run `npm run build` after merging (the AutoPay work changes other files;
   a post-merge build confirms no overlap regressions — the only files in both
   areas are intelligence/labor-intelligence/QuoteBuilder/settings, which this
   branch rewrote from the clean base).

## New shared primitives
- `src/lib/tone.ts` — semantic tone tokens (success/warn/danger/info/accent/neutral), mirrors the status maps in `types/index.ts`.
- `ui/StatTile.tsx` — the one KPI tile (replaces ~8 per-page tiles; supports `tone`, `accent`, `delta`).
- `ui/FilterPill.tsx` — one filter/segment pill.
- `ui/Banner.tsx` — one inline toast/alert/undo (tone + dismiss).
- `ui/SectionHeading.tsx` — one in-card/section heading.
- `ui/Tabs.tsx` — horizontal tab strip (used by tabbed Settings).
- `ui/Skeleton.tsx` — added `PageSkeleton` (one whole-page loading look).
- `ui/EmptyState.tsx` — added `InlineEmpty` (compact in-card empty).
- `layout/BrandHeader.tsx` — shared brand header for book + portal.
- `ui/Menu.tsx` — `menuSurface` + `menuItemClass` + `<MenuItem>` (one look for
  every dropdown/popover/context menu) + the `.animate-pop` entrance.

## Highlights
- **Loading:** ~17 pages had bespoke "Loading…" text / spinners / blank `null`.
  All now use `PageSkeleton`/`SkeletonRows`/`SkeletonTiles` — one premium look.
- **Empty states:** were hand-rolled everywhere (only `properties` used the
  primitive). Now `EmptyState` (page) / `InlineEmpty` (in-card) throughout.
- **Stat tiles:** the same KPI tile, reimplemented ~8 ways, is now one `StatTile`.
- **Settings:** the long scroll is now tabbed (Business / Pricing & Fees /
  Scheduling / Messaging / Notifications / Booking) with one sticky Save.
- **Public pages:** book + portal share one `BrandHeader`, branded skeleton
  loaders, and an `EmptyState` for invalid links — one brand for customers.
- **Tokens/type/icons:** killed `bg-black`, `bg-accent-dim`, `accent-[rgb()]`,
  invalid `w-4.5`, and emoji-used-as-icons (→ lucide).

## Pass 2 — design-system finish
- **Menus & popovers:** notification popover, address autocomplete, message
  follow-up + kebab menus, and the command palette all now share `menuSurface`
  (elevated raised surface, `border-strong`, soft shadow, `.animate-pop`,
  `hover:bg-surface`). They were `rounded-card/xl/2xl` + `shadow-2xl/xl` +
  `hover:bg-surface/40/50/60` before — now identical.
- **Forms:** `Input`/`Select`/`Textarea` gained a consistent required asterisk
  and disabled state; required fields marked on the Customer + Service forms.
- **Buttons:** remaining raw `bg-accent`/ad-hoc buttons + filter pills moved to
  `Button`/`FilterPill` (grow panels, messages, customers/[id] quick actions,
  MessagingUsage, InstallPrompt). Count badges left as the one badge pattern.
- **Surfaces:** the portal's ~20 cards, the message panels, and a few others
  moved from `bg-bg-secondary` to `bg-surface` so every card reads at the same
  elevation as the dashboard — the biggest "is this the same app?" fix.
- **Stat tiles:** CustomerList consent report → `StatTile`.

## Deliberately left untouched
- `components/pricing/DecisionSummary` + measure/verdict UX — finalized; not a redesign target.
- `dashboard/schedule` and all AutoPay/Stripe/payment/website-import backend + `components/payments`.
- Data-driven category emojis in `lib/suggestions.ts`, `lib/weather.ts`, etc. (domain data, not UI chrome).
- The intentionally-compact dense metric grids (`Metric`/`Stat` in profitability/
  routes/reactivation) — kept dense on purpose, not promoted to the larger `StatTile`.
- Portal `StatCard` — already renders the identical surface + label as `StatTile`
  (only a lighter value weight for the customer view), so left in place.
- The bordered icon-button pattern (`h-8/h-9 rounded-lg border`) in the notification
  bell / grow panel refresh — already consistent with each other.