// ── Report CSV columns ───────────────────────────────────────────────────────
// COLUMN DEFINITIONS ONLY. `lib/csv.ts` already owns the hard parts (formula-
// injection guard, Excel BOM, quote escaping) — see accounting/exports.ts, which
// is the same shape for the same reason. Nothing here computes.

import type { CsvColumn } from '@/lib/csv'
import type { Payment } from '@/types'
import { ledgerRowType, cashAmountOf } from '@/lib/payments/analytics'
import { tipAmountOf } from '@/lib/payments/tips'
import type { ScheduledReport } from '@/lib/reports/schedule'
import { summarize } from '@/lib/reports/summary'

/** The report's figures, one row per line — what the summary shows, as a file. */
export interface SummaryRow { label: string; value: string; note: string }

export function summaryRows(r: ScheduledReport): SummaryRow[] {
  return summarize(r).lines.map(l => ({ label: l.label, value: l.value, note: l.note ?? '' }))
}

export const SUMMARY_COLUMNS: CsvColumn<SummaryRow>[] = [
  { label: 'Figure', value: r => r.label },
  { label: 'Amount', value: r => r.value },
  { label: 'Note', value: r => r.note },
]

/**
 * The payment rows behind the report.
 *
 * `Cash` is `cashAmountOf`, never `amount`. That is the whole point: summing this
 * column reproduces the report's "Money in" EXACTLY, because both are the same
 * function over the same rows. A raw `amount` column would let a bookkeeper total a
 * credit application as new money and land $400 where $200 happened.
 */
export const PAYMENT_COLUMNS: CsvColumn<Payment & { customers?: { name: string } | null }>[] = [
  { label: 'Date', value: p => p.paid_at?.slice(0, 10) ?? '' },
  { label: 'Customer', value: p => p.customers?.name ?? '' },
  { label: 'Type', value: p => ledgerRowType(p) },
  { label: 'Method', value: p => p.method ?? p.provider ?? '' },
  { label: 'Amount', value: p => Number(p.amount) || 0 },
  { label: 'Cash', value: p => cashAmountOf(p) },
  // A gratuity is neither Cash (isCashRow rejects it) nor part of "Money in", so
  // without this column a tip row exports as Cash=0 with a bare Amount beside it
  // — indistinguishable from a credit application, and the one shape a
  // bookkeeper would have to guess at. Named, it is attributable.
  { label: 'Tip', value: p => tipAmountOf(p) },
]

/** `report-daily-2026-07-15.csv` — sorts chronologically in a folder. */
export function reportFilename(r: ScheduledReport, ext: 'csv' | 'pdf'): string {
  return `report-${r.kind}-${r.period.from}.${ext}`
}
