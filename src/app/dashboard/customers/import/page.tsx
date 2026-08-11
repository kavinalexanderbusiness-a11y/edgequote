'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Upload, Check, AlertTriangle, Monitor, Download, Info } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { fieldBorder } from '@/components/ui/fieldStyles'
import { exportRowsToCsv } from '@/lib/csv'
import type { Tone } from '@/lib/tone'
import type { Customer } from '@/types'
import type { AddressCarrier } from '@/lib/customers'
import {
  parseCsv, suggestMapping, planImport, summarize, willWrite, executeImportPlan,
  unimportedRows, mappingNamesSomeone, IMPORT_FIELDS, IMPORT_LIMITS, EMPTY_MAPPING,
  type ParsedCsv, type ColumnMapping, type PlannedRow, type RowStatus, type ImportOutcome,
} from '@/lib/customerImport'

type Book = Customer & AddressCarrier

/**
 * The existing book, or an honest failure.
 *
 * ⭐ This is the load the whole page hangs on. Duplicate detection compares each
 * CSV row against the customers already here, so a FAILED read is not an empty
 * book — it is no answer at all, and importing against it would re-create every
 * customer the business already has. supabase-js resolves on failure with
 * `{data:null,error}`, which is the same shape as "you have no customers yet",
 * so the error is read and the two are kept apart. Import stays blocked until
 * this succeeds.
 */
type BookState =
  | { status: 'loading' }
  | { status: 'ready'; customers: Book[] }
  | { status: 'error'; message: string }

const STATUS_TONE: Record<RowStatus, Tone> = {
  new: 'success', existing: 'neutral', review: 'warn', invalid: 'danger',
}
const STATUS_LABEL: Record<RowStatus, string> = {
  new: 'New', existing: 'Already here', review: 'Needs review', invalid: 'Can’t import',
}

const PREVIEW_LIMIT = 100

