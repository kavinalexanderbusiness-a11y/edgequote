import type { Payment, BusinessSettings, ExpenseWithRelations } from '@/types'
import { profitAndLoss, type MonthSlice } from '@/lib/accounting/report'
import { marginPct } from '@/lib/margin'
import { monthKeyLabel, monthsBetween, type Period } from '@/lib/accounting/period'

// ── Financial trends ─────────────────────────────────────────────────────────
// The shape of the year, not another set of totals. Every figure here is READ off
// profitAndLoss() — this module reshapes and compares, it never re-derives. A trend
// that computed its own revenue could disagree with the P&L it sits next to, and
// then neither is believable.

const round2 = (n: number) => Math.round(n * 100) / 100

export interface TrendPoint extends MonthSlice {
  label: string
  /** Margin for the month, 0..100. Null when the month billed nothing. */
  margin: number | null
  /** Cumulative profit to date — the line an owner actually watches. */
  runningProfit: number
}

export interface Trend {
  points: TrendPoint[]
  /** Best and worst by PROFIT, not revenue: a big month that cost more isn't a good one. */
  bestMonth: TrendPoint | null
  worstMonth: TrendPoint | null
  /** Months in the black. */
  profitableMonths: number
  /** Mean monthly profit across the months shown, empty ones included. */
  averageProfit: number
  /** Total across the window — must tie exactly to the P&L for the same period. */
  totalRevenue: number
  totalCost: number
  totalProfit: number
  /** Change vs the previous window of equal length. Null when there's no history. */
  revenueChange: Change | null
  profitChange: Change | null
}

export interface Change {
  from: number
  to: number
  delta: number
  /**
   * Percent change. NULL when the base is 0 — going from $0 to $500 is not "infinite
   * growth" or "100% up", it's a first month, and printing a percentage for it is
   * the classic vanity stat.
   */
  percent: number | null
  direction: 'up' | 'down' | 'flat'
}

/** A comparison that refuses to divide by zero and refuses to pretend. */
export function change(from: number, to: number): Change {
  const delta = round2(to - from)
  return {
    from: round2(from),
    to: round2(to),
    delta,
    percent: from === 0 ? null : round2((delta / Math.abs(from)) * 100),
    direction: Math.abs(delta) < 0.01 ? 'flat' : delta > 0 ? 'up' : 'down',
  }
}

export interface TrendInput {
  payments: Payment[]
  expenses: ExpenseWithRelations[]
  settings: BusinessSettings | null | undefined
  period: Period
}

/**
 * The trend for a period, plus how it compares to the one before it.
 *
 * Built on profitAndLoss(): its `byMonth` already knows the cash rules, the GST
 * rules and the operating/capital/draw partition. Re-walking the rows here would be
 * a second implementation of all three.
 */
export function trend(input: TrendInput): Trend {
  const pl = profitAndLoss(input)

  let running = 0
  const points: TrendPoint[] = pl.byMonth.map(m => {
    running = round2(running + m.profit)
    return {
      ...m,
      label: monthKeyLabel(m.key),
      margin: marginPct(m.revenue, m.cost),
      runningProfit: running,
    }
  })

  // Ranked by PROFIT. "Best month" by revenue is how a business celebrates its
  // worst month — the one where it billed a lot and spent more.
  const ranked = [...points].sort((a, b) => b.profit - a.profit)

  const prior = previousWindow(input.period)
  const priorPl = prior
    ? profitAndLoss({ ...input, period: prior })
    : null

  return {
    points,
    bestMonth: ranked[0] ?? null,
    worstMonth: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    profitableMonths: points.filter(p => p.profit > 0).length,
    averageProfit: points.length ? round2(points.reduce((s, p) => s + p.profit, 0) / points.length) : 0,
    totalRevenue: pl.revenue,
    totalCost: pl.cost,
    totalProfit: pl.profit,
    revenueChange: priorPl ? change(priorPl.revenue, pl.revenue) : null,
    profitChange: priorPl ? change(priorPl.profit, pl.profit) : null,
  }
}

/**
 * The window of equal length immediately before this one.
 *
 * Null for the all-time sentinel: there is nothing before all time, and comparing
 * against a fabricated window would invent a trend out of nothing.
 */
export function previousWindow(p: Period): Period | null {
  if (p.from === '0001-01-01' || p.to === '9999-12-31') return null
  const months = monthsBetween(p.from.slice(0, 7), p.to.slice(0, 7)).length
  if (!months) return null

  const [y, m] = [Number(p.from.slice(0, 4)), Number(p.from.slice(5, 7))]
  // Step back by the window's own length, so a quarter compares to the quarter
  // before it and a year to the year before it — not to an arbitrary 30 days.
  let sy = y, sm = m - months
  while (sm < 1) { sm += 12; sy-- }

  const endTotal = y * 12 + (m - 1) - 1
  const ey = Math.floor(endTotal / 12)
  const em = (endTotal % 12) + 1
  const lastDay = new Date(ey, em, 0).getDate()

  return {
    from: `${sy}-${String(sm).padStart(2, '0')}-01`,
    to: `${ey}-${String(em).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    label: 'previous period',
  }
}
