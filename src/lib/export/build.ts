// ── Building the archive ─────────────────────────────────────────────────────
// Reads every entity in EXPORT_ENTITIES for ONE owner and returns a finished
// .zip, or an honest failure.
//
// ⭐ THE ORDERING RULE, and the reason this is one function rather than a stream:
// EVERY database read completes BEFORE the first byte of archive is produced. A
// read that fails therefore fails while the caller can still answer with a plain
// error and a status code. The alternative — streaming entities out as they
// arrive — means a failure halfway through arrives as a 200 OK containing a
// truncated zip, which is the exact "it said it worked" outcome this feature
// exists to avoid. Memory is the price, and the caps below are what keep it
// bounded.
//
// ⭐ TENANT SCOPE: `userId` is supplied by the caller from the SESSION and is the
// only filter. Nothing here reads an id out of a request. Reads also go through
// the caller's own user-scoped client, so RLS (auth.uid() = user_id) is a second,
// independent gate on every row — a missing .eq() would return nothing, not
// somebody else's rows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { pageAll } from '@/lib/supabase/pageAll'
import { toCsv } from '@/lib/csv'
import { zipArchive, ZipLimitError, type ZipFile } from '@/lib/export/zip'
import {
  EXPORT_ENTITIES, EXPORT_EXCLUSIONS, EXPORT_FORMAT_VERSION,
  type ExportEntity, type ExportRow,
} from '@/lib/export/manifest'

// ── Practical limits ─────────────────────────────────────────────────────────
// One request builds the whole archive in memory, so the limits are real and are
// stated rather than discovered. 200k rows is roughly a thousand times the size
// of a working single-crew account; the archive cap is what keeps a pathological
// account from producing a response no platform will deliver. Both fail with a
// message naming the actual numbers — never a silent truncation.
export const MAX_TOTAL_ROWS = 200_000
export const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024

// Excel reads a .csv as the system codepage unless the file opens with a UTF-8
// byte-order mark, which turns every accented name into mojibake. The app's own
// download helper already prepends one (lib/csv.downloadCsv); the archive is the
// delivery step here, so it does the same. JSON and text files must NOT get one:
// JSON.parse rejects a leading BOM.
const BOM = '﻿'

export interface ExportFileSummary {
  entity: string
  file: string
  rows: number
  bytes: number
}

export interface ExportBuildOk {
  ok: true
  archive: Buffer
  filename: string
  generatedAt: string
  totalRows: number
  files: ExportFileSummary[]
}

export type ExportFailureCode = 'read_failed' | 'too_large' | 'archive_failed'

export interface ExportBuildError {
  ok: false
  code: ExportFailureCode
  /** Shown to the owner verbatim. Says what happened and what to do. */
  message: string
}

export type ExportBuildResult = ExportBuildOk | ExportBuildError

