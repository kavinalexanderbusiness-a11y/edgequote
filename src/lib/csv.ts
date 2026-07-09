// ── Shared CSV export ────────────────────────────────────────────────────────
// One definition of "turn selected rows into a downloaded .csv", used by every
// bulk Export action so the format + escaping are identical everywhere.

export interface CsvColumn<T> { label: string; value: (row: T) => string | number | null | undefined }

function escapeCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map(c => escapeCell(c.label)).join(',')
  const body = rows.map(r => columns.map(c => escapeCell(c.value(r))).join(',')).join('\r\n')
  return body ? `${header}\r\n${body}` : header
}

export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === 'undefined') return
  // Prepend a BOM so Excel opens UTF-8 correctly.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export function exportRowsToCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]): void {
  downloadCsv(filename, toCsv(rows, columns))
}
