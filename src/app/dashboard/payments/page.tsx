'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Payment, BusinessSettings, Invoice, PAYMENT_METHODS, paymentMethodLabel } from '@/types'
import { receiptNumberFor, recordDeposit } from '@/lib/payments/ledger'
import { summarizeTransactions, creditBalances, ledgerRowType, cashAmountOf } from '@/lib/payments/analytics'
import { exportRowsToCsv, type CsvColumn } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { toast } from '@/lib/toast'
import { formatCurrency, formatDate, toLocalISO, cn } from '@/lib/utils'
import { Wallet, FileDown, Search, AlertTriangle, Gift, Plus, X, Receipt } from 'lucide-react'

// The payments DESTINATION. Every one of these questions was previously unanswerable:
// "how much did I refund last quarter", "which customers hold my money", "what did
// this cheque pay for", "export my payments for the accountant". The ledger had the
// answers the whole time — there was just nowhere to look. The command palette could
// find a payment but had nowhere to send you.
//
// Read-only over the ledger except for one write (take a deposit), which goes through
// the ledger engine like everything else. No new money rules live here.

type Kind = 'all' | 'payments' | 'refunds' | 'credits'
type Range = '30' | '90' | '365' | 'all'

const RANGE_LABEL: Record<Range, string> = { '30': 'Last 30 days', '90': 'Last 90 days', '365': 'Last year', all: 'All time' }

// Bounded on purpose. PostgREST silently caps rows, and a payments report that
// quietly drops its tail is worse than one that admits it — so we ask for one more
// than we show and say so when there's more.
const LIMIT = 1000

// The export pages the ledger in batches of this size until a short one comes back —
// the same idiom the reports page uses. The screen stays capped at LIMIT; the FILE
// does not, because a truncated accounting export is wrong in a way that looks right.
const PAGE_ROWS = 1000

type Row = Payment & { customers?: { name: string } | null; invoices?: { invoice_number: string } | null }

// The range → cutoff rule, shared by the screen's fetch and the export's fetch so the
// file can never cover a different window than the filter pill says it does.
function sinceIsoFor(range: Range): string | null {
  return range === 'all' ? null : new Date(Date.now() - Number(range) * 86_400_000).toISOString()
}

// The LOCAL date of a ledger row. `.slice(0, 10)` on a UTC timestamp is a
// quarter-boundary bug, not a formatting nit: in Alberta a June 30 6:30pm refund
// stamps 2026-07-01 and gets filed in the WRONG QUARTER.
function localDateOf(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : toLocalISO(d)
}

// The filter predicate, factored out of the render so the EXPORT can apply the exact
// same rule to the complete paged set that the screen applies to its first LIMIT rows.
// Two copies of "what the owner is looking at" would drift, and the copy that drifts
// is the one an accountant files from.
function filterRows(rows: Row[], q: string, kind: Kind): Row[] {
  const needle = q.trim().toLowerCase()
  const asNum = Number(needle.replace(/[^0-9.]/g, ''))
  return rows.filter(r => {
    const amt = Number(r.amount) || 0
    if (kind === 'payments' && !(r.kind === 'payment' && amt >= 0)) return false
    if (kind === 'refunds' && !(r.kind === 'payment' && amt < 0)) return false
    if (kind === 'credits' && r.kind !== 'credit') return false
    if (!needle) return true
    const hay = [
      r.customers?.name, r.invoices?.invoice_number, r.notes,
      paymentMethodLabel(r.method || r.provider), receiptNumberFor(r.id),
    ].filter(Boolean).join(' ').toLowerCase()
    if (hay.includes(needle)) return true
    // Amount search: "120" finds $120.00. Only when the query looks numeric.
    return needle.length > 0 && Number.isFinite(asNum) && asNum > 0 && Math.abs(amt) === asNum
  })
}

