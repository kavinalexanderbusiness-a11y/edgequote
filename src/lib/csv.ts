// ── Shared CSV export ────────────────────────────────────────────────────────
// One definition of "turn selected rows into a downloaded .csv", used by every
// bulk Export action so the format + escaping are identical everywhere.

export interface CsvColumn<T> { label: string; value: (row: T) => string | number | null | undefined }

// Excel/Sheets treat a cell opening with = + - @ (or a leading tab/CR) as a FORMULA
// and evaluate it on open — quoting does not stop it, because the quotes are CSV
// syntax the parser strips before the formula engine ever sees the text. Customer
// names, addresses and free-text notes all reach these cells, so a name like
// "=1+1" (or worse) travels into a bookkeeper's spreadsheet as live code.
//
// The fix is to make the cell start with something inert. A leading apostrophe is
// the conventional escape and Excel does not display it. Numbers are unaffected: a
// negative number is only a formula when the parser is already treating the cell as
// text, and we only reach this for string-shaped values.
const FORMULA_START = /^[=+\-@\t\r]/
function neutralize(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s
}

function escapeCell(v: string | number | null | undefined): string {
  if (v == null) return ''
  // A real number is emitted as-is: it must stay numeric for a spreadsheet to sum
  // it, and it can't carry a formula.
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  const s = neutralize(String(v))
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
