'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Invoice, Payment, BusinessSettings, INVOICE_STATUS_LABELS, paymentMethodLabel } from '@/types'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { invoiceBalance } from '@/lib/payments/ledger'
import { ledgerRowType, cashAmountOf } from '@/lib/payments/analytics'
import { exportRowsToCsv } from '@/lib/csv'
import { fetchAllRows } from '@/lib/fetchAll'
import { downloadBlob } from '@/lib/portalPdf'
import type { RevenueGstReport, RevenueGstRow } from '@/components/reports/RevenueGstPDF'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { StatTile } from '@/components/ui/StatTile'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { formatCurrency, toLocalISO } from '@/lib/utils'
import { FileText, FileDown, Receipt, DollarSign, Percent, Clock, AlertTriangle, Info } from 'lucide-react'

// ── Reports & Exports ─────────────────────────────────────────────────────────
// The accountant handoff: pick a period, take the three files your bookkeeper
// actually asks for. This page READS — it never writes and it never defines a
// number. Every figure comes from the SAME engines the invoices list, the portal,
// the PDFs and the Stripe charge routes read (invoiceTotals + the payment ledger),
// so a quarter filed from here can't disagree with what the app showed all along.

// The invoice fields this report reads — a narrow projection of the canonical
// Invoice type (never re-declared, so a schema change lands here too). The Pick
// also satisfies invoiceBalance()'s parameter exactly.
type ReportInvoice = Pick<Invoice,
  | 'id' | 'invoice_number' | 'amount' | 'amount_paid' | 'status' | 'issued_date' | 'due_date'
  | 'discount_type' | 'discount_value' | 'customer_id' | 'customer_name' | 'service_type'
> & { customers?: { id: string; name: string } | null }

// `provider` is load-bearing, not decoration: it is the ONLY field that separates
// an invoice settled from credit (kind='payment', provider='credit', amount > 0)
// from cash arriving. Without it neither ledgerRowType nor cashAmountOf can tell
// them apart, and a $200 deposit exports as $400 of revenue.
type ReportPayment = Pick<Payment,
  'id' | 'amount' | 'method' | 'provider' | 'paid_at' | 'kind' | 'status' | 'invoice_id' | 'customer_id'
> & { customers?: { id: string; name: string } | null }

// GST is filed quarterly OR annually in Canada — both are first-class here, not a
// date-range the owner has to remember the boundaries of.
type QuarterKey = '' | 'Q1' | 'Q2' | 'Q3' | 'Q4'
const QUARTERS: { value: QuarterKey; label: string; from: number; to: number }[] = [
  { value: '',   label: 'All year',      from: 1,  to: 12 },
  { value: 'Q1', label: 'Q1 (Jan–Mar)',  from: 1,  to: 3 },
  { value: 'Q2', label: 'Q2 (Apr–Jun)',  from: 4,  to: 6 },
  { value: 'Q3', label: 'Q3 (Jul–Sep)',  from: 7,  to: 9 },
  { value: 'Q4', label: 'Q4 (Oct–Dec)',  from: 10, to: 12 },
]

// Period membership straight off the 'YYYY-MM-DD' string — no Date parsing, so a
// December invoice can't fall into the previous year on a UTC boundary.
function inPeriod(iso: string | null | undefined, year: string, q: { from: number; to: number }): boolean {
  if (!iso) return false
  if (iso.slice(0, 4) !== year) return false
  const m = Number(iso.slice(5, 7))
  return m >= q.from && m <= q.to
}

function customerNameOf(row: { customers?: { name: string } | null; customer_name?: string | null }): string {
  return row.customers?.name || row.customer_name || '—'
}