export default function ImportCustomersPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [book, setBook] = useState<BookState>({ status: 'loading' })
  const [me, setMe] = useState<{ id: string; email: string } | null>(null)
  const [raw, setRaw] = useState('')
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING)
  const [rows, setRows] = useState<PlannedRow[]>([])
  const [importing, setImporting] = useState(false)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (live) setBook({ status: 'error', message: 'You are signed out. Sign in again to import.' }); return }
      if (live) setMe({ id: user.id, email: user.email || user.id })
      // Archived customers are matched against too: a duplicate of someone you
      // archived is still a duplicate, and importing one would quietly resurrect
      // them as a second record.
      const { data, error } = await supabase
        .from('customers').select('*, properties(address, city, is_primary)')
        .eq('user_id', user.id).order('name')
      if (!live) return
      if (error) setBook({ status: 'error', message: error.message })
      else setBook({ status: 'ready', customers: (data as Book[]) || [] })
    })()
    return () => { live = false }
  }, [supabase])

  // Re-plan whenever the file, the mapping or the book changes. The preview the
  // owner reads and the list executeImportPlan walks are this same array.
  useEffect(() => {
    if (!parsed || parsed.error || book.status !== 'ready' || !mappingNamesSomeone(mapping)) { setRows([]); return }
    setRows(planImport({ parsed, mapping, existing: book.customers }))
  }, [parsed, mapping, book])

  /**
   * `fromFile` is the difference between "you have not typed anything yet" and
   * "the file you chose is empty". An empty textarea is a blank slate and should
   * say nothing; an empty FILE is an answer the owner needs — they picked
   * something and it had nothing in it. Without this, choosing a 0-byte export
   * looks exactly like doing nothing at all.
   */
  function load(text: string, name: string | null, fromFile = false) {
    setRaw(text); setSourceName(name); setOutcome(null)
    if (!text.trim() && !fromFile) { setParsed(null); setMapping(EMPTY_MAPPING); return }
    const p = parseCsv(text)
    setParsed(p)
    setMapping(p.error ? EMPTY_MAPPING : suggestMapping(p.headers))
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > IMPORT_LIMITS.maxBytes) {
      setParsed({ headers: [], rows: [], lines: [], truncated: {}, error: `That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is ${IMPORT_LIMITS.maxBytes / 1024 / 1024} MB — split it and import in parts.` })
      setRaw(''); setSourceName(f.name); return
    }
    load(await f.text(), f.name, true)
  }

  const totals = useMemo(() => summarize(rows), [rows])

  function toggle(line: number) {
    setRows(rs => rs.map(r => (r.line === line && r.status === 'review' ? { ...r, include: !r.include } : r)))
  }

  async function runImport() {
    if (!me || totals.toCreate === 0 || importing) return
    setImporting(true)
    try {
      const res = await executeImportPlan(supabase, {
        userId: me.id, initiatedBy: me.email, sourceName, rows,
      })
      setOutcome(res)
    } finally { setImporting(false) }
  }

  function downloadLeftovers() {
    const list = unimportedRows(rows, outcome ?? undefined)
    if (!list.length) return
    // toCsv neutralizes a leading = + - @ so a cell carrying a formula cannot
    // execute when this report is opened in Excel or Sheets.
    exportRowsToCsv('edgequote-import-not-imported', list, [
      { label: 'Source row', value: r => r.line },
      { label: 'Name', value: r => r.name },
      { label: 'Email', value: r => r.email },
      { label: 'Phone', value: r => r.phone },
      { label: 'Street', value: r => r.address },
      { label: 'City', value: r => r.city },
      { label: 'Province/State', value: r => r.province },
      { label: 'Postal/ZIP', value: r => r.postal_code },
      { label: 'Notes', value: r => r.notes },
      { label: 'What happened', value: r => r.outcome },
    ])
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  if (outcome) {
    const clean = outcome.failed.length === 0 && outcome.propertyFailures.length === 0
    return (
      <PageContainer width="narrow">
        <PageHeader title="Import finished" crumb={{ label: 'Customers', href: '/dashboard/customers' }} />
        <Card>
          <CardBody className="space-y-4" role="status" aria-live="polite">
            <div className="flex items-start gap-3">
              {clean
                ? <Check className="w-8 h-8 text-emerald-400 shrink-0" aria-hidden="true" />
                : <AlertTriangle className="w-8 h-8 text-amber-400 shrink-0" aria-hidden="true" />}
              <div>
                <p className="text-lg font-semibold text-ink tabular-nums">
                  {outcome.created} customer{outcome.created !== 1 ? 's' : ''} added
                  {outcome.propertiesCreated > 0 && <> · {outcome.propertiesCreated} address{outcome.propertiesCreated !== 1 ? 'es' : ''}</>}
                </p>
                {/* Every row is accounted for. A count that doesn't add up to the
                    file is the thing this screen exists to prevent. */}
                <p className="text-sm text-ink-muted tabular-nums">
                  of {totals.detected} row{totals.detected !== 1 ? 's' : ''} read
                  {outcome.skippedExisting > 0 && <> · {outcome.skippedExisting} already here</>}
                  {outcome.skippedForReview > 0 && <> · {outcome.skippedForReview} left for review</>}
                  {outcome.skippedInvalid > 0 && <> · {outcome.skippedInvalid} couldn’t be read</>}
                  {outcome.failed.length > 0 && <> · <span className="text-rose-400">{outcome.failed.length} failed to save</span></>}
                </p>
              </div>
            </div>

            {outcome.failed.length > 0 && (
              <Banner tone="danger" icon={AlertTriangle}>
                <div className="space-y-1">
                  <p className="text-xs font-semibold">These rows were not saved. Everything else was.</p>
                  <ul className="text-xs space-y-0.5">
                    {outcome.failed.slice(0, 8).map(f => (
                      <li key={f.line} className="tabular-nums">Row {f.line} — {f.name}: {f.error}</li>
                    ))}
                    {outcome.failed.length > 8 && <li>…and {outcome.failed.length - 8} more, in the download below.</li>}
                  </ul>
                </div>
              </Banner>
            )}

            {outcome.propertyFailures.length > 0 && (
              <Banner tone="warn" icon={AlertTriangle}>
                {outcome.propertyFailures.length} customer{outcome.propertyFailures.length !== 1 ? 's were' : ' was'} added, but their address could not be saved. Add it from the customer’s profile.
              </Banner>
            )}

            {outcome.runError && (
              <Banner tone="warn" icon={Info}>
                The customers were imported, but the import record could not be written ({outcome.runError}). Nothing is lost — only the audit entry is missing.
              </Banner>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => router.push('/dashboard/customers')}>Back to customers</Button>
              {unimportedRows(rows, outcome).length > 0 && (
                <Button variant="secondary" onClick={downloadLeftovers}>
                  <Download className="w-4 h-4" /> Download the {unimportedRows(rows, outcome).length} rows not imported
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      </PageContainer>
    )
  }

  // ── Build ──────────────────────────────────────────────────────────────────
  const canPreview = !!parsed && !parsed.error && book.status === 'ready' && mappingNamesSomeone(mapping)

  return (
    <PageContainer width="narrow">
      <Link href="/dashboard/customers" className="text-sm text-ink-muted hover:text-ink flex items-center gap-1.5">
        <ArrowLeft className="w-4 h-4" /> Back to customers
      </Link>
      <PageHeader
        title="Import customers"
        description="Bring your customer book over from a spreadsheet, Jobber, Housecall Pro or another CRM. Nothing is written until you have seen exactly what will happen."
      />

      {/* Mapping is a wide, multi-column task. The page stays usable at 375px —
          nothing is hidden — but saying so up front beats a pinched experience
          the owner discovers halfway through. */}
      <div className="sm:hidden">
        <Banner tone="info" icon={Monitor}>Import is easiest on a desktop — there are a lot of columns to line up. It works here too.</Banner>
      </div>

      {book.status === 'error' && (
        <Banner tone="danger" icon={AlertTriangle}>
          Your existing customers could not be loaded ({book.message}). Import is blocked until they can be —
          without them there is no way to tell a new customer from one you already have, and importing would duplicate your whole book.
        </Banner>
      )}

      {/* 1 — the file */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-ink">1 · Your CSV</p>
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-text cursor-pointer rounded-md focus-within:ring-2 focus-within:ring-accent/40">
              <Upload className="w-3.5 h-3.5" /> Upload CSV file
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" />
            </label>
          </div>
          <p className="text-xs text-ink-muted">
            Any column names — you line them up in the next step. Up to {IMPORT_LIMITS.maxRows.toLocaleString()} rows.
          </p>
          <textarea
            value={raw}
            onChange={e => load(e.target.value, sourceName)}
            rows={6}
            aria-label="Paste CSV data"
            placeholder={'First Name,Last Name,Phone,Email,Street,City\nJane,Doe,(403) 555-0100,jane@example.com,84 17 St NW,Calgary'}
            className={`w-full bg-bg-tertiary border rounded-xl px-3.5 py-2.5 text-sm font-mono text-ink outline-none transition-all ${fieldBorder()}`}
          />
          {parsed?.error && <Banner tone="danger" icon={AlertTriangle}>{parsed.error}</Banner>}
          {parsed && !parsed.error && (
            <p className="text-xs text-ink-muted tabular-nums">
              {parsed.rows.length.toLocaleString()} row{parsed.rows.length !== 1 ? 's' : ''} · {parsed.headers.length} column{parsed.headers.length !== 1 ? 's' : ''}
              {sourceName && <> · {sourceName}</>}
            </p>
          )}
          {parsed?.truncated.rows != null && (
            <Banner tone="warn" icon={AlertTriangle}>
              Only the first {IMPORT_LIMITS.maxRows.toLocaleString()} rows were read — {parsed.truncated.rows.toLocaleString()} more were left out. Import these, then upload the rest.
            </Banner>
          )}
          {parsed?.truncated.bytes && (
            <Banner tone="warn" icon={AlertTriangle}>That file was larger than {IMPORT_LIMITS.maxBytes / 1024 / 1024} MB and was cut short. Split it and import in parts.</Banner>
          )}
          {parsed?.truncated.columns != null && (
            <Banner tone="warn" icon={AlertTriangle}>Only the first {IMPORT_LIMITS.maxColumns} columns were read.</Banner>
          )}
        </CardBody>
      </Card>

      {/* 2 — the mapping */}
      {parsed && !parsed.error && (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-ink">2 · Line up the columns</p>
              <p className="text-xs text-ink-muted">Guessed from your headers. Change anything that looks wrong — nothing is read from a column you leave unmapped.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {IMPORT_FIELDS.map(f => (
                <Select
                  key={f.field}
                  label={f.label}
                  fieldSize="sm"
                  value={mapping[f.field] === null ? '' : String(mapping[f.field])}
                  onChange={e => setMapping(m => ({ ...m, [f.field]: e.target.value === '' ? null : Number(e.target.value) }))}
                  placeholder="— not imported —"
                  hint={f.hint}
                  options={parsed.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))}
                />
              ))}
            </div>
            {!mappingNamesSomeone(mapping) && (
              <Banner tone="warn" icon={AlertTriangle}>Map a name column — a full name, or a first and last name. EdgeQuote can’t create a customer without one.</Banner>
            )}
          </CardBody>
        </Card>
      )}

      {/* 3 — what will happen */}
      {canPreview && (
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-ink">3 · What will happen</p>
              <p className="text-xs text-ink-muted">Read against the {book.status === 'ready' ? book.customers.length : 0} customers already in EdgeQuote.</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Figure n={totals.toCreate} label="will be added" tone="success" />
              <Figure n={totals.existing} label="already here" tone="neutral" />
              <Figure n={totals.review} label="need review" tone="warn" />
              <Figure n={totals.invalid} label="can’t be read" tone="danger" />
            </div>

            {totals.withAddress > 0 && (
              <p className="text-xs text-ink-muted tabular-nums">{totals.withAddress} of them bring a service address, saved as their primary property.</p>
            )}

            {totals.review > 0 && (
              <Banner tone="warn" icon={AlertTriangle}>
                {totals.review} row{totals.review !== 1 ? 's' : ''} could be someone you already have. They are switched OFF — tick one to import it as a new customer anyway. EdgeQuote never merges two people on a guess.
              </Banner>
            )}

            <div className="max-h-96 overflow-auto rounded-lg border border-border divide-y divide-border">
              {rows.slice(0, PREVIEW_LIMIT).map(r => (
                <div key={r.line} className="flex items-start gap-3 px-3 py-2 text-xs">
                  <span className="text-ink-faint tabular-nums w-8 shrink-0 pt-0.5">{r.line}</span>
                  {r.status === 'review' ? (
                    <input
                      type="checkbox" checked={r.include} onChange={() => toggle(r.line)}
                      className="mt-0.5 w-4 h-4 accent-accent shrink-0"
                      aria-label={`Import row ${r.line}, ${r.values.name}, as a new customer`}
                    />
                  ) : <span className="w-4 shrink-0" aria-hidden="true" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{r.values.name || <span className="text-ink-faint italic">no name</span>}</p>
                    <p className="text-ink-faint truncate">
                      {[r.values.phone, r.values.email, r.values.address].filter(Boolean).join(' · ') || '—'}
                    </p>
                    <p className="text-ink-muted">{r.reason}</p>
                    {r.warnings.map((w, i) => <p key={i} className="text-amber-400/90">{w}</p>)}
                  </div>
                  <Badge tone={STATUS_TONE[r.status]} className="shrink-0">{STATUS_LABEL[r.status]}</Badge>
                </div>
              ))}
              {rows.length > PREVIEW_LIMIT && (
                <p className="px-3 py-2 text-[11px] text-ink-faint tabular-nums">
                  …and {(rows.length - PREVIEW_LIMIT).toLocaleString()} more rows, counted in the figures above.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={runImport} loading={importing} disabled={totals.toCreate === 0}>
                {totals.toCreate === 0 ? 'Nothing to import' : `Import ${totals.toCreate.toLocaleString()} customer${totals.toCreate !== 1 ? 's' : ''}`}
              </Button>
              {totals.detected - totals.toCreate > 0 && (
                <Button variant="ghost" onClick={downloadLeftovers}>
                  <Download className="w-4 h-4" /> Download the {(totals.detected - totals.toCreate).toLocaleString()} that won’t be
                </Button>
              )}
            </div>
            {totals.toCreate === 0 && totals.existing === totals.detected && totals.detected > 0 && (
              <p className="text-xs text-ink-muted">Every row in this file is already in EdgeQuote. Importing it again would change nothing.</p>
            )}
          </CardBody>
        </Card>
      )}
    </PageContainer>
  )
}

function Figure({ n, label, tone }: { n: number; label: string; tone: Tone }) {
  const colour: Record<Tone, string> = {
    success: 'text-emerald-400', warn: 'text-amber-400', danger: 'text-rose-400',
    neutral: 'text-ink', accent: 'text-accent-text', info: 'text-sky-400',
  }
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className={`text-xl font-semibold tabular-nums ${n === 0 ? 'text-ink-faint' : colour[tone]}`}>{n.toLocaleString()}</p>
      <p className="text-[11px] text-ink-muted">{label}</p>
    </div>
  )
}
