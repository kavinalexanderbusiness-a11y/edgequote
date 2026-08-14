import type { ServiceTemplate } from '@/types'

// ── What the service picker offers, and in what order ────────────────────────
// The one place that decides: which services a search matches, how they rank,
// which ones count as "recent", and whether the list is worth grouping. It lives
// outside the component so it can be asserted on directly — a picker that
// silently stops finding "mulch", or starts offering a retired service, is a
// behaviour change, and behaviour is what a guard should be able to read.
//
// It ranks a list. It never decides what is IN the list — the caller does that
// (active services, plus whichever retired one a saved row still points at), so
// a wrong answer here can never put a switched-off service in front of an owner.

export interface ServiceMenu {
  /** Rows in render order. Headers are labels, never selectable. */
  rows: ServiceMenuRow[]
  /** True when the rest of the catalogue is split by the owner's own categories. */
  grouped: boolean
}
export type ServiceMenuRow =
  | { type: 'header'; key: string; label: string }
  | { type: 'template'; key: string; t: ServiceTemplate; recent: boolean }

/** Enough of a catalogue that walking it beats reading it. Below this a flat
    list is shorter than the headers that would organise it. */
export const GROUP_FROM = 8
/** How many of the owner's usual services sit above the catalogue. Four is what
    fits on a phone above the fold of an open menu without becoming a second list. */
export const RECENT_MAX = 4

/** Does a service match what was typed? Name first — that is what an owner
    types — plus their own category words ("winter", "landscaping"), because a
    category IS a word they chose and a service they can't remember the name of
    is exactly when they'd reach for one. */
export function serviceMatches(t: ServiceTemplate, q: string): boolean {
  const n = q.trim().toLowerCase()
  if (!n) return true
  return !!t.name?.toLowerCase().includes(n) || !!t.category?.toLowerCase().includes(n)
}

export function buildServiceMenu(
  templates: ServiceTemplate[],
  opts: { query?: string; filtering?: boolean; recentIds?: string[] } = {},
): ServiceMenu {
  const filtering = !!opts.filtering && !!opts.query?.trim()
  const q = filtering ? opts.query!.trim().toLowerCase() : ''

  const matches = !q
    ? templates
    // A name that STARTS with what was typed beats one that merely contains it,
    // so "mow" leads with "Mowing" rather than "One-Time Mowing". Stable within
    // each tier: the caller already ordered the list (favourites, sort_order).
    : templates.filter(t => serviceMatches(t, q)).slice().sort((a, b) =>
      Number(!!b.name?.toLowerCase().startsWith(q)) - Number(!!a.name?.toLowerCase().startsWith(q)))

  const byId = new Map(templates.map(t => [t.id, t]))
  // Recent is a BROWSING aid. Once they're searching, the search is the ranking,
  // and a Recent block on top would only push the thing they asked for down.
  // Ids that no longer resolve (a deleted or retired service) simply drop out —
  // this reads history, and history can name things that aren't on offer today.
  const recent = filtering ? [] : (opts.recentIds || [])
    .map(id => byId.get(id)).filter((t): t is ServiceTemplate => !!t).slice(0, RECENT_MAX)
  const recentIdSet = new Set(recent.map(t => t.id))

  const rows: ServiceMenuRow[] = []
  if (recent.length) {
    rows.push({ type: 'header', key: 'h:recent', label: 'Recent' })
    for (const t of recent) rows.push({ type: 'template', key: 'r:' + t.id, t, recent: true })
  }

  const rest = matches.filter(t => !recentIdSet.has(t.id))
  // Group only when the owner's OWN data supports it. One blank category would
  // force an invented "Other" bucket — i.e. a service-category architecture this
  // picker has no business creating — so a single gap falls back to a flat list.
  const grouped = !filtering && templates.length >= GROUP_FROM && templates.every(t => !!t.category?.trim())

  if (grouped) {
    const cats = new Map<string, ServiceTemplate[]>()
    for (const t of rest) {
      const c = t.category.trim()
      if (!cats.has(c)) cats.set(c, [])
      cats.get(c)!.push(t)
    }
    for (const [c, list] of cats) {
      rows.push({ type: 'header', key: 'h:' + c, label: c })
      for (const t of list) rows.push({ type: 'template', key: c + ':' + t.id, t, recent: false })
    }
  } else {
    if (recent.length && rest.length) rows.push({ type: 'header', key: 'h:all', label: 'All services' })
    for (const t of rest) rows.push({ type: 'template', key: 'a:' + t.id, t, recent: false })
  }
  return { rows, grouped }
}
