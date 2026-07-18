// ── Scheduled reports ────────────────────────────────────────────────────────
// Daily / weekly / monthly / yearly reports, composed from the engines that
// already exist. This file resolves a PERIOD and asks the engines. It contains no
// arithmetic — deliberately, and checkably (`npm run verify:reports` asserts every
// figure here is === the engine's own output).
//
// Why that rule is worth the discipline: a report is the artefact most likely to be
// forwarded to an accountant, and least likely to be checked against the app. If it
// computed its own totals it would be the one surface where a drift is invisible
// until someone files on it. So the report cannot disagree with the P&L page —
// there is nothing here for it to disagree WITH.
//
// The engines this composes (each already THE answer to its question):
//   accounting/period.ts   → which dates a period covers
//   accounting/report.ts   → profitAndLoss / cashFlow over that period
//     └─ which internally use payments/analytics.summarizeTransactions (money-in),
//        margin.ts marginPct (margin), and the expense partition (isOperatingCost)
//
// NOT businessIntelligence: BIReport is month-anchored (revenueThisMonth, YTD, a
// 12-month trend) and has no daily or weekly figure, so it cannot answer three of
// the four periods asked for. It is also session-bound — loadBusinessIntelligence
// reads auth.getUser() — so a cron with a service-role client cannot load it per
// user. The interactive workspace at /dashboard/intelligence stays its home.

import type { Period, PeriodKey } from '@/lib/accounting/period'
import { resolvePeriod } from '@/lib/accounting/period'
import { profitAndLoss, cashFlow, type ProfitAndLoss, type CashFlow, type AccountingInput } from '@/lib/accounting/report'

/** The four cadences a report can be run or scheduled on. */
export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'yearly'

export const REPORT_KINDS: { value: ReportKind; label: string; blurb: string }[] = [
  { value: 'daily', label: 'Daily', blurb: 'Yesterday’s money, every morning.' },
  { value: 'weekly', label: 'Weekly', blurb: 'Last calendar week, every Monday.' },
  { value: 'monthly', label: 'Monthly', blurb: 'Last month, on the 1st.' },
  { value: 'yearly', label: 'Yearly', blurb: 'Last year, on Jan 1.' },
]

/**
 * The period a report of `kind` covers.
 *
 * `closed` is the distinction that makes a scheduled report trustworthy:
 *  - closed (what a SCHEDULE sends): the period that has FINISHED — yesterday, last
 *    week, last month, last year. A "today" report emailed at 6am reports an empty
 *    day and looks like a business that died overnight.
 *  - open (what the PAGE shows by default): the period in progress, which is what
 *    someone opening the page at noon means by "today".
 *
 * Both go through resolvePeriod, so a report period and an accounting-page period
 * are the same object built the same way.
 */
export function periodForReport(kind: ReportKind, todayISO: string, closed: boolean): Period {
  const key: PeriodKey =
    kind === 'daily' ? (closed ? 'yesterday' : 'today')
    : kind === 'weekly' ? (closed ? 'last_week' : 'this_week')
    : kind === 'monthly' ? (closed ? 'last_month' : 'this_month')
    : (closed ? 'last_year' : 'this_year')
  return resolvePeriod(key, todayISO)
}

export interface ScheduledReport {
  kind: ReportKind
  /** Exactly the engine's Period — the dates every figure below was filtered on. */
  period: Period
  pnl: ProfitAndLoss
  flow: CashFlow
  /**
   * False when a source query failed. The figures are then a FLOOR, not a total,
   * and every surface says so rather than presenting a partial as a fact — a report
   * that renders $0 because a query failed reads exactly like a quiet week.
   */
  complete: boolean
  errors: string[]
}

export interface ComposeInput extends Omit<AccountingInput, 'period'> {
  /** Anything that failed to load upstream (AccountingData.errors). */
  errors?: string[]
}

/**
 * Build a report. Resolves the period, hands the SAME input to both engines.
 *
 * Note there is no `revenue`/`profit`/`total` computed here — `pnl` and `flow` ARE
 * the engines' return values, passed through untouched. The report is a view of an
 * engine result, not a second opinion about it.
 */
export function composeReport(
  kind: ReportKind,
  todayISO: string,
  input: ComposeInput,
  opts?: { closed?: boolean },
): ScheduledReport {
  const period = periodForReport(kind, todayISO, opts?.closed ?? true)
  const engineInput: AccountingInput = {
    payments: input.payments,
    expenses: input.expenses,
    settings: input.settings,
    period,
  }
  const errors = input.errors ?? []
  return {
    kind,
    period,
    pnl: profitAndLoss(engineInput),
    flow: cashFlow(engineInput),
    complete: errors.length === 0,
    errors,
  }
}
