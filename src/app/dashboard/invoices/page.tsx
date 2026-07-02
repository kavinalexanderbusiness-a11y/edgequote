'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Invoice, InvoiceStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings } from '@/types'
import { InvoicePaymentControls } from '@/components/payments/InvoicePaymentControls'
import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { PaymentHistory } from '@/components/payments/PaymentHistory'
import { invoiceTotals, applyDiscount, type DiscountType } from '@/lib/invoiceTotals'
import { toast as notify } from '@/lib/toast'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { FileText, User, Check, FileDown, Trash2, CreditCard, Zap, AlertTriangle, Pencil, Percent, DollarSign, X, MessageSquare } from 'lucide-react'

const FILTERS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'sent', label: 'Sent' },
  { value: 'partial', label: 'Partial' },
  { value: 'paid', label: 'Paid' },
]

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function InvoicesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | InvoiceStatus>('')
  // The ONE shared Send Message dialog, opened for a specific invoice's customer.
  const [msgInvoice, setMsgInvoice] = useState<Invoice | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [chargingId, setChargingId] = useState<string | null>(null)
  const [cardCustomers, setCardCustomers] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)   // invoice whose inline draft editor is open
  const [creditByCustomer, setCreditByCustomer] = useState<Record<string, number>>({})   // available credit per customer

  async function fetchInvoices() {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [iRes, sRes, pmRes, crRes] = await Promise.all([
        supabase
          .from('invoices')
          .select('*, customers(id, name, email, phone)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        // Which customers have a saved card → enables the "Charge saved card" action.
        supabase.from('payment_methods').select('customer_id').eq('user_id', user.id),
        // Customer credit ledger (kind='credit') → available credit per customer.
        supabase.from('payments').select('customer_id, amount').eq('user_id', user.id).eq('kind', 'credit'),
      ])
      // A failed fetch must NOT render as "No invoices yet" on billing day.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error.message); return }
      setLoadError(null)
      setInvoices((iRes.data as Invoice[]) || [])
      setSettings(sRes.data as BusinessSettings | null)
      setCardCustomers(new Set(((pmRes.data as { customer_id: string }[] | null) || []).map(r => r.customer_id)))
      const credit: Record<string, number> = {}
      for (const r of (crRes.data as { customer_id: string | null; amount: number }[] | null) || []) {
        if (r.customer_id) credit[r.customer_id] = Math.round(((credit[r.customer_id] || 0) + Number(r.amount || 0)) * 100) / 100
      }
      setCreditByCustomer(credit)
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

  // Status pill toggles ONLY the lifecycle states (unpaid ↔ sent). paid / partial /
  // overpaid are derived from the payment ledger by the DB trigger — never set here.
  async function cycleStatus(inv: Invoice) {
    if (inv.status !== 'unpaid' && inv.status !== 'sent') return
    const next: InvoiceStatus = inv.status === 'unpaid' ? 'sent' : 'unpaid'
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: next } : i))
    const { error } = await supabase.from('invoices').update({ status: next }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); notify.error('Could not update status: ' + error.message) }
  }

  // Sending an invoice IS issuing it — advance draft/unpaid → sent automatically so
  // the owner never has to tap the status pill afterwards (one intent, one action).
  // Never downgrades an already-sent/partly-paid/paid invoice.
  async function markSent(inv: Invoice) {
    if (inv.status !== 'draft' && inv.status !== 'unpaid') return
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: 'sent' as InvoiceStatus } : i))
    const { error } = await supabase.from('invoices').update({ status: 'sent' }).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status } : i)); notify.error('Could not mark sent: ' + error.message) }
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
    }
  }

  // Delete any invoice — act now, offer Undo (restores it fully, reconnecting its job/
  // quote/customer/payment links) instead of a blocking confirm. Paid invoices flag the
  // collected-revenue impact in the Undo toast.
  async function deleteInvoice(inv: Invoice) {
    setDeletingId(inv.id)
    const row = invoiceInsertRow(inv)
    const { error } = await supabase.from('invoices').delete().eq('id', inv.id)
    if (error) notify.error('Could not delete: ' + error.message)
    else {
      setInvoices(prev => prev.filter(i => i.id !== inv.id))
      const label = inv.status === 'paid' ? `Deleted PAID ${inv.invoice_number} (${formatCurrency(Number(inv.amount))})` : `Deleted ${inv.invoice_number}`
      offerUndo(label, async () => { await supabase.from('invoices').insert(row) })
    }
    setDeletingId(null)
  }

  const drafts = invoices.filter(i => i.status === 'draft')
  const draftsTotal = drafts.reduce((sum, i) => sum + Number(i.amount || 0), 0)
  // Outstanding = the unpaid BALANCE across issued invoices (partial payments count);
  // Collected = total actually received (amount_paid), so both reflect the ledger.
  const outstanding = invoices
    .filter(i => i.status !== 'draft')
    .reduce((sum, i) => sum + Math.max(0, invoiceBalance(i, settings).balance), 0)
  const paidTotal = invoices.reduce((sum, i) => sum + (Number(i.amount_paid) || 0), 0)
  const visible = filter ? invoices.filter(i => i.status === filter) : invoices
  const today = todayISO()

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
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Collected</p>
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
                    {(() => {
                      const t = invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value })
                      const addonN = (inv.line_items || []).filter(li => li.kind === 'addon').length
                      return (
                        <div className="text-right">
                          <span className="text-lg font-bold text-ink">{formatCurrency(t.total)}</span>
                          {t.hasDiscount && (
                            <p className="text-[10px] font-semibold text-emerald-400">{t.discountLabel ? `${t.discountLabel} off` : 'Discount'} −{formatCurrency(t.discountAmount)}</p>
                          )}
                          {t.hasGst && (
                            <p className="text-[10px] text-ink-faint">incl. {formatCurrency(t.gstAmount)} GST</p>
                          )}
                          {addonN > 0 && <p className="text-[10px] font-semibold text-accent">+{addonN} service{addonN !== 1 ? 's' : ''}</p>}
                        </div>
                      )
                    })()}
                    <Button onClick={() => openInvoicePdf(inv)} variant="secondary" size="sm" loading={openingId === inv.id}>
                      <FileDown className="w-3.5 h-3.5" /> PDF
                    </Button>
                    {/* Draft invoices are still mutable history-wise — edit details + discount inline. */}
                    {inv.status === 'draft' && (
                      <Button onClick={() => setEditId(editId === inv.id ? null : inv.id)} variant="ghost" size="sm" title="Edit this draft">
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </Button>
                    )}
                    {(() => {
                      const ds = displayInvoiceStatus(inv, settings, today)
                      const clickable = inv.status === 'unpaid' || inv.status === 'sent'
                      return (
                        <button
                          onClick={() => cycleStatus(inv)}
                          disabled={!clickable}
                          title={clickable ? 'Toggle sent / unpaid' : undefined}
                          className={`text-[10px] px-2.5 py-1 rounded-full border uppercase tracking-wide font-semibold flex items-center gap-1 ${clickable ? 'transition-opacity hover:opacity-80' : 'cursor-default'} ${INVOICE_STATUS_COLORS[ds]}`}
                        >
                          {ds === 'paid' && <Check className="w-3 h-3" />}
                          {INVOICE_STATUS_LABELS[ds]}
                        </button>
                      )
                    })()}
                    {/* AutoPay held this invoice for review (amount differs from usual). */}
                    {inv.status === 'draft' && (inv.notes || '').includes('AutoPay held') && (
                      <span title={inv.notes || undefined} className="text-[10px] px-2 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Review
                      </span>
                    )}
                    {paymentsEnabled && inv.status !== 'draft' && invoiceBalance(inv, settings).balance > 0 && (
                      <Button onClick={() => payNow(inv)} size="sm" loading={payingId === inv.id} title="Create a Stripe payment link for the balance">
                        <CreditCard className="w-3.5 h-3.5" /> Pay
                      </Button>
                    )}
                    {/* Charge the saved card directly — recurring invoices, customer with a card on file. */}
                    {paymentsEnabled && inv.customer_id && cardCustomers.has(inv.customer_id) && inv.job_id && invoiceBalance(inv, settings).balance > 0 && (
                      <Button onClick={() => chargeSavedCard(inv)} size="sm" variant="secondary" loading={chargingId === inv.id} title="Charge the customer's saved card on file">
                        <Zap className="w-3.5 h-3.5" /> Charge card
                      </Button>
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
                {editId === inv.id && (
                  <DraftInvoiceEditor
                    inv={inv}
                    settings={settings}
                    onCancel={() => setEditId(null)}
                    onSaved={patch => { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, ...patch } as Invoice : i)); setEditId(null) }}
                  />
                )}
                {/* Record payments, resolve overpayments, apply credit — issued invoices only */}
                {inv.status !== 'draft' && uid && (
                  <InvoicePaymentControls
                    invoice={inv}
                    settings={settings}
                    uid={uid}
                    credit={inv.customer_id ? (creditByCustomer[inv.customer_id] || 0) : 0}
                    onChanged={fetchInvoices}
                  />
                )}
                {inv.customer_id && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <Button variant="secondary" size="sm" onClick={() => setMsgInvoice(inv)}>
                      <MessageSquare className="w-3.5 h-3.5" /> Send invoice
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && <PaymentHistory />}

      {/* ONE shared Send Message dialog — sending marks the invoice sent. */}
      {msgInvoice?.customer_id && (
        <SendMessageDialog open onClose={() => setMsgInvoice(null)}
          customerId={msgInvoice.customer_id} customerName={msgInvoice.customer_name}
          defaultTemplate="invoice" vars={{ amount: formatCurrency(Number(msgInvoice.amount)) }}
          onSent={() => markSent(msgInvoice)} />
      )}
    </div>
  )
}

