// ── Report summaries (email-ready) ───────────────────────────────────────────
// Turns a ScheduledReport into lines of text. FORMATTING ONLY — every number here
// is read straight off the engine's output; nothing is added, divided or compared.
// If you find yourself needing a figure this file can't read, the answer is to ask
// the engine for it, not to work it out here.
//
// The email and the on-screen report render from THIS function, so the thing in the
// owner's inbox and the thing on the page cannot drift apart.

import type { ScheduledReport } from '@/lib/reports/schedule'
import { formatCurrency } from '@/lib/utils'

export interface SummaryLine {
  label: string
  value: string
  /** A quiet note under the figure — never a second number, only what it means. */
  note?: string
}

export interface ReportSummary {
  title: string
  subtitle: string
  lines: SummaryLine[]
  /** Prepended to the email body when the figures are incomplete. */
  warning: string | null
  subject: string
  text: string
}

const KIND_TITLE: Record<ScheduledReport['kind'], string> = {
  daily: 'Daily report',
  weekly: 'Weekly report',
  monthly: 'Monthly report',
  yearly: 'Yearly report',
}

/** `null` margin means "no revenue, so no share of it" — render the engine's own "—". */
function marginText(margin: number | null): string {
  return margin === null ? '—' : `${margin}%`
}

/**
 * The figures, in the order an owner reads them: what came in, what went out,
 * what's left. Each is a field of ProfitAndLoss / CashFlow, passed through.
 */
export function summarize(r: ScheduledReport): ReportSummary {
  const { pnl, flow, period } = r
  const title = KIND_TITLE[r.kind]

  const lines: SummaryLine[] = [
    {
      label: 'Money in',
      value: formatCurrency(pnl.cashCollected),
      note: pnl.refunded > 0 ? `after ${formatCurrency(pnl.refunded)} refunded` : undefined,
    },
    // Revenue and cash differ ONLY for a registrant (GST is held for the CRA, never
    // earned). At 0% they are equal, and showing both would read as a bug rather
    // than a distinction — so the tax line appears only when it is real.
    ...(pnl.registrant
      ? [
          { label: 'Sales tax collected', value: formatCurrency(pnl.salesTaxCollected), note: 'held for the CRA, not revenue' },
          { label: 'Revenue', value: formatCurrency(pnl.revenue), note: 'money in, less the tax you hold' },
        ]
      : []),
    { label: 'Costs', value: formatCurrency(pnl.cost), note: pnl.expenseCount === 0 ? 'nothing logged this period' : undefined },
    { label: 'Profit', value: formatCurrency(pnl.profit), note: `margin ${marginText(pnl.margin)}` },
    {
      label: 'Bank movement',
      value: formatCurrency(flow.net),
      note: `${formatCurrency(flow.inflow)} in, ${formatCurrency(flow.outflow)} out`,
    },
  ]

  // Money that is real but belongs to no period: a paid row with no paid_at date.
  // It is excluded from every figure above by inPeriod, so saying nothing would
  // make the report quietly lower than the bank.
  if (pnl.undatedCashCount > 0) {
    lines.push({
      label: 'Undated payments',
      value: formatCurrency(pnl.undatedCash),
      note: `${pnl.undatedCashCount} payment${pnl.undatedCashCount === 1 ? '' : 's'} with no date — not counted in any period above`,
    })
  }

  const warning = r.complete
    ? null
    : 'Some figures could not be loaded, so the numbers below are a floor, not a total.'

  const subject = `${title}: ${period.label}`
  const text = [
    `${title} — ${period.label}`,
    `${period.from} to ${period.to}`,
    '',
    ...(warning ? [`⚠️ ${warning}`, ''] : []),
    ...lines.map(l => `${l.label}: ${l.value}${l.note ? `  (${l.note})` : ''}`),
    '',
    pnl.expenseCount === 0 && pnl.paymentCount === 0
      ? 'No money moved in this period.'
      : `${pnl.paymentCount} payment${pnl.paymentCount === 1 ? '' : 's'}, ${pnl.expenseCount} expense${pnl.expenseCount === 1 ? '' : 's'}.`,
  ].join('\n')

  return {
    title,
    subtitle: `${period.label} · ${period.from} to ${period.to}`,
    lines,
    warning,
    subject,
    text,
  }
}

/** Minimal, table-free HTML — every client renders it, and it survives plain-text fallback. */
export function summaryHtml(r: ScheduledReport): string {
  const s = summarize(r)
  const esc = (v: string) => v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  return [
    `<h2 style="margin:0 0 4px;font:600 18px system-ui,sans-serif">${esc(s.title)}</h2>`,
    `<p style="margin:0 0 16px;color:#666;font:14px system-ui,sans-serif">${esc(s.subtitle)}</p>`,
    s.warning ? `<p style="margin:0 0 16px;padding:10px;background:#fef3c7;border-radius:6px;font:14px system-ui,sans-serif">⚠️ ${esc(s.warning)}</p>` : '',
    ...s.lines.map(l =>
      `<div style="padding:8px 0;border-bottom:1px solid #eee;font:14px system-ui,sans-serif">` +
      `<span style="color:#666">${esc(l.label)}</span>` +
      `<strong style="float:right;font-variant-numeric:tabular-nums">${esc(l.value)}</strong>` +
      (l.note ? `<div style="clear:both;color:#999;font-size:12px;padding-top:2px">${esc(l.note)}</div>` : '<div style="clear:both"></div>') +
      `</div>`,
    ),
  ].join('')
}