export default function ReportsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<ReportInvoice[]>([])
  const [payments, setPayments] = useState<ReportPayment[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [quarter, setQuarter] = useState<QuarterKey>('')
  const [busy, setBusy] = useState<null | 'pdf' | 'invoices' | 'payments'>(null)

  async function load() {
    try {
      // Local session read — no auth round-trip before the RLS-scoped fetch batch.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      const [iRes, pRes, sRes] = await Promise.all([
        fetchAllRows<ReportInvoice>(async (from, to) => {
          const { data, error } = await supabase
            .from('invoices')
            .select('id, invoice_number, amount, amount_paid, status, issued_date, due_date, discount_type, discount_value, customer_id, customer_name, service_type, customers(id, name)')
            .eq('user_id', user.id)
            .order('issued_date', { ascending: true, nullsFirst: true })
            .order('id')
            .range(from, to)
          return { data: data as unknown as ReportInvoice[] | null, error }
        }),
        fetchAllRows<ReportPayment>(async (from, to) => {
          const { data, error } = await supabase
            .from('payments')
            .select('id, amount, method, provider, paid_at, kind, status, invoice_id, customer_id, customers(id, name)')
            .eq('user_id', user.id)
            .order('paid_at', { ascending: true, nullsFirst: true })
            .order('id')
            .range(from, to)
          return { data: data as unknown as ReportPayment[] | null, error }
        }),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      ])
      // A failed fetch must NOT render as "$0.00 this quarter" on the page someone
      // files a return from. Say so, and offer the retry.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error); return }
      if (pRes.error) { setLoadError('Could not load payments: ' + pRes.error); return }
      setLoadError(null)
      setInvoices(iRes.rows)
      setPayments(pRes.rows)
      setSettings(sRes.data as BusinessSettings | null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the reports.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Only offer years the books actually contain — an empty year is a dead end the
  // owner has to discover by picking it.
  const years = useMemo(() => {
    const set = new Set<string>()
    for (const inv of invoices) if (inv.issued_date) set.add(inv.issued_date.slice(0, 4))
    const list = Array.from(set).sort((a, b) => b.localeCompare(a))
    return list.length ? list : [String(new Date().getFullYear())]
  }, [invoices])

  // The default year (this year) may not exist in the books — snap to the newest
  // year there IS, so the page never opens on an empty period it can't explain.
  useEffect(() => {
    if (years.length && !years.includes(year)) setYear(years[0])
  }, [years, year])

  const q = QUARTERS.find(x => x.value === quarter) ?? QUARTERS[0]
  const periodLabel = `${year} · ${q.value ? q.label : 'Full year'}`
  const fileSuffix = q.value ? `${year}-${q.value}` : year

  // ── The period's figures — every one of them read through the shared engines ──
  const period = useMemo(() => {
    // Cancelled invoices are void paper: they bill nothing and they owe nothing, so
    // they're out of every total (the same rule the invoices list applies).
    //
    // DRAFTS ARE OUT TOO, and that is the whole point of this document. Completing a
    // job auto-drafts an invoice stamped with today's issued_date (lib/invoicing), so
    // a draft lands in the period looking exactly like billed work — but it has never
    // been sent to anyone. This statement says "invoices issued in this period"; you
    // do not charge a customer, and you do not remit GST, on paper that never left
    // the building. Counting them would make the sentence false and the GST figure
    // too high. They're surfaced as their own disclosed line instead of vanishing.
    const inScope = invoices.filter(i => inPeriod(i.issued_date, year, q) && i.status !== 'cancelled')
    const rows = inScope.filter(i => i.status !== 'draft')
    const built = rows.map(inv => {
      // THE totals engine — never `amount * 1.05`. `discountedSubtotal` is the net
      // (post-discount) revenue; GST + total come off that same net, so this page's
      // figures are byte-identical to the invoice, the PDF and the charge route.
      const t = invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value })
      const b = invoiceBalance(inv, settings)
      return { inv, t, b }
    })
    const sum = (f: (x: typeof built[number]) => number) => Math.round(built.reduce((s, x) => s + f(x), 0) * 100) / 100

    const gstPercent = invoiceTotals(0, settings).gstPercent // one reading of gst_percent, via the engine

    // Money collected against these invoices (the ledger's amount_paid), and what's
    // still owed. Outstanding clamps at zero per invoice — the app's existing
    // definition (an overpaid invoice owes nothing; the ledger resolves it to credit).
    const rowsForPdf: RevenueGstRow[] = built.map(({ inv, t, b }) => ({
      invoiceNumber: inv.invoice_number,
      issuedDate: inv.issued_date,
      customerName: customerNameOf(inv),
      net: t.discountedSubtotal,
      gst: t.gstAmount,
      total: t.total,
      paid: b.balance <= 0.01,
      balance: b.balance,
    }))

    // Drafts, excluded above and reported on their own so they're visible rather
    // than silently missing — unsent work the owner may still want to bill.
    const drafts = inScope.filter(i => i.status === 'draft')
    const draftTotal = Math.round(
      drafts.reduce((s, i) => s + invoiceTotals(i.amount, settings, { type: i.discount_type, value: i.discount_value }).total, 0) * 100,
    ) / 100

    // `generatedAt` is deliberately NOT stamped here: this memo can be minutes old
    // by the time anyone clicks Download, and a stamp that says when React last
    // recomputed is worse than none. The download handler stamps the real moment.
    const report: Omit<RevenueGstReport, 'generatedAt'> = {
      periodLabel,
      gstPercent,
      rows: rowsForPdf,
      totals: {
        net: sum(x => x.t.discountedSubtotal),
        gst: sum(x => x.t.gstAmount),
        total: sum(x => x.t.total),
        paid: sum(x => x.b.paid),
        outstanding: sum(x => Math.max(0, x.b.balance)),
        count: built.length,
      },
      // Carried onto the PDF: the on-screen note below doesn't travel with the file.
      excludedDrafts: { count: drafts.length, total: draftTotal },
    }

    const pays = payments.filter(p => p.paid_at && inPeriod(toLocalISO(new Date(p.paid_at)), year, q))

    return { built, report, drafts: drafts.length, draftTotal, pays }
  }, [invoices, payments, settings, year, q, periodLabel])

  // Invoice # for a payment — resolved from the invoices already in memory (every
  // one of this user's invoices is loaded), so the payments export needs no join.
  const invoiceNumberById = useMemo(() => {
    const m: Record<string, string> = {}
    for (const inv of invoices) m[inv.id] = inv.invoice_number
    return m
  }, [invoices])

  // ── The three exports ───────────────────────────────────────────────────────
  async function exportPdf() {
    setBusy('pdf')
    try {
      // Dynamic import — the PDF renderer is a heavy dependency that must not sit in
      // this page's bundle for the owner who only came to read the summary.
      const { renderRevenueGstBlob } = await import('@/components/reports/RevenueGstPDF')
      // settings may legitimately be null on a brand-new account; the doc renders
      // from its own fallbacks, same as renderInvoiceBlob.
      // Stamp the moment the paper is actually produced — see the memo's note.
      const blob = await renderRevenueGstBlob({ ...period.report, generatedAt: new Date().toISOString() }, settings)
      downloadBlob(blob, `revenue-gst-${fileSuffix}.pdf`)
    } catch {
      toast.error('Could not generate the Revenue & GST PDF. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  function exportInvoicesCsv() {
    setBusy('invoices')
    try {
      // Money as plain numbers and dates as ISO — this file exists to be summed and
      // sorted in a spreadsheet, not read. formatCurrency would make every column text.
      exportRowsToCsv(`invoices-${fileSuffix}.csv`, period.built, [
        { label: 'Invoice #',     value: x => x.inv.invoice_number },
        { label: 'Issued',        value: x => x.inv.issued_date ?? '' },
        { label: 'Due',           value: x => x.inv.due_date ?? '' },
        { label: 'Customer',      value: x => customerNameOf(x.inv) },
        { label: 'Service',       value: x => x.inv.service_type ?? '' },
        { label: 'Revenue (net)', value: x => x.t.discountedSubtotal },
        { label: 'GST',           value: x => x.t.gstAmount },
        { label: 'Total',         value: x => x.t.total },
        { label: 'Paid',          value: x => x.b.paid },
        { label: 'Balance',       value: x => x.b.balance },
        { label: 'Status',        value: x => INVOICE_STATUS_LABELS[x.inv.status] },
      ])
    } catch {
      toast.error('Could not build the invoices CSV. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  function exportPaymentsCsv() {
    setBusy('payments')
    try {
      // Refunds (negative) and credit movements go out exactly as the ledger holds
      // them. Dropping or abs()-ing them would hand the bookkeeper a collected total
      // that never happened.
      //
      // There is deliberately NO bare `Amount` column. A $200 deposit writes a cash
      // row AND a credit row, and settling it later writes a THIRD row that is
      // kind='payment' with a positive amount — so one summable Amount column reads
      // $400 of revenue against $200 of cash. Every row's amount lands in exactly
      // one of Cash/Credit instead: lossless, and no column can double-count.
      // Cash Amount is the only column a bookkeeper should sum, and it ties to the
      // dashboard's Collected tile by construction — both are isCashRow.
      exportRowsToCsv(`payments-${fileSuffix}.csv`, period.pays, [
        // The unique key. Without it a re-import silently duplicates every row.
        { label: 'Payment ID',    value: p => p.id },
        // The LOCAL date. A .slice(0,10) on a UTC timestamp files an Alberta evening
        // payment into the next day — and, on the 30th, into the next QUARTER.
        { label: 'Date',          value: p => (p.paid_at ? toLocalISO(new Date(p.paid_at)) : '') },
        { label: 'Type',          value: p => ledgerRowType(p) },
        { label: 'Customer',      value: p => customerNameOf(p) },
        { label: 'Invoice #',     value: p => (p.invoice_id ? invoiceNumberById[p.invoice_id] ?? '' : '') },
        // `method || provider`: the Stripe webhook never sets `method`, so `method`
        // alone renders every card sale as the useless label 'Payment'. Matches the
        // fallback summarizeTransactions already groups by.
        { label: 'Method',        value: p => paymentMethodLabel(p.method || p.provider) },
        // Blank, not 0.00, for a non-cash row — a zero would read as "this moved no
        // money", when the truth is "this row is not cash at all".
        { label: 'Cash Amount',   value: p => cashAmountOf(p) || '' },
        { label: 'Credit Amount', value: p => (p.kind === 'credit' ? Number(p.amount) || 0 : '') },
        { label: 'Status',        value: p => p.status },
      ])
    } catch {
      toast.error('Could not build the payments CSV. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  // Skeleton lands inside the SAME container + header as the loaded page, so
  // nothing jumps when the numbers arrive.
  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }}
          title="Reports & Exports"
          description="Pick a period, hand your bookkeeper the file." />
        <SkeletonTiles count={4} />
        <SkeletonRows count={3} />
      </div>
    )
  }

  const t = period.report.totals
  const nothingHere = t.count === 0 && period.pays.length === 0

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }}
        title="Reports & Exports"
        description="Pick a period, hand your bookkeeper the file." />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<button type="button" onClick={() => { setLoading(true); load() }} className="shrink-0 underline font-semibold">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {/* Period picker — the one control the whole page hangs off. */}
      <Card>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full sm:w-40">
            <Select label="Year" fieldSize="sm" value={year} onChange={e => setYear(e.target.value)}
              options={years.map(y => ({ value: y, label: y }))} />
          </div>
          <div className="w-full sm:w-56">
            <Select label="Period" fieldSize="sm" value={quarter} onChange={e => setQuarter(e.target.value as QuarterKey)}
              options={QUARTERS.map(x => ({ value: x.value, label: x.label }))} />
          </div>
          <p className="text-xs text-ink-faint sm:pb-2">Showing <span className="font-semibold text-ink-muted">{periodLabel}</span></p>
        </CardBody>
      </Card>

      {/* The period in four numbers — the same four the exports carry. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile icon={DollarSign} label="Revenue (net)" value={formatCurrency(t.net)} accent
          sub="Before GST, after discounts" />
        <StatTile icon={Percent} label="GST charged" value={formatCurrency(t.gst)}
          sub={period.report.gstPercent > 0 ? `${period.report.gstPercent}% — set in Settings` : 'No GST rate set'} />
        <StatTile icon={FileText} label="Total billed" value={formatCurrency(t.total)}
          sub="Revenue + GST" />
        <StatTile icon={Clock} label="Outstanding" value={formatCurrency(t.outstanding)} tone={t.outstanding > 0 ? 'warn' : undefined}
          sub={`${formatCurrency(t.paid)} collected`} />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-ink-muted tabular-nums">
          {t.count} invoice{t.count !== 1 ? 's' : ''} issued in {periodLabel}
          {period.pays.length > 0 && <> · {period.pays.length} payment{period.pays.length !== 1 ? 's' : ''} received</>}
          . Cancelled and draft invoices are excluded.
        </p>
        {/* Completing a job auto-drafts an invoice stamped with today's date, so a
            draft sits inside the period looking exactly like billed work. It isn't:
            nobody has been asked to pay it. It's excluded from every figure above,
            and surfaced here so unsent work is visible rather than silently missing. */}
        {period.drafts > 0 && (
          <p className="text-xs text-amber-400 tabular-nums">
            {period.drafts} draft{period.drafts !== 1 ? 's' : ''} ({formatCurrency(period.draftTotal)}) not yet sent — excluded above. Send them to bill this period.
          </p>
        )}
        {/* The honest limit of this page, stated on the page rather than discovered by
            an accountant. EdgeQuote has no expense side, so no figure here can be
            earnings — and none of them are labelled as if they were. */}
        <p className="text-xs text-ink-faint flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
          <span>
            EdgeQuote doesn&rsquo;t track expenses, so this is a <span className="font-medium text-ink-muted">revenue summary</span> —
            what you billed and collected. It is not a profit statement; your bookkeeper still needs your costs to work that out.
          </span>
        </p>
      </div>

      {nothingHere ? (
        <Card>
          <InlineEmpty icon={FileText}>
            Nothing was invoiced or collected in {periodLabel}. Try another period.
          </InlineEmpty>
        </Card>
      ) : (
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <FileDown className="w-3.5 h-3.5 text-accent-text" />
            </span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Exports</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="p-0">
            <div className="divide-y divide-border">
              <ExportRow
                icon={FileDown}
                title="Revenue & GST Summary (PDF)"
                blurb={`Every invoice in ${periodLabel} with its net, GST and total — the sheet a bookkeeper files from.`}
                filename={`revenue-gst-${fileSuffix}.pdf`}
                count={t.count}
                noun="invoice"
                busy={busy === 'pdf'}
                disabled={busy !== null || t.count === 0}
                onRun={exportPdf}
              />
              <ExportRow
                icon={FileText}
                title="Invoices (CSV)"
                blurb="One row per invoice, money as plain numbers — open it in a spreadsheet and sum any column."
                filename={`invoices-${fileSuffix}.csv`}
                count={t.count}
                noun="invoice"
                busy={busy === 'invoices'}
                disabled={busy !== null || t.count === 0}
                onRun={exportInvoicesCsv}
              />
              <ExportRow
                icon={Receipt}
                title="Payments (CSV)"
                blurb="Every payment received in the period, by date paid — including refunds and credit movements."
                filename={`payments-${fileSuffix}.csv`}
                count={period.pays.length}
                noun="payment"
                busy={busy === 'payments'}
                disabled={busy !== null || period.pays.length === 0}
                onRun={exportPaymentsCsv}
              />
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

// One row per export — name, what's in it, how many rows, and the file you get.
// The count is on the row so the owner knows an export is empty BEFORE they open
// a blank file in Excel.
function ExportRow({ icon: Icon, title, blurb, filename, count, noun, busy, disabled, onRun }: {
  icon: typeof FileText
  title: string
  blurb: string
  filename: string
  count: number
  noun: string
  busy: boolean
  disabled: boolean
  onRun: () => void
}) {
  return (
    <div className="px-4 py-3.5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
          <Icon className="w-4 h-4 text-accent-text" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>
          <p className="text-[11px] text-ink-faint mt-1 tabular-nums">
            {count > 0 ? <>{count} {noun}{count !== 1 ? 's' : ''} · </> : <>Nothing to export · </>}
            <span className="font-mono">{filename}</span>
          </p>
        </div>
      </div>
      <div className="shrink-0 sm:self-center">
        <Button size="sm" variant="secondary" onClick={onRun} loading={busy} disabled={disabled}>
          <FileDown className="w-3.5 h-3.5" /> Download
        </Button>
      </div>
    </div>
  )
}