// ── Inline draft-invoice editor ──────────────────────────────────────────────
// Edits a DRAFT invoice in place (no navigation): customer, service, due date,
// notes, and a discount (fixed $ or %). The discount reuses applyDiscount/
// invoiceTotals — the SAME engine the list, portal, PDF and Stripe charge use — so
// `amount` stays the net subtotal and every total stays consistent. The base amount
// is editable only for simple (≤1 line) invoices; itemized job invoices keep their
// engine-priced breakdown and are adjusted on the schedule, but can still be discounted.
function DraftInvoiceEditor({ inv, settings, onSaved, onCancel }: {
  inv: Invoice
  settings: BusinessSettings | null
  onSaved: (patch: Partial<Invoice>) => void
  onCancel: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const liSum = (inv.line_items || []).reduce((s, li) => s + Number(li.amount || 0), 0)
  const itemized = (inv.line_items?.length ?? 0) > 1
  const initial = invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value })

  const [name, setName] = useState(inv.customer_name || '')
  const [service, setService] = useState(inv.service_type || '')
  const [due, setDue] = useState(inv.due_date || '')
  const [notes, setNotes] = useState(inv.notes || '')
  const [base, setBase] = useState(String(Math.round(itemized ? liSum : initial.subtotal)))
  const [dType, setDType] = useState<'' | DiscountType>(inv.discount_type ?? '')
  const [dValue, setDValue] = useState(inv.discount_value != null ? String(inv.discount_value) : '')
  const [saving, setSaving] = useState(false)

  const grossNum = Math.round(itemized ? liSum : (Number(base) || 0))
  const discount = dType && Number(dValue) > 0 ? { type: dType, value: Number(dValue) } : null
  const { net } = applyDiscount(grossNum, discount)
  const t = invoiceTotals(net, settings, discount)

  async function save() {
    setSaving(true)
    const hasD = !!dType && Number(dValue) > 0
    const patch: Record<string, unknown> = {
      customer_name: name.trim() || inv.customer_name,
      service_type: service.trim() || null,
      due_date: due || null,
      notes: notes.trim() || null,
      amount: Math.round(net),
      discount_type: hasD ? dType : null,
      discount_value: hasD ? Number(dValue) : null,
    }
    // Keep a single (non-itemized) line item in step with an edited base so the PDF
    // total never diverges; itemized invoices keep their breakdown untouched.
    if (!itemized && (inv.line_items?.length ?? 0) === 1) {
      patch.line_items = [{ ...inv.line_items![0], amount: grossNum }]
    }
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    setSaving(false)
    if (error) { notify.error('Could not save the invoice: ' + error.message); return }
    onSaved(patch as Partial<Invoice>)
  }

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5 text-accent" /> Edit draft</p>
        <button onClick={onCancel} className="text-ink-faint hover:text-ink" aria-label="Close editor"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Customer name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Service" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Weekly mowing" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Due date" type="date" value={due} onChange={e => setDue(e.target.value)} />
        {itemized ? (
          <div>
            <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Subtotal (from services)</label>
            <div className="mt-1.5 px-3.5 py-3 rounded-xl bg-bg-tertiary border border-border text-sm text-ink-muted">{formatCurrency(liSum)} · edit services on the schedule</div>
          </div>
        ) : (
          <Input label="Amount (before discount)" type="number" min="0" step="1" value={base} onChange={e => setBase(e.target.value)} />
        )}
      </div>

      {/* Discount — none / fixed $ / percentage */}
      <div>
        <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Discount</label>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <div className="flex rounded-lg border border-border-strong overflow-hidden">
            <DiscBtn active={dType === ''} onClick={() => setDType('')}>None</DiscBtn>
            <DiscBtn active={dType === 'amount'} onClick={() => setDType('amount')}><DollarSign className="w-3.5 h-3.5" /></DiscBtn>
            <DiscBtn active={dType === 'percent'} onClick={() => setDType('percent')}><Percent className="w-3.5 h-3.5" /></DiscBtn>
          </div>
          {dType && (
            <div className="relative w-36">
              <input
                type="number" min="0" step={dType === 'percent' ? '1' : '5'} max={dType === 'percent' ? '100' : undefined}
                autoFocus value={dValue} onChange={e => setDValue(e.target.value)}
                placeholder={dType === 'percent' ? '10' : '25'}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl pl-3 pr-8 py-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint text-sm">{dType === 'percent' ? '%' : '$'}</span>
            </div>
          )}
        </div>
      </div>

      <Textarea label="Notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional note shown on the invoice" />

      {/* Live breakdown — exactly what the customer, PDF and Stripe charge will show */}
      <div className="rounded-xl border border-border bg-bg-tertiary px-3.5 py-2.5 space-y-1 text-sm">
        <Row label="Subtotal" value={formatCurrency(t.subtotal)} />
        {t.hasDiscount && <Row label={`Discount${t.discountLabel ? ` (${t.discountLabel})` : ''}`} value={`−${formatCurrency(t.discountAmount)}`} tone="text-emerald-400" />}
        {t.hasDiscount && <Row label="After discount" value={formatCurrency(t.discountedSubtotal)} muted />}
        {t.hasGst && <Row label={`GST (${t.gstPercent}%)`} value={formatCurrency(t.gstAmount)} muted />}
        <div className="flex justify-between pt-1.5 border-t border-border"><span className="font-semibold text-ink">Total</span><span className="font-bold text-accent">{formatCurrency(t.total)}</span></div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} loading={saving}><Check className="w-3.5 h-3.5" /> Save draft</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function DiscBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('px-3 py-2 text-xs font-medium flex items-center gap-1 border-r border-border-strong last:border-r-0 transition-colors',
        active ? 'bg-accent text-black' : 'bg-surface text-ink-muted hover:text-ink')}>
      {children}
    </button>
  )
}

function Row({ label, value, tone, muted }: { label: string; value: string; tone?: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-ink-faint' : 'text-ink-muted'}>{label}</span>
      <span className={cn('font-medium', tone || (muted ? 'text-ink-muted' : 'text-ink'))}>{value}</span>
    </div>
  )
}