// The export's columns. Defined once, next to the predicate, because they describe the
// same report.
//
// There is deliberately NO bare `Amount` column. A $200 deposit writes a cash row AND a
// credit row, and settling it later writes a THIRD row that is kind='payment' with a
// POSITIVE amount — so one summable Amount column reads $400 of revenue against $200 of
// cash. Every row's amount lands in exactly one of Cash/Credit instead: lossless, and no
// single column can double-count. Cash Amount ties to the Collected tile above the export
// button by construction — both are isCashRow, via the one classifier.
const CSV_COLUMNS: CsvColumn<Row>[] = [
  { label: 'Date', value: r => localDateOf(r.paid_at || r.created_at) },
  { label: 'Receipt', value: r => receiptNumberFor(r.id) },
  { label: 'Customer', value: r => r.customers?.name || '' },
  { label: 'Invoice', value: r => r.invoices?.invoice_number || '' },
  { label: 'Type', value: r => ledgerRowType(r) },
  { label: 'Method', value: r => paymentMethodLabel(r.method || r.provider) },
  // Blank, not 0.00, for a non-cash row — a zero would read as "this moved no money",
  // when the truth is "this row is not cash at all".
  { label: 'Cash Amount', value: r => cashAmountOf(r) || '' },
  { label: 'Credit Amount', value: r => (r.kind === 'credit' ? Number(r.amount) || 0 : '') },
  { label: 'Currency', value: r => (r.currency || 'cad').toUpperCase() },
  { label: 'Note', value: r => r.notes || '' },
]

