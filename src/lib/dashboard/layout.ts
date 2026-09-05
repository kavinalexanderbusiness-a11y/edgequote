// ── THE dashboard layout engine ──────────────────────────────────────────────
// Order + visibility for the owner dashboard's bands. Pure and framework-free —
// the same shape, semantics and helpers as lib/analytics/layout (the intelligence
// workspace), because "customise which sections I see" is one problem and this
// codebase answers a problem once.
//
// The cards ARE the existing bands. Nothing new is computed: every card renders
// from the one loadDashboard batch (plus the inbox composition the page already
// runs), so a customised dashboard can never disagree with the default one —
// hiding a card hides PRESENTATION, it does not fork the data path or stop the
// batch being one fetch.
//
// Persisted in `business_settings.dashboard_cards` (jsonb `{order, hidden}`).
// That column already exists: it held the pre-019c24c dashboard shell's layout
// and has sat dead-but-present since (types/index.ts documented it as DEAD).
// Reviving it IS the explicit decision that comment asked for — same purpose,
// same shape, no migration. Stale values from the old shell name card ids that
// no longer exist, and normalizeDashboardLayout drops unknown ids and appends
// the real ones in default order — so a legacy row resolves to exactly the
// default dashboard, not a broken one.
//
// `needsYou` can be reordered but never hidden. The dashboard's first question
// is "what needs me?", and the Needs-You card is also where a degraded load
// says "couldn't check everything" — hiding it would hide the failure banner
// along with the work, the confident-lie shape the trust audits exist to
// prevent. The engine enforces this (normalize strips it from `hidden`, the
// toggle refuses), so no stored value — however written — can produce a
// dashboard without it.

export type DashboardCardId = 'money' | 'needsYou' | 'today' | 'month' | 'review' | 'updates'

export interface DashboardCardMeta {
  id: DashboardCardId
  title: string
  /** One line for the customize sheet — what this band answers. */
  blurb: string
  /** Present but OFF in the default composition. A new card ships defaultOn:
   *  false so an owner's dashboard never grows a band they didn't ask for —
   *  the sheet is where it becomes discoverable. */
  defaultOn: boolean
  /** Always rendered; the sheet shows it locked on. */
  required?: boolean
}

/**
 * THE registry, in default order.
 *
 * The default focuses on money, attention and upcoming work. Historical bands
 * remain available in Customize, and explicitly saved layouts keep their order
 * and visibility through normalization below.
 */
export const DASHBOARD_CARDS: DashboardCardMeta[] = [
  { id: 'money',    title: 'Money',             blurb: 'In today, this week, owed with the overdue slice, quotes out', defaultOn: true },
  { id: 'needsYou', title: 'Needs you',         blurb: 'The ranked queue of what genuinely needs you', defaultOn: true, required: true },
  { id: 'today',    title: 'Today & next days', blurb: 'Weather risk and your next work days', defaultOn: true },
  { id: 'month',    title: 'This month',        blurb: 'Collected, jobs done and conversion, against last month', defaultOn: false },
  { id: 'review',   title: 'Weekly review',     blurb: 'The door to last week’s results and next week’s moves', defaultOn: false },
  // NOT the audit trail (the Activity module in Settings → Features is "who
  // changed what"); this is the Inbox's Updates column — news from the last
  // 7 days — previewed on the home screen.
  { id: 'updates',  title: 'Recent updates',    blurb: 'Quotes accepted, invoices paid, reviews — the last 7 days of news', defaultOn: false },
]

const ALL_IDS = DASHBOARD_CARDS.map(c => c.id)
const IS_ID = (v: unknown): v is DashboardCardId => typeof v === 'string' && (ALL_IDS as string[]).includes(v)
const DEFAULT_OFF = DASHBOARD_CARDS.filter(c => !c.defaultOn).map(c => c.id)
const REQUIRED = new Set(DASHBOARD_CARDS.filter(c => c.required).map(c => c.id))