/** A filename an operating system, an email client and a browser all accept. */
export function exportFilename(companyName: string | null | undefined, isoDate: string): string {
  const slug = (companyName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const day = isoDate.slice(0, 10)
  return slug ? `${slug}-edgequote-export-${day}.zip` : `edgequote-export-${day}.zip`
}

// ── README.txt ───────────────────────────────────────────────────────────────
// The archive has to explain itself to somebody who is not looking at EdgeQuote:
// an accountant, a new system, the owner in two years. The money paragraph is the
// point of the whole file — "amount" is a word three different systems define
// three different ways.
function readmeText(input: {
  companyName: string | null
  generatedAt: string
  files: ExportFileSummary[]
  totalRows: number
}): string {
  const L: string[] = []
  L.push('YOUR EDGEQUOTE DATA')
  L.push('===================')
  L.push('')
  if (input.companyName) L.push(`Business:  ${input.companyName}`)
  L.push(`Exported:  ${input.generatedAt}`)
  L.push(`Contains:  ${input.files.length} files, ${input.totalRows.toLocaleString('en-CA')} rows in total`)
  L.push(`Format:    CSV (comma separated, UTF-8), export format version ${EXPORT_FORMAT_VERSION}`)
  L.push('')
  L.push('This is your business data, in plain files. Open any .csv in Excel,')
  L.push('Numbers, Google Sheets, or any accounting package. Nothing in here needs')
  L.push('EdgeHQ to read it. manifest.json says the same thing in a form a')
  L.push('program can read.')
  L.push('')
  L.push('WHAT IS IN EACH FILE')
  L.push('--------------------')
  for (const f of input.files) {
    const entity = EXPORT_ENTITIES.find(e => e.key === f.entity)
    if (!entity) continue
    L.push('')
    L.push(`${entity.file}  (${f.rows.toLocaleString('en-CA')} rows) — ${entity.label}`)
    L.push(`    ${entity.note}`)
  }
  L.push('')
  L.push('')
  L.push('HOW THE FILES JOIN UP')
  L.push('---------------------')
  L.push('Every row has an "id". Columns ending in "_id" hold the id of a row in')
  L.push('another file, so you can rebuild the relationships anywhere:')
  L.push('')
  L.push('    customers.csv  id')
  L.push('      <- properties.csv        customer_id')
  L.push('      <- quotes.csv            customer_id      (+ property_id)')
  L.push('      <- visits.csv            customer_id      (+ property_id, quote_id, recurrence_id)')
  L.push('      <- invoices.csv          customer_id      (+ property_id, quote_id, job_id)')
  L.push('      <- payments.csv          customer_id      (+ invoice_id)')
  L.push('')
  L.push('"job_id" refers to visits.csv: inside EdgeHQ a visit is stored in a')
  L.push('table called "jobs", and one row is one visit. recurring-jobs.csv holds')
  L.push('the ongoing arrangement that produced them.')
  L.push('')
  L.push('')
  L.push('ABOUT THE MONEY COLUMNS')
  L.push('-----------------------')
  L.push('Every figure here is copied from your records exactly as stored. Nothing')
  L.push('is recalculated, and no totals are invented during the export.')
  L.push('')
  L.push('  invoices.amount       The invoice subtotal: your revenue for that')
  L.push('                        invoice, after any discount and BEFORE sales tax.')
  L.push('                        Sales tax is applied when the invoice is shown or')
  L.push('                        charged, from your current tax rate, so it is not')
  L.push('                        stored on the row and is not exported.')
  L.push('  invoices.amount_paid  How much has been recorded against that invoice.')
  L.push('  invoices.status       The stored status of the invoice.')
  L.push('  payments.amount       One payment actually received. payments.csv is the')
  L.push('                        ledger — it is the record of money, and an invoice')
  L.push('                        status is a label on top of it.')
  L.push('  quotes.total          The quote total as stored.')
  L.push('  quotes.accepted_price What the customer accepted, when they accepted.')
  L.push('')
  L.push('There is deliberately NO balance, revenue or profit column. A balance is')
  L.push('not a stored figure — it depends on the invoice\'s status (a cancelled')
  L.push('invoice is not owed even though it still has an amount), on sales tax, and')
  L.push('on deposits. Writing one number here would mean picking one of those')
  L.push('readings and presenting it as fact. The columns you need to compute it')
  L.push('yourself, however you define it, are all present.')
  L.push('')
  L.push('')
  L.push('WHAT IS NOT IN THIS ARCHIVE')
  L.push('---------------------------')
  for (const x of EXPORT_EXCLUSIONS) {
    L.push('')
    L.push(`  ${x.what}`)
    L.push(`      ${x.why}`)
  }
  L.push('')
  L.push('')
  L.push('A NOTE ON OPENING THESE IN A SPREADSHEET')
  L.push('----------------------------------------')
  L.push('Text that begins with = + - or @ is written with a leading apostrophe so')
  L.push('your spreadsheet treats it as text rather than running it as a formula.')
  L.push('The apostrophe is not part of your data.')
  L.push('')
  return L.join('\n')
}

/**
 * Read one owner's data and build the archive.
 *
 * @param sb      A client already authenticated AS that owner (RLS applies).
 * @param userId  The owner's id, taken from the session by the caller.
 */
export async function buildExportArchive(
  sb: SupabaseClient,
  userId: string,
  opts: {
    companyName?: string | null
    now?: Date
    /** Row ceiling. Overridable so the guard can prove the limit is enforced
     *  without allocating two hundred thousand fixture rows to do it. */
    maxTotalRows?: number
  } = {},
): Promise<ExportBuildResult> {
  const now = opts.now ?? new Date()
  const generatedAt = now.toISOString()
  const companyName = opts.companyName?.trim() || null
  const maxTotalRows = opts.maxTotalRows ?? MAX_TOTAL_ROWS

  // ── Phase 1: read everything. Nothing is built yet. ────────────────────────
  const csvs: { entity: ExportEntity; csv: string; rows: number }[] = []
  let totalRows = 0

  for (const entity of EXPORT_ENTITIES) {
    const { rows, error } = await pageAll<ExportRow>(
      () => sb.from(entity.table).select(entity.select.join(', ')).eq('user_id', userId),
      entity.orderBy,
    )
    if (error) {
      // Name the file that failed. "Export failed" with no subject is the kind of
      // message that makes a retry a guess.
      return {
        ok: false,
        code: 'read_failed',
        message: `Could not read your ${entity.label.toLowerCase()}, so the export was stopped before any file was written. Nothing was downloaded. Please try again.`,
      }
    }

    totalRows += rows.length
    if (totalRows > maxTotalRows) {
      // Checked as we go, so an oversized account stops here instead of after
      // loading everything into memory.
      return {
        ok: false,
        code: 'too_large',
        message: `Your account holds more than ${maxTotalRows.toLocaleString('en-CA')} records, which is more than one export can build safely in a single request. Nothing was downloaded. Please get in touch and we will export it for you.`,
      }
    }

    // Expanded once: a row that becomes many (invoice line items) is both the
    // thing written and the thing counted.
    const shaped = entity.expand ? entity.expand(rows) : rows
    csvs.push({ entity, csv: toCsv(shaped, entity.columns), rows: shaped.length })
  }

  // ── Phase 2: build. Every read has already succeeded. ──────────────────────
  const summaries: ExportFileSummary[] = csvs.map(({ entity, csv, rows }) => ({
    entity: entity.key,
    file: entity.file,
    rows,
    bytes: Buffer.byteLength(BOM + csv, 'utf8'),
  }))
  const summedRows = summaries.reduce((n, s) => n + s.rows, 0)

  const manifest = {
    format: 'edgequote-export',
    format_version: EXPORT_FORMAT_VERSION,
    generated_at: generatedAt,
    business_name: companyName,
    total_rows: summedRows,
    files: csvs.map(({ entity, rows }) => ({
      file: entity.file,
      entity: entity.key,
      label: entity.label,
      source_table: entity.table,
      rows,
      columns: entity.columns.map(c => c.label),
      note: entity.note,
    })),
    not_included: EXPORT_EXCLUSIONS,
  }

  const files: ZipFile[] = [
    { name: 'README.txt', body: Buffer.from(readmeText({ companyName, generatedAt, files: summaries, totalRows: summedRows }), 'utf8') },
    { name: 'manifest.json', body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...csvs.map(({ entity, csv }) => ({ name: entity.file, body: Buffer.from(BOM + csv, 'utf8') })),
  ]

  let archive: Buffer
  try {
    archive = zipArchive(files, now)
  } catch (e) {
    if (e instanceof ZipLimitError) {
      return {
        ok: false,
        code: 'too_large',
        message: 'Your data is larger than a single archive can hold. Nothing was downloaded. Please get in touch and we will export it for you.',
      }
    }
    return {
      ok: false,
      code: 'archive_failed',
      message: 'The export could not be packaged. Nothing was downloaded. Please try again.',
    }
  }

  if (archive.length > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      code: 'too_large',
      message: `The archive came to ${Math.round(archive.length / (1024 * 1024))} MB, which is above the ${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB a single download can carry. Nothing was downloaded. Please get in touch and we will export it for you.`,
    }
  }

  return {
    ok: true,
    archive,
    filename: exportFilename(companyName, generatedAt),
    generatedAt,
    totalRows: summedRows,
    files: summaries,
  }
}