export default function PaymentsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [uid, setUid] = useState<string | null>(null)
  // The export now hits the network (it pages the full range), so it can't be instant
  // and it must not be double-clicked into two downloads.
  const [exporting, setExporting] = useState(false)

  // ?q= lets the command palette land on one exact payment (it passes the receipt
  // number). Read once at mount, the same idiom the invoices list uses for ?invoice=.
  const [q, setQ] = useState(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('q') || ''
  })
  const [kind, setKind] = useState<Kind>('all')
  const [range, setRange] = useState<Range>('90')
  const [receiptId, setReceiptId] = useState<string | null>(null)

  // Take-a-deposit form (the only write on this page).
  const [depOpen, setDepOpen] = useState(false)
  const [depCustomer, setDepCustomer] = useState('')
  const [depAmount, setDepAmount] = useState('')
  const [depMethod, setDepMethod] = useState('etransfer')
  const [depBusy, setDepBusy] = useState(false)
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])

  async function fetchAll() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoadError('Session expired — sign in again.'); setLoading(false); return }
    setUid(user.id)
    const sinceIso = sinceIsoFor(range)
    let query = supabase.from('payments')
      .select('*, customers(name), invoices(invoice_number)')
      .eq('user_id', user.id)
      .order('paid_at', { ascending: false })
      .limit(LIMIT + 1)
    if (sinceIso) query = query.gte('paid_at', sinceIso)
    const [pRes, sRes, cRes] = await Promise.all([
      query,
      supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('customers').select('id, name').eq('user_id', user.id).order('name'),
    ])
    // A failed read must never render as "no payments" — an empty ledger and a broken
    // query look identical to someone reconciling their books.
    if (pRes.error) { setLoadError('Could not load payments: ' + pRes.error.message); setLoading(false); return }
    const all = (pRes.data as unknown as Row[]) || []
    setTruncated(all.length > LIMIT)
    setRows(all.slice(0, LIMIT))
    setSettings((sRes.data as BusinessSettings) || null)
    setCustomers((cRes.data as { id: string; name: string }[]) || [])
    setLoadError(null)
    setLoading(false)
  }

  useEffect(() => { setLoading(true); fetchAll() }, [range]) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('payments', uid ? `user_id=eq.${uid}` : null, fetchAll)

  // Filter + search over what's loaded (same client-side idiom the invoices list uses).
  const visible = useMemo(() => filterRows(rows, q, kind), [rows, q, kind])

  const summary = useMemo(() => summarizeTransactions(visible), [visible])
  const nameOf = useMemo(() => {
    const m = new Map(customers.map(c => [c.id, c.name]))
    return (id: string) => m.get(id) || 'Unknown customer'
  }, [customers])
  // Credit balances read the WHOLE loaded window, not the filtered view — "who holds
  // my money" must not change because someone typed in the search box.
  const credit = useMemo(() => creditBalances(rows, nameOf), [rows, nameOf])

  async function downloadReceipt(r: Row) {
    if (!r.invoices) { toast.error('This payment isn’t attached to an invoice, so it has no receipt.'); return }
    setReceiptId(r.id)
    try {
      const [{ renderReceiptBlob }, { downloadBlob }] = await Promise.all([
        import('@/components/payments/ReceiptPDF'), import('@/lib/portalPdf'),
      ])
      downloadBlob(await renderReceiptBlob(r, r.invoices as unknown as Invoice, settings), `${receiptNumberFor(r.id)}.pdf`)
    } catch { toast.error('Could not generate the receipt PDF.') }
    setReceiptId(null)
  }

  // The filters ARE the report definition, so an accountant gets the rows the owner is
  // looking at — but the SCREEN stops at LIMIT and the FILE must not. This re-runs the
  // same filtered query paged to exhaustion, so the export covers the whole range
  // instead of the first 1000 rows under a cheerful "Exported 1000 rows" with no
  // caveat. A silently incomplete accounting export is the worst kind: it looks
  // finished. The on-screen cap (and its banner) stay as they are — scrolling 10,000
  // rows is a real cost; a wrong tax return is a bigger one.
  async function exportCsv() {
    if (!uid) return
    setExporting(true)
    try {
      const sinceIso = sinceIsoFor(range)
      const all: Row[] = []
      for (let from = 0; ; from += PAGE_ROWS) {
        let query = supabase.from('payments')
          .select('*, customers(name), invoices(invoice_number)')
          .eq('user_id', uid)
          .order('paid_at', { ascending: false })
          // Stable tiebreak: without it a row can repeat or vanish at a page boundary
          // when several payments share a paid_at.
          .order('id')
          .range(from, from + PAGE_ROWS - 1)
        if (sinceIso) query = query.gte('paid_at', sinceIso)
        const { data, error } = await query
        // A partial file must never download. Half a ledger that claims to be a whole
        // one is exactly the failure this function exists to prevent.
        if (error) { toast.error('Could not build the export: ' + error.message); return }
        const batch = (data as unknown as Row[]) || []
        all.push(...batch)
        if (batch.length < PAGE_ROWS) break
      }
      // The identical predicate the screen uses — applied to every row, not the first page.
      const out = filterRows(all, q, kind)
      if (out.length === 0) { toast.error('Nothing to export with these filters.'); return }
      exportRowsToCsv(`payments-${new Date().toISOString().slice(0, 10)}`, out, CSV_COLUMNS)
      toast.success(`Exported ${out.length} row${out.length !== 1 ? 's' : ''}.`)
    } finally {
      setExporting(false)
    }
  }

  async function saveDeposit() {
    if (!uid) return
    setDepBusy(true)
    const res = await recordDeposit(supabase, {
      userId: uid, customerId: depCustomer, amount: Number(depAmount), method: depMethod,
    })
    setDepBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success(`${formatCurrency(Number(depAmount))} deposit recorded — it’s held as credit until you invoice.`)
    setDepOpen(false); setDepAmount(''); setDepCustomer('')
    fetchAll()
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Payments"
        description={loading ? 'Loading…' : `${visible.length} transaction${visible.length !== 1 ? 's' : ''} · ${RANGE_LABEL[range].toLowerCase()}`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDepOpen(o => !o)}>
              <Plus className="w-3.5 h-3.5" /> Take a deposit
            </Button>
            <Button size="sm" variant="secondary" onClick={exportCsv} loading={exporting}
              disabled={visible.length === 0 || exporting}
              title={visible.length === 0 ? 'Nothing to export with these filters.' : 'Exports every transaction in this range, not just the ones on screen.'}>
              <FileDown className="w-3.5 h-3.5" /> Export CSV
            </Button>
          </div>
        }
      />

      {loadError && <Banner tone="danger" icon={AlertTriangle}
        action={<button type="button" onClick={() => { setLoading(true); fetchAll() }} className="shrink-0 underline font-semibold">Retry</button>}>
        {loadError}
      </Banner>}

      {/* Deposit — money taken before there's an invoice. Held as credit; it settles
          automatically the next time credit is applied to one of their invoices. */}
      {depOpen && (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-ink flex items-center gap-2"><Gift className="w-4 h-4 text-accent-text" /> Take a deposit</p>
              <button type="button" onClick={() => setDepOpen(false)} aria-label="Close"
                className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Select label="Customer" fieldSize="sm" value={depCustomer} placeholder="Choose a customer"
                onChange={e => setDepCustomer(e.target.value)}
                options={customers.map(c => ({ value: c.id, label: c.name }))} />
              <Input label="Amount" fieldSize="sm" type="number" min="0" step="0.01" value={depAmount}
                onChange={e => setDepAmount(e.target.value)} placeholder="0.00" />
              <Select label="How it arrived" fieldSize="sm" value={depMethod}
                onChange={e => setDepMethod(e.target.value)}
                options={PAYMENT_METHODS.filter(m => m.value !== 'credit').map(m => ({ value: m.value, label: m.label }))} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" loading={depBusy} disabled={!depCustomer || !(Number(depAmount) > 0)}
                title={!depCustomer ? 'Choose a customer.' : !(Number(depAmount) > 0) ? 'Enter an amount.' : undefined}
                onClick={saveDeposit}>Record deposit</Button>
              <Button size="sm" variant="ghost" onClick={() => setDepOpen(false)}>Cancel</Button>
            </div>
            <p className="text-[11px] text-ink-faint">
              Counts as money collected today and is held as credit for {depCustomer ? nameOf(depCustomer) : 'the customer'} — they can see it in their portal straight away.
              When you invoice the job, apply the credit and the balance drops.
            </p>
          </CardBody>
        </Card>
      )}

      {/* Money over the CURRENT filters — the report and the numbers can't disagree
          because they're the same rows. */}
      {!loading && !loadError && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <StatTile label="Collected" value={formatCurrency(summary.collected)} tone="accent" />
          <StatTile label="Refunded" value={summary.refunded > 0 ? `−${formatCurrency(summary.refunded)}` : formatCurrency(0)} />
          <StatTile label="Net" value={formatCurrency(summary.net)} />
          <StatTile label="Payments" value={String(summary.count)} />
        </div>
      )}

      {/* Search + filters */}
      <div className="space-y-3">
        <Input aria-label="Search payments" fieldSize="sm" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search by customer, invoice, receipt #, method, note or amount…" />
        <div className="flex items-center gap-2 flex-wrap">
          {(['all', 'payments', 'refunds', 'credits'] as Kind[]).map(k => (
            <FilterPill key={k} active={kind === k} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k.charAt(0).toUpperCase() + k.slice(1)}
            </FilterPill>
          ))}
          <span className="ml-auto flex items-center gap-2">
            {(['30', '90', '365', 'all'] as Range[]).map(r => (
              <FilterPill key={r} active={range === r} onClick={() => setRange(r)}>{RANGE_LABEL[r]}</FilterPill>
            ))}
          </span>
        </div>
      </div>

      {truncated && (
        <Banner tone="warn" icon={AlertTriangle}>
          Showing the most recent {LIMIT} transactions — there are more in this range, so the totals above count only these. The CSV export covers the range in full; narrow the dates to make the totals on screen complete too.
        </Banner>
      )}

      {/* Method mix — only once there's something to compare. */}
      {!loading && summary.byMethod.length > 1 && (
        <Card>
          <CardBody>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">How they paid</p>
            <div className="space-y-1.5">
              {summary.byMethod.map(m => (
                <div key={m.method} className="flex items-center gap-3">
                  <span className="text-xs text-ink w-28 shrink-0 truncate">{paymentMethodLabel(m.method)}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full rounded-full bg-accent"
                      style={{ width: `${summary.collected > 0 ? Math.max(2, (m.total / summary.collected) * 100) : 0}%` }} />
                  </div>
                  <span className="text-xs font-semibold text-ink tabular-nums w-20 text-right shrink-0">{formatCurrency(m.total)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Transactions */}
      {loading ? <SkeletonRows count={6} /> : visible.length === 0 ? (
        rows.length === 0
          ? <EmptyState icon={Wallet} title="No payments yet"
              description="Every payment, refund and credit lands here the moment it's recorded — with a receipt you can hand to anyone." />
          : <InlineEmpty>No transactions match these filters.</InlineEmpty>
      ) : (
        <Card>
          <CardBody className="p-0">
            <div className="divide-y divide-border">
              {visible.map(r => {
                const amt = Number(r.amount) || 0
                const isCredit = r.kind === 'credit'
                const isRefund = !isCredit && amt < 0
                return (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate">
                        <span className="font-medium">{r.customers?.name || 'Unknown customer'}</span>
                        {r.invoices?.invoice_number && <span className="text-ink-faint"> · {r.invoices.invoice_number}</span>}
                      </p>
                      <p className="text-[11px] text-ink-faint truncate">
                        {formatDate(r.paid_at || r.created_at)} · {isCredit ? (amt >= 0 ? 'Credit added' : 'Credit applied') : paymentMethodLabel(r.method || r.provider)}
                        <span className="font-mono"> · {receiptNumberFor(r.id)}</span>
                        {r.notes ? ` · ${r.notes}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={cn('text-sm font-bold tabular-nums',
                        isCredit ? 'text-violet-400' : isRefund ? 'text-red-400' : 'text-emerald-400')}>
                        {amt < 0 ? '−' : ''}{formatCurrency(Math.abs(amt))}
                      </span>
                      {!isCredit && r.invoices && (
                        <button onClick={() => downloadReceipt(r)} disabled={receiptId === r.id}
                          className="p-1.5 rounded-lg text-ink-faint hover:text-accent-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          aria-label={isRefund ? `Download refund receipt ${receiptNumberFor(r.id)}` : `Download receipt ${receiptNumberFor(r.id)}`}
                          title={`Download ${isRefund ? 'refund receipt' : 'receipt'} ${receiptNumberFor(r.id)}`}>
                          <FileDown className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Who holds your money. The customer could see this in their portal; the owner
          had no screen for it at all. */}
      {!loading && !loadError && (credit.balances.length > 0 || credit.negative.length > 0) && (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-ink flex items-center gap-2"><Gift className="w-4 h-4 text-accent-text" /> Customer credit</p>
              <p className="text-xs text-ink-muted">{formatCurrency(credit.total)} held across {credit.balances.length} customer{credit.balances.length !== 1 ? 's' : ''}</p>
            </div>
            <p className="text-[11px] text-ink-faint">Money you&rsquo;re holding for them — deposits and overpayments. It applies itself to their next invoice when you tap Apply credit.</p>
            <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
              {credit.balances.map(b => (
                <a key={b.customerId} href={`/dashboard/customers/${b.customerId}`}
                  className="flex items-center justify-between gap-3 px-2.5 py-2 hover:bg-bg-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <span className="text-xs text-ink truncate">{b.name}</span>
                  <span className="text-xs font-semibold text-violet-400 tabular-nums shrink-0">{formatCurrency(b.balance)}</span>
                </a>
              ))}
            </div>
            {/* A negative balance is impossible if the ledger guards held. Say so loudly
                rather than clamping it to zero and hiding a broken invariant. */}
            {credit.negative.map(b => (
              <p key={b.customerId} className="text-[11px] text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {b.name} shows {formatCurrency(b.balance)} of credit — that shouldn&rsquo;t be possible. Their credit ledger needs a look.
              </p>
            ))}
          </CardBody>
        </Card>
      )}

      {!loading && !loadError && rows.length > 0 && (
        <p className="text-[11px] text-ink-faint flex items-center gap-1.5">
          <Receipt className="w-3 h-3 shrink-0" />
          Every row is a real ledger movement — nothing here is estimated or rounded for display.
        </p>
      )}
    </div>
  )
}