export interface DashboardLayout {
  order: DashboardCardId[]
  hidden: DashboardCardId[]
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = { order: [...ALL_IDS], hidden: [...DEFAULT_OFF] }

/**
 * Coerce whatever is stored into a layout that is always complete and always
 * renderable — the analytics workspace's rules, plus one:
 *
 *  • UNKNOWN ids are dropped — including everything the dead pre-019c24c shell
 *    ever saved in this column.
 *  • MISSING ids are appended in default order, so a card shipped in a later
 *    release appears for someone with an old saved layout.
 *  • An appended card that ships defaultOn: false is appended HIDDEN — unless
 *    the saved layout already mentions it somewhere, which means the owner has
 *    seen it and their word (in `hidden` or not) stands. Without this rule,
 *    forward-compat appending would silently force every future optional card
 *    ON for everyone with a saved layout.
 *  • A required card is never hidden, whatever the stored value claims.
 */
export function normalizeDashboardLayout(raw: unknown): DashboardLayout {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as { order?: unknown; hidden?: unknown }
    : null
  const savedOrder = Array.isArray(r?.order) ? r.order.filter(IS_ID) : []
  const savedHidden = Array.isArray(r?.hidden) ? r.hidden.filter(IS_ID) : []
  const mentioned = new Set<DashboardCardId>([...savedOrder, ...savedHidden])

  const seen = new Set<DashboardCardId>()
  const order: DashboardCardId[] = []
  for (const id of savedOrder) {
    if (seen.has(id)) continue // a duplicate would render the same band twice
    seen.add(id)
    order.push(id)
  }
  const appended: DashboardCardId[] = []
  for (const id of ALL_IDS) if (!seen.has(id)) { order.push(id); appended.push(id) }

  const hidden = [
    ...savedHidden,
    ...appended.filter(id => DEFAULT_OFF.includes(id) && !mentioned.has(id)),
  ].filter((id, i, a) => a.indexOf(id) === i && !REQUIRED.has(id))

  return { order, hidden }
}

/** Visible cards, in the owner's order — what the page actually renders. */
export function visibleDashboardCards(layout: DashboardLayout): DashboardCardMeta[] {
  const byId = new Map(DASHBOARD_CARDS.map(c => [c.id, c]))
  const hidden = new Set(layout.hidden)
  return layout.order.filter(id => !hidden.has(id)).map(id => byId.get(id)!).filter(Boolean)
}

/** Move `id` to sit where `overId` currently is. Pure — returns a new order. */
export function reorderCards(order: DashboardCardId[], id: DashboardCardId, overId: DashboardCardId): DashboardCardId[] {
  if (id === overId) return order
  const from = order.indexOf(id)
  const to = order.indexOf(overId)
  if (from < 0 || to < 0) return order
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * Step a card one place up/down among the VISIBLE cards. Arrows are the ONLY
 * reorder control on this surface (V1 is deliberately drag-free), and stepping
 * over a hidden card would look like nothing happened — so hidden ids are
 * skipped and the moved card lands past them.
 */
export function stepCard(layout: DashboardLayout, id: DashboardCardId, dir: -1 | 1): DashboardLayout {
  const hidden = new Set(layout.hidden)
  const visible = layout.order.filter(c => !hidden.has(c))
  const vi = visible.indexOf(id)
  if (vi < 0) return layout
  const target = visible[vi + dir]
  if (!target) return layout // already at the end
  return { ...layout, order: reorderCards(layout.order, id, target) }
}

/** Can this card still move that way? Drives disabled state on the arrows. */
export function canStepCard(layout: DashboardLayout, id: DashboardCardId, dir: -1 | 1): boolean {
  const hidden = new Set(layout.hidden)
  const visible = layout.order.filter(c => !hidden.has(c))
  const vi = visible.indexOf(id)
  return vi >= 0 && !!visible[vi + dir]
}

/** Show/hide a card. Refuses the required card — the engine holds the rule so
 *  a UI bug (or a hand-crafted call) can't produce a needsYou-less dashboard. */
export function toggleCardHidden(layout: DashboardLayout, id: DashboardCardId): DashboardLayout {
  if (REQUIRED.has(id)) return layout
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter(h => h !== id)
    : [...layout.hidden, id]
  return { ...layout, hidden }
}

/** True when the layout differs from the shipped default (drives Reset). */
export function isDashboardCustomised(layout: DashboardLayout): boolean {
  return layout.order.join() !== DEFAULT_DASHBOARD_LAYOUT.order.join()
    || [...layout.hidden].sort().join() !== [...DEFAULT_DASHBOARD_LAYOUT.hidden].sort().join()
}
