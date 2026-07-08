'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Invoice, InvoiceStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { SendComms } from '@/components/comms/SendComms'
import { PaymentHistory } from '@/components/payments/PaymentHistory'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { toast as notify } from '@/lib/toast'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { FileText, User, Check, FileDown, Trash2, CreditCard, Zap, AlertTriangle } from 'lucide-react'

const STATUS_CYCLE: InvoiceStatus[] = ['unpaid', 'sent', 'paid']
const FILTERS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'sent', label: 'Sent' },
  { value: 'paid', label: 'Paid' },
]

export default function InvoicesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | InvoiceStatus>('')
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [chargingId, setChargingId] = useState<string | null>(null)
  const [cardCustomers, setCardCustomers] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  async function fetchInvoices() {
    try {
      // Local session read — no auth round-trip before the RLS-scoped fetch batch.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [iRes, sRes, pmRes] = await Promise.all([
        supabase
          .from('invoices')
          .select('*, customers(id, name, email, phone)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        // Which customers have a saved card → enables the "Charge saved card" action.
        supabase.from('payment_methods').select('customer_id').eq('user_id', user.id),
      ])
      // A failed fetch must NOT render as "No invoices yet" on billing day.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error.message); return }
      setLoadError(null)
      setInvoices((iRes.data as Invoice[]) || [])
      setSettings(sRes.data as BusinessSettings | null)
      setCardCustomers(new Set(((pmRes.data as { customer_id: string }[] | null) || []).map(r => r.customer_id)))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load invoices.')
    } finally {
      setLoading(false)
    }
  }

  // Owner-initiated charge of a saved card for a recurring invoice (bypasses the
  // AutoPay-enabled + anomaly checks — this is a deliberate manual action). The
  // webhook records the payment + flips the invoice, so realtime updates the row.
  async function chargeSavedCard(inv: Invoice) {
    if (chargingId) return
    setChargingId(inv.id)
    try {
      const res = await fetch('/api/payments/autopay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: inv.id, manual: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (d.result === 'charged') setToast(`Charging the saved card for ${inv.invoice_number} — the invoice will update shortly.`)
      else if (d.result === 'declined') setToast(`The card was declined for ${inv.invoice_number}. Try a payment link or ask the customer to update their card.`)
      else if (d.result === 'skipped' && d.reason === 'no-card') setToast('That customer has no saved card on file.')
      else if (d.result === 'skipped' && d.reason === 'already-charged') setToast('This invoice has already been charged.')
      else if (d.result === 'skipped' && d.reason === 'webhook-unconfigured') setToast('Configure the Stripe webhook before charging saved cards.')
      else if (!res.ok) setToast(d.error || 'Could not charge the saved card.')
      else setToast('Could not charge the saved card for this invoice.')
      setTimeout(() => setToast(null), 6000)
    } catch {
      setToast('Could not reach the server. Please try again.'); setTimeout(() => setToast(null), 5000)
    } finally { setChargingId(null) }
  }

  useEffect(() => { fetchInvoices() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Live: when the Stripe webhook flips an invoice to paid (or status changes in
  // another tab) the list updates instantly — the ?paid=1 delay below is a backup.
  useRealtimeRefresh('invoices', uid ? `user_id=eq.${uid}` : null, fetchInvoices)

  // Payments availability + return-from-Stripe handling. ?paid=1 means the
  // customer just completed checkout; the webhook marks the invoice paid a beat
  // later, so we refetch after a short delay.
  useEffect(() => {
    fetch('/api/payments/status').then(r => r.json()).then(d => setPaymentsEnabled(!!d.enabled)).catch(() => {})
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('paid') === '1') {
      setToast('Payment received — updating the invoice…')
      window.history.replaceState({}, '', '/dashboard/invoices')
      setTimeout(() => fetchInvoices(), 1500)
      setTimeout(() => setToast(null), 6000)
    }
  }, [])

  // Create a hosted Stripe payment link for this invoice — open it (take a card
  // now) and copy it (text it to the customer).
  async function payNow(inv: Invoice) {
    setPayingId(inv.id)
    try {
      const res = await fetch('/api/payments/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: inv.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.url) { setToast(d.error || 'Could not start payment.'); setTimeout(() => setToast(null), 5000); return }
      try { await navigator.clipboard.writeText(d.url) } catch { /* clipboard optional */ }
      window.open(d.url, '_blank')
      setToast('Payment link opened & copied — take a card or send the link.')
      setTimeout(() => setToast(null), 6000)
    } catch {
      setToast('Could not reach the server. Please try again.'); setTimeout(() => setToast(null), 5000)
    } finally { setPayingId(null) }
  }

  async function openInvoicePdf(inv: Invoice) {
    setOpeningId(inv.id)
    try {
      const { renderInvoiceBlob } = await import('@/components/quotes/InvoicePDF')
      const blob = await renderInvoiceBlob(inv, settings)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${inv.invoice_number}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch {
      notify.error('Could not generate the invoice PDF. Please try again.')
    } finally {
      setOpeningId(null)
    }
  }

  async function cycleStatus(inv: Invoice) {
    const idx = STATUS_CYCLE.indexOf(inv.status)
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: next } : i))
    const { error } = await supabase.from('invoices').update({ status: next }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); notify.error('Could not update status: ' + error.message) }
  }

  // One tap straight to paid — the most common action on billing day shouldn't
  // require cycling through "sent".
  async function markPaid(inv: Invoice, method?: 'etransfer' | 'cash' | 'cheque') {
    const pm = method ?? inv.payment_method ?? null
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: 'paid' as InvoiceStatus, payment_method: pm } : i))
    const { error } = await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), payment_method: pm }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); notify.error('Could not update status: ' + error.message) }
  }

  // ── Undo (same pattern as the Schedule page) ──
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => Promise<void> } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function offerUndo(label: string, run: () => Promise<void>) {
    setUndoAction({ label, run })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndoAction(null), 8000)
  }
  async function runUndo() {
    const a = undoAction
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoAction(null)
    if (a) { await a.run(); await fetchInvoices() }
  }

  // Insertable row (strips the joined customers object) so Undo can restore the
  // invoice with the SAME id — every relationship (job, quote, customer,
  // property) reconnects exactly as it was. The job itself is never touched.
  function invoiceInsertRow(i: Invoice) {
    return {
      id: i.id, user_id: i.user_id, quote_id: i.quote_id, customer_id: i.customer_id,
      property_id: i.property_id, job_id: i.job_id, invoice_number: i.invoice_number,
      customer_name: i.customer_name, address: i.address, service_type: i.service_type,
      amount: i.amount, status: i.status, issued_date: i.issued_date, due_date: i.due_date,
      notes: i.notes, line_items: i.line_items,
      // Carry the paid state so restoring a Paid invoice keeps its date + method (else a
      // manually-paid invoice loses its only payment record).
      paid_at: i.paid_at, payment_method: i.payment_method,
    }
  }

  // Delete any invoice — confirm first, with a stronger warning for Paid
  // (it's part of your collected-revenue history). Undo restores it fully.
  async function deleteInvoice(inv: Invoice) {
    const msg = inv.status === 'paid'
      ? `${inv.invoice_number} is PAID (${formatCurrency(Number(inv.amount))}) — deleting it removes collected revenue from your records. Delete anyway?`
      : `Delete ${inv.invoice_number} (${formatCurrency(Number(inv.amount))})?`
    if (!confirm(msg)) return
    setDeletingId(inv.id)
    const row = invoiceInsertRow(inv)
    const { error } = await supabase.from('invoices').delete().eq('id', inv.id)
    if (error) notify.error('Could not delete: ' + error.message)
    else {
      setInvoices(prev => prev.filter(i => i.id !== inv.id))
      offerUndo(`Deleted ${inv.invoice_number}`, async () => { await supabase.from('invoices').insert(row) })
    }
    setDeletingId(null)
  }

  // Memoized: these 5 passes over the (unbounded, billing-day-heavy) invoice list ran on
  // every render — including each mark-paid/status tap and realtime tick.
  const { drafts, draftsTotal, outstanding, paidTotal } = useMemo(() => {
    const dr = invoices.filter(i => i.status === 'draft')
    return {
      drafts: dr,
      draftsTotal: dr.reduce((sum, i) => sum + Number(i.amount || 0), 0),
      outstanding: invoices.filter(i => i.status === 'unpaid' || i.status === 'sent').reduce((sum, i) => sum + Number(i.amount || 0), 0),
      paidTotal: invoices.filter(i => i.status === 'paid').reduce((sum, i) => sum + Number(i.amount || 0), 0),
    }
  }, [invoices])
  const visible = useMemo(() => filter ? invoices.filter(i => i.status === filter) : invoices, [invoices, filter])

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Invoices"
        description={`${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
      />

      {toast && (
        <div className="text-sm text-ink bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5">{toast}</div>
      )}

      {loadError && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
          {loadError} <button onClick={() => { setLoading(true); fetchInvoices() }} className="underline font-medium ml-1">Retry</button>
        </div>
      )}

      {/* Undo toast — restore the last deleted invoice */}
      {undoAction && (
        <div className="flex items-center justify-between gap-3 text-sm bg-ink text-bg border border-border-strong rounded-xl px-4 py-2.5 shadow-lg">
          <span className="font-medium">{undoAction.label}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={runUndo} className="font-bold underline">Undo</button>
            <button onClick={() => setUndoAction(null)} className="opacity-60 hover:opacity-100">✕</button>
          </div>
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {/* Drafts are the auto-invoiced recurring pipeline — they were invisible
              (Outstanding only counts unpaid/sent) and silently went unsent. */}
          <button onClick={() => setFilter(filter === 'draft' ? '' : 'draft')} className="text-left">
            <Card className={cn(filter === 'draft' && 'border-accent/50')}>
              <CardBody>
                <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Drafts to review</p>
                <p className={cn('text-2xl font-bold', drafts.length ? 'text-sky-400' : 'text-ink-faint')}>{drafts.length ? formatCurrency(draftsTotal) : '—'}</p>
                {drafts.length > 0 && <p className="text-[11px] text-ink-faint mt-0.5">{drafts.length} draft{drafts.length !== 1 ? 's' : ''} — tap to review</p>}
              </CardBody>
            </Card>
          </button>
          <Card>
            <CardBody>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Outstanding</p>
              <p className="text-2xl font-bold text-amber-400">{formatCurrency(outstanding)}</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Paid</p>
              <p className="text-2xl font-bold text-accent">{formatCurrency(paidTotal)}</p>
            </CardBody>
          </Card>
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)}
              className={cn('px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors',
                filter === f.value ? 'bg-accent text-black border-accent' : 'bg-surface border-border-strong text-ink-muted hover:text-ink')}>
              {f.label}{f.value === 'draft' && drafts.length > 0 ? ` (${drafts.length})` : ''}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <SkeletonRows count={6} />
      ) : loadError ? null : invoices.length === 0 ? (
        <div className="text-center py-16 text-sm text-ink-muted">
          No invoices yet. Completing a recurring visit drafts one automatically — or open an accepted quote and click <span className="font-medium text-ink">Convert to Invoice</span>.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-sm text-ink-muted">No {filter} invoices.</div>
      ) : (
        <div className="space-y-3">
          {visible.map(inv => (
            <Card key={inv.id}>
              <CardBody>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <FileText className="w-4 h-4 text-accent" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{inv.invoice_number}</p>
                        <span className="text-xs text-ink-faint">{formatDate(inv.issued_date || inv.created_at)}</span>
                      </div>
                      <p className="text-xs text-ink-muted flex items-center gap-1 mt-0.5">
                        <User className="w-3 h-3" /> {inv.customer_name}
                      </p>
                      {inv.line_items && inv.line_items.length > 1 ? (
                        // Transparent breakdown — base service + add-ons + travel.
                        <div className="mt-1 space-y-0.5">
                          {inv.line_items.map((li, i) => (
                            <p key={i} className="text-xs flex items-center justify-between gap-3 max-w-[280px]">
                              <span className="text-ink-faint truncate">{li.description}</span>
                              <span className="text-ink-muted font-medium shrink-0">{formatCurrency(Number(li.amount))}</span>
                            </p>
                          ))}
                        </div>
                      ) : (
                        inv.service_type && <p className="text-xs text-ink-faint mt-0.5 truncate">{inv.service_type}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap sm:gap-3 sm:shrink-0 sm:justify-end">
                    <div className="text-right">
                      <span className="text-lg font-bold text-ink">{formatCurrency(invoiceTotals(inv.amount, settings).total)}</span>
                      {settings && Number(settings.gst_percent) > 0 && (
                        <p className="text-[10px] text-ink-faint">incl. {formatCurrency(invoiceTotals(inv.amount, settings).gstAmount)} GST</p>
                      )}
                      {(() => {
                        const n = (inv.line_items || []).filter(li => li.kind === 'addon').length
                        return n > 0 ? <p className="text-[10px] font-semibold text-accent">+{n} service{n !== 1 ? 's' : ''}</p> : null
                      })()}
                    </div>
                    <Button onClick={() => openInvoicePdf(inv)} variant="secondary" size="sm" loading={openingId === inv.id}>
                      <FileDown className="w-3.5 h-3.5" /> PDF
                    </Button>
                    <button
                      onClick={() => cycleStatus(inv)}
                      title="Click to change status"
                      className={`text-[10px] px-2.5 py-1 rounded-full border uppercase tracking-wide font-semibold flex items-center gap-1 transition-opacity hover:opacity-80 ${INVOICE_STATUS_COLORS[inv.status]}`}
                    >
                      {inv.status === 'paid' && <Check className="w-3 h-3" />}
                      {INVOICE_STATUS_LABELS[inv.status]}
                    </button>
                    {/* AutoPay held this invoice for review (amount differs from usual). */}
                    {inv.status === 'draft' && (inv.notes || '').includes('AutoPay held') && (
                      <span title={inv.notes || undefined} className="text-[10px] px-2 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Review
                      </span>
                    )}
                    {paymentsEnabled && (inv.status === 'unpaid' || inv.status === 'sent') && (
                      <Button onClick={() => payNow(inv)} size="sm" loading={payingId === inv.id} title="Create a Stripe payment link">
                        <CreditCard className="w-3.5 h-3.5" /> Pay
                      </Button>
                    )}
                    {/* Charge the saved card directly — recurring invoices, customer with a card on file. */}
                    {paymentsEnabled && inv.customer_id && cardCustomers.has(inv.customer_id) && inv.job_id && inv.status !== 'paid' && (
                      <Button onClick={() => chargeSavedCard(inv)} size="sm" variant="secondary" loading={chargingId === inv.id} title="Charge the customer's saved card on file">
                        <Zap className="w-3.5 h-3.5" /> Charge card
                      </Button>
                    )}
                    {(inv.status === 'draft' || inv.status === 'unpaid' || inv.status === 'sent') && (
                      <select
                        defaultValue=""
                        onChange={e => { const m = e.target.value as 'etransfer' | 'cash' | 'cheque' | ''; if (m) markPaid(inv, m) }}
                        title="Mark paid by method"
                        className="text-xs rounded-lg border border-border-strong bg-surface text-ink-muted px-2 py-1.5 outline-none focus:border-accent"
                      >
                        <option value="">Mark paid…</option>
                        <option value="etransfer">E-transfer</option>
                        <option value="cash">Cash</option>
                        <option value="cheque">Cheque</option>
                      </select>
                    )}
                    {inv.status === 'paid' && inv.payment_method && (
                      <span className="text-[10px] text-ink-faint capitalize">{inv.payment_method === 'etransfer' ? 'E-transfer' : inv.payment_method}</span>
                    )}
                    <Button onClick={() => deleteInvoice(inv)} variant="ghost" size="sm" loading={deletingId === inv.id}
                      className="hover:text-red-400" title="Delete invoice">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {inv.customer_id && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <SendComms customerId={inv.customer_id} template="invoice" vars={{ amount: formatCurrency(Number(inv.amount)) }} label="Send invoice" />
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && <PaymentHistory />}
    </div>
  )
}