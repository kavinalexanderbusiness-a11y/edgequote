// ── THE analytics workspace layout engine ────────────────────────────────────
// Order + visibility for the /dashboard/intelligence widgets. Pure and
// framework-free: no React, no icons, no fetching — so the forward-compatibility
// rules below are testable rather than buried in a component.
//
// The widgets ARE the existing BI sections. Nothing new is computed: every one
// renders from the BIReport that lib/businessIntelligence already produces, so a
// widget can never disagree with the page it came from.
//
// Persisted per user in business_settings.analytics_layout (jsonb), matching the
// existing per-user config pattern (service_seasons, message_templates,
// notif_prefs). See supabase/RUN-2026-07-15-analytics-layout.sql.

export type WidgetId =
  | 'executive' | 'financial' | 'yearly' | 'profitability' | 'customers'
  | 'sales' | 'operations' | 'weekday' | 'cancellations' | 'labor' | 'forecasting'
  | 'marketing'

export interface WidgetMeta {
  id: WidgetId
  title: string
  /** One line for the customize panel — what question this answers. */
  blurb: string
}

/**
 * THE registry, in default order.
 *
 * This order deliberately MATCHES the page as it ships today, so turning
 * customisation on rearranges nothing for anyone until they choose to. A default
 * that quietly reshuffles a page people already know would be a redesign wearing
 * a feature's clothes.
 */
export const WIDGETS: WidgetMeta[] = [
  { id: 'executive',     title: 'Executive',      blurb: 'Who the revenue depends on, and how fast it becomes cash' },
  { id: 'financial',     title: 'Financial',      blurb: 'Revenue this month, YTD, and the 12-month trend' },
  { id: 'yearly',        title: 'This year vs last', blurb: 'This year against last, like for like' },
  { id: 'profitability', title: 'Profitability',  blurb: 'Revenue per labour hour, margin, and what actually pays' },
  { id: 'customers',     title: 'Customers',      blurb: 'Active, new, churn and retention' },
  { id: 'sales',         title: 'Sales',          blurb: 'Quote acceptance, what wins, and what it costs to lose' },
  { id: 'operations',    title: 'Operations',     blurb: 'Capacity used, labour accuracy and route density' },
  { id: 'weekday',       title: 'Busiest days',   blurb: 'Which weekdays carry the work and which pay best' },
  { id: 'cancellations', title: 'Cancellations',  blurb: 'What falls through, and what it costs' },
  { id: 'labor',         title: 'Labour accuracy', blurb: 'Estimated vs actual time, and crew efficiency' },
  { id: 'forecasting',   title: 'Forecasting',    blurb: 'Where this month and the season are heading' },
  // Appended LAST on purpose. normalizeLayout appends ids it hasn't seen to the
  // END of a saved order, so anyone with a layout saved before this release gets
  // Marketing last. Slotting it mid-registry would put it mid-page for new users
  // and last for everyone else — the same widget in two places depending on when
  // you first opened the page. Last for everyone is the only consistent choice.
  { id: 'marketing',     title: 'Marketing',      blurb: 'What each campaign sent, and what got delivered and opened' },
]

const ALL_IDS = WIDGETS.map(w => w.id)
const IS_ID = (v: unknown): v is WidgetId => typeof v === 'string' && (ALL_IDS as string[]).includes(v)

export interface AnalyticsLayout {
  order: WidgetId[]
  hidden: WidgetId[]
}

export const DEFAULT_LAYOUT: AnalyticsLayout = { order: [...ALL_IDS], hidden: [] }

/**
 * Coerce whatever is stored into a layout that is always complete and always
 * renderable. Two rules that matter more than they look:
 *
 *  • UNKNOWN ids are dropped — a layout saved before a widget was renamed or
 *    removed must not render a ghost.
 *  • MISSING ids are appended in default order — so a widget shipped in a later
 *    release APPEARS for someone with an old saved layout instead of being
 *    silently invisible forever. That's the failure mode of every "saved
 *    layout" feature that stores only what it knew at save time.
 */
export function normalizeLayout(raw: unknown): AnalyticsLayout {
  const r = (raw ?? null) as Partial<AnalyticsLayout> | null
  const savedOrder = Array.isArray(r?.order) ? r!.order.filter(IS_ID) : []
  const seen = new Set<WidgetId>()
  const order: WidgetId[] = []
  for (const id of savedOrder) {
    if (seen.has(id)) continue // a duplicate would render the same widget twice
    seen.add(id)
    order.push(id)
  }
  for (const id of ALL_IDS) if (!seen.has(id)) order.push(id) // new widgets appear
  const hidden = (Array.isArray(r?.hidden) ? r!.hidden.filter(IS_ID) : [])
    .filter((id, i, a) => a.indexOf(id) === i)
  return { order, hidden }
}

/** Visible widgets, in the owner's order. */
export function visibleWidgets(layout: AnalyticsLayout): WidgetMeta[] {
  const byId = new Map(WIDGETS.map(w => [w.id, w]))
  const hidden = new Set(layout.hidden)
  return layout.order.filter(id => !hidden.has(id)).map(id => byId.get(id)!).filter(Boolean)
}

/** Move `id` to sit where `overId` currently is. Pure — returns a new order. */
export function reorder(order: WidgetId[], id: WidgetId, overId: WidgetId): WidgetId[] {
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
 * Step a widget one place up/down among the VISIBLE widgets.
 *
 * This is not a convenience — it's the only way to reorder on a phone or a
 * keyboard. HTML5 drag fires no touch events and is unreachable by keyboard, so
 * drag alone would have shipped a customisation feature that silently can't be
 * used on the device this owner actually carries.
 *
 * Stepping over a HIDDEN widget would look like nothing happened, so hidden ids
 * are skipped and the moved widget lands past them.
 */
export function step(layout: AnalyticsLayout, id: WidgetId, dir: -1 | 1): AnalyticsLayout {
  const hidden = new Set(layout.hidden)
  const visible = layout.order.filter(w => !hidden.has(w))
  const vi = visible.indexOf(id)
  if (vi < 0) return layout
  const target = visible[vi + dir]
  if (!target) return layout // already at the end
  return { ...layout, order: reorder(layout.order, id, target) }
}

/** Can this widget still move that way? Drives disabled state on the controls. */
export function canStep(layout: AnalyticsLayout, id: WidgetId, dir: -1 | 1): boolean {
  const hidden = new Set(layout.hidden)
  const visible = layout.order.filter(w => !hidden.has(w))
  const vi = visible.indexOf(id)
  return vi >= 0 && !!visible[vi + dir]
}

export function toggleHidden(layout: AnalyticsLayout, id: WidgetId): AnalyticsLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter(h => h !== id)
    : [...layout.hidden, id]
  return { ...layout, hidden }
}

/** True when the layout differs from the shipped default (drives Reset/Save). */
export function isCustomised(layout: AnalyticsLayout): boolean {
  return layout.hidden.length > 0 || layout.order.join() !== DEFAULT_LAYOUT.order.join()
}
