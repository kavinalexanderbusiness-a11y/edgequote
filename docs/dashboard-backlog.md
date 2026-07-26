# Dashboard — remaining improvements (blocked)

**Status:** The presentation-only dashboard lane is complete. Every clean,
buildable-today improvement that helps an owner-operator understand what needs
attention or what to do next has shipped or is in review (below). What remains is
genuinely valuable but **requires business logic, a data-shape change, or access
to a frozen lane** — so it is documented here rather than forced as more polish.

This is the terminal state of the presentation pass. Do not add further
presentation micro-changes to chase this list; each item unblocks only when its
named condition is met.

Measured against the approved `UX-DIRECTION.md` (the click ledger + the five-agent
audit it cites) and the shipped code.

---

## Already shipped (on `main`)

- **Money band, 4 stage-value tiles + honest deltas** — today · this week (vs the
  week before) · owed (overdue split) · quotes out. Absolute deltas, never
  percents; a delta renders only when a real baseline exists.
- **Today-scoped header revenue** — the header states today's shape (date, stops,
  `$ booked today`) instead of a page-describing caption; "booked today" is the
  day-plan figure, distinct from the money band's "money in today".
- **The #1 priority reads as the one next action** — accent wash + "Do first"
  eyebrow on the top queue row (reusing WeekendOutlook's "today" treatment).
- **Weekly review has a home** — a card links `/dashboard/review` from the
  dashboard; previously reachable only via the Grow hub.

## In review (pushed, awaiting merge — do not re-implement)

- `dash/status-clarity-2026-07-21` — ranking subtitle on Today's Priorities
  ("Most urgent and highest-value first"), so the queue reads as deliberately
  ordered.
- `dash/day-stops-open-2026-07-21` — honest empty state on the day-plan card
  ("Nothing scheduled yet …") + drops the meaningless `$0 · 0 jobs` totals when
  empty.
- `dash/honest-unpriced-2026-07-21` — an unpriced day-plan job renders a quiet
  "—" instead of an alarming amber "$?" (the honesty rule: unknown renders "—").

---

## Blocked improvements — prioritized (highest owner impact first)

Legend for **Blocked by**: `FROZEN` = a frozen lane owns the file that must
change · `LOGIC` = requires business logic / a state machine / an engine call ·
`DATA` = requires a query or return-shape change (new fields), i.e. not
"existing data only".

### 1. Priority rows land on the *filtered* list they name
**Impact:** Highest. The ranked queue is the dashboard's core "what to do"
surface, but every money row lands on an **unfiltered** page — "Collect unpaid
invoices · 4 · $2,310" opens the full invoices list, where the owner re-finds the
4 by hand. The click ledger targets this exact flow as **"1 + hunt → 1"**.
**Blocked by:** FROZEN. The destinations (`invoices`, `quotes`, `schedule`) do
not parse a status/followup param — verified: the invoices page reads only
`?invoice/job/pay/new/paid`; quotes and schedule read no status filter. Adding
param-parsing means editing pages frozen at `66de14f` (Quotes/Invoices/Payments)
and `1d4ef66` (Scheduling). The dashboard engine owns only the `href`; the filter
lives behind the freeze.
**Unblocks when:** those lanes open, or a freeze exception is granted to add
read-only query-param filtering to each list page. (The `href` change in
`lib/dashboard/priorities.ts` is then a one-line follow-up per row.)

### 2. Start the day's first job from the dashboard
**Impact:** Very high. Starting work is the most-repeated morning action, and
today the stage-primary `On my way → Start` lives two screens deep in the day
board. The click ledger targets **"3+ → 1"**.
**Blocked by:** LOGIC. Requires the `jobStatus` state machine and the single
offline outbox, and must honor the field invariant that completing a job queues
patch + invoice + customer text as one op. This is field/business behavior, not
presentation.
**Unblocks when:** taken as scheduling/field-lane work (with the outbox), not a
dashboard polish task.

### 3. One-tap rain response on the weather strip
**Impact:** High. When rain threatens booked work, the fix (reschedule + notify)
is ~4 clicks away on another surface. The vision's rule is "every warning carries
its own fix."
**Blocked by:** LOGIC + FROZEN. The action is `planRainDelay` (a scheduling-engine
reschedule that also sends messages), and `WeatherStrip` is shared with the
frozen Schedule surface (`1d4ef66`) — editing it risks that lane.
**Unblocks when:** the Scheduling lane opens and a decision is made to run the
rain-delay engine from where the warning renders.

### 4. Missed-jobs destination for the "Resolve missed jobs" row
**Impact:** High (pairs with #1). The queue's "missed jobs" row has nowhere
filtered to land — Schedule has no missed-jobs view — so even with #1 done this
row would dead-end on the board.
**Blocked by:** FROZEN. Building the view is new work on the Scheduling page
(`1d4ef66`).
**Unblocks when:** the Scheduling lane opens.

### 5. "Awaiting scheduling" as a stage-value figure
**Impact:** Medium-high. Accepted-but-unscheduled revenue (committed work not yet
on the calendar) is the pipeline stage most at risk of slipping, but it appears
only as a queue row, not in the where's-the-money band.
**Blocked by:** DATA + design. The figure is computed inside
`lib/dashboard/priorities.ts` but not surfaced to `MoneyBand`; exposing it means
plumbing a new value into the band's props, and rendering it is a new tile — which
the "explain existing data, don't add UI" preference deprioritizes.
**Unblocks when:** a decision to add a fifth money figure + the small data
plumbing to pass it through `lib/dashboard/data.ts`.

### 6. Queue truncation honesty ("and N more")
**Impact:** Medium. The priorities engine caps the list (currently 8) and the
component renders whatever it gets; when more kinds fire, lower-tier rows vanish
with no signal, so real money-bearing work can silently leave the one screen
meant to be exhaustive.
**Blocked by:** DATA. `computePriorities` returns only the capped array; an
"and N more" affordance needs it to also return the pre-cap count. A return-shape
change, not new math.
**Unblocks when:** the engine exposes the total (a one-field, no-calculation
change) — small, but outside "existing data only".

### 7. "What changed since yesterday" brief
**Impact:** Medium. One plain sentence summarizing the day's most notable movement
(biggest new lead, largest newly-overdue invoice) would compress the whole board
into a true 10-second read — the vision's "Insights / what changed" posture,
seeded on the dashboard.
**Blocked by:** LOGIC + DATA. "What changed" is a new derivation and needs a
day-over-day comparison the dashboard does not currently load. This is a new
insight engine, however small — explicitly out of "no calculations / existing
data only".
**Unblocks when:** the signal is defined and the comparison data is loaded (best
done as a small, testable engine with the honesty rules the ledger already uses).

### 8. Honest "empty books" vs "all caught up"
**Impact:** Medium (new-owner clarity). An empty priorities queue shows "You're
all caught up" — accurate for a business that cleared its work, misleading for a
brand-new one that has done nothing yet. (SetupProgress covers the truly
un-configured case, so this is the narrow in-between.)
**Blocked by:** DATA. Distinguishing the two needs an "any activity ever" signal
the queue component isn't given; deriving it from what's loaded risks a wrong
call. A data change.
**Unblocks when:** an activity flag is passed to `TodaysPriorities` (data change).

### 9. Retire the duplicate "owed" signal — DEFERRED, not blocked
**Impact:** Low-medium. "Owed to you" (money tile) and "Collect unpaid invoices"
(queue row) show the same dollars near the top; the audit flagged the
duplication.
**Not blocked** technically (both are dashboard-owned presentation), but
**deliberately not done**: on inspection each serves a distinct purpose — the tile
is money *status* (with the overdue tone), the row is a ranked *action* — and
removing either loses something. This is an owner/design decision, not a clean
mechanical fix, so it is recorded rather than guessed.
**Resolve when:** the owner decides which surface should own the "owed" figure.

---

## Note on scope discipline

Items 1–4 are the real prizes and are all gated on the Pricing/Scheduling
freezes or field business logic. Items 5–8 need a data or engine change, however
small, which puts them past the "presentation-only / existing-data" line this
pass held to. Item 9 is a judgment call reserved for the owner. None should be
attempted as another presentation tweak; each is listed with the specific
condition that unblocks it.
