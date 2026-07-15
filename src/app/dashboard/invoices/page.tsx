'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { usePaymentsStatus } from '@/hooks/usePaymentsStatus'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { Invoice, InvoiceStatus, InvoiceDisplayStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings, Payment, paymentMethodLabel } from '@/types'
import { InvoicePaymentControls } from '@/components/payments/InvoicePaymentControls'
import { invoiceBalance, displayInvoiceStatus, cancelInvoice, reactivateInvoice } from '@/lib/payments/ledger'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { Menu } from '@/components/ui/Menu'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { PaymentHistory } from '@/components/payments/PaymentHistory'
import { invoiceTotals, applyDiscount, type DiscountType } from '@/lib/invoiceTotals'
import { toast as notify } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { FileText, User, Check, FileDown, Trash2, CreditCard, Zap, AlertTriangle, Pencil, Percent, DollarSign, X, MessageSquare, MoreHorizontal, ChevronDown, Plus } from 'lucide-react'
import { NewInvoiceDialog } from '@/components/payments/NewInvoiceDialog'

const FILTERS: { value: '' | InvoiceDisplayStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'sent', label: 'Sent' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'partial', label: 'Partial' },
  { value: 'paid', label: 'Paid' },
  { value: 'overpaid', label: 'Overpaid' },
  { value: 'cancelled', label: 'Cancelled' },
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
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | InvoiceDisplayStatus>('')
  // Deep-link focus: /dashboard/invoices?invoice=INV-0042 or ?job=<job id> shows
  // exactly that invoice (from a Convert toast or a completed job's Invoice link).
  const [focus, setFocus] = useState<{ invoice?: string; job?: string } | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search)
    const invoice = p.get('invoice') || undefined
    const job = p.get('job') || undefined
    return invoice || job ? { invoice, job } : null
  })
  // `?pay=1` — the field "Get paid" tap on a completed job card. Lands on that one
  // invoice with the record-payment form already open, so collecting in the driveway
  // is one tap from the schedule instead of a hunt through the invoice list.
  const [payIntent] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('pay') === '1'
  })
  // The ONE shared Send Message dialog, opened for a specific invoice's customer.
  const [msgInvoice, setMsgInvoice] = useState<Invoice | null>(null)
  const { enabled: paymentsEnabled, webhook: webhookReady } = usePaymentsStatus()
  const [payingId, setPayingId] = useState<string | null>(null)
  const [chargingId, setChargingId] = useState<string | null>(null)
  const [cardCustomers, setCardCustomers] = useState<Set<string>>(new Set())
  const [uid, setUid] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)   // invoice whose inline draft editor is open
  // ?new=1 deep-links straight into manual creation — the command palette's
  // "New Invoice" used to just open this list and leave the owner to hunt.
  const [showNew, setShowNew] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1')
  const [creditByCustomer, setCreditByCustomer] = useState<Record<string, number>>({})   // available credit per customer
  const [paymentsByInvoice, setPaymentsByInvoice] = useState<Record<string, Payment[]>>({}) // ledger rows per invoice (receipts + revert)

  async function fetchInvoices() {
    try {
      // Local session read — no auth round-trip before the RLS-scoped fetch batch.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [iRes, sRes, pmRes, crRes, payRes] = await Promise.all([
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
        // Every invoice-linked ledger row → permanent per-invoice receipts + revert.
        supabase.from('payments').select('*').eq('user_id', user.id).eq('kind', 'payment').not('invoice_id', 'is', null).order('paid_at', { ascending: true }),
      ])
      // A failed fetch must NOT render as "No invoices yet" on billing day.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error.message); return }
      setLoadError(null)
      setInvoices((iRes.data as Invoice[]) || [])
      // Cache only the first screenful — invoices carry a line_items jsonb + a customer
      // join, so serializing all 15k on every fetch (incl. each realtime tick) would blow
      // the sessionStorage quota and block the main thread. First screen paints instantly;
      // the full list follows from the query above.
      writeCache('invoices-list', ((iRes.data as Invoice[]) || []).slice(0, 60))
      setSettings(sRes.data as BusinessSettings | null)
      setCardCustomers(new Set(((pmRes.data as { customer_id: string }[] | null) || []).map(r => r.customer_id)))
      const credit: Record<string, number> = {}
      for (const r of (crRes.data as { customer_id: string | null; amount: number }[] | null) || []) {
        if (r.customer_id) credit[r.customer_id] = Math.round(((credit[r.customer_id] || 0) + Number(r.amount || 0)) * 100) / 100
      }
      setCreditByCustomer(credit)
      const byInv: Record<string, Payment[]> = {}
      for (const p of (payRes.data as Payment[] | null) || []) { if (p.invoice_id) (byInv[p.invoice_id] ||= []).push(p) }
      setPaymentsByInvoice(byInv)
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
      if (d.result === 'charged') notify(`Charging the saved card for ${inv.invoice_number} — the invoice will update shortly.`)
      else if (d.result === 'declined') notify(`The card was declined for ${inv.invoice_number}. Try a payment link or ask the customer to update their card.`)
      else if (d.result === 'skipped' && d.reason === 'no-card') notify('That customer has no saved card on file.')
      else if (d.result === 'skipped' && d.reason === 'already-charged') notify('This invoice has already been charged.')
      else if (d.result === 'skipped' && d.reason === 'webhook-unconfigured') notify('Configure the Stripe webhook before charging saved cards.')
      else if (!res.ok) notify(d.error || 'Could not charge the saved card.')
      else notify('Could not charge the saved card for this invoice.')
          } catch {
      notify('Could not reach the server. Please try again.')
    } finally { setChargingId(null) }
  }

  // Instant revisit: paint the cached list immediately (no skeleton), then revalidate in
  // the background — realtime keeps it live. Reuses the shared clientCache SWR module.
  useEffect(() => {
    const cached = readCache<Invoice[]>('invoices-list', CACHE_TTL.short)
    if (cached) { setInvoices(cached); setLoading(false) }
    fetchInvoices()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Live: when the Stripe webhook flips an invoice to paid (or status changes in
  // another tab) the list updates instantly — the ?paid=1 delay below is a backup.
  useRealtimeRefresh('invoices', uid ? `user_id=eq.${uid}` : null, fetchInvoices)

  // Payments availability + return-from-Stripe handling. ?paid=1 means the
  // customer just completed checkout; the webhook marks the invoice paid a beat
  // later, so we refetch after a short delay.
  useEffect(() => {
    // ?paid=1 only means the customer reached Stripe's return URL — the WEBHOOK is
    // what records the money. Claiming "Payment received" here would be a guess, and
    // if the webhook isn't configured it would be a lie the invoice never corrects.
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('paid') === '1') {
      notify('Checkout completed — confirming the payment…')
      window.history.replaceState({}, '', '/dashboard/invoices')
      setTimeout(() => fetchInvoices(), 1500)
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
      if (!res.ok || !d.url) { notify(d.error || 'Could not start payment.'); return }
      try { await navigator.clipboard.writeText(d.url) } catch { /* clipboard optional */ }
      window.open(d.url, '_blank')
      notify('Payment link opened & copied — take a card or send the link.')
          } catch {
      notify('Could not reach the server. Please try again.')
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

  // ── Undo — the ONE shared toast system (lib/toast), same as the rest of the app ──
  function offerUndo(label: string, run: () => Promise<void>) {
    notify.undo(label, async () => { await run(); await fetchInvoices() })
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
      // Restoring a PAID invoice puts collected revenue back on the books. Unchecked, a
      // failed insert (invoice_number conflict, RLS, expired session) dismissed the toast,
      // fetchInvoices() re-rendered without the row, and the money left the books with no
      // signal at all. InvoicePaymentControls already surfaces exactly this failure.
      offerUndo(label, async () => {
        const { error: rErr } = await supabase.from('invoices').insert(row)
        if (rErr) notify.error('Could not restore the invoice: ' + rErr.message)
      })
    }
    setDeletingId(null)
  }

  const drafts = invoices.filter(i => i.status === 'draft')
  const draftsTotal = drafts.reduce((sum, i) => sum + Number(i.amount || 0), 0)
  // Outstanding = the unpaid BALANCE across issued invoices (partial payments count);
  // Collected = total actually received (amount_paid), so both reflect the ledger.
  // Cancelled invoices are dead paper — excluded from money totals.
  const outstanding = invoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((sum, i) => sum + Math.max(0, invoiceBalance(i, settings).balance), 0)
  const paidTotal = invoices.reduce((sum, i) => sum + (Number(i.amount_paid) || 0), 0)
  const today = todayISO()
  // Filter on the DISPLAY status so the lifecycle states (Overdue, Viewed) are
  // filterable even though they're derived, not stored. Cancelled hides from All.
  const focused = focus
    ? invoices.filter(i => (focus.invoice && i.invoice_number === focus.invoice) || (focus.job && i.job_id === focus.job))
    : null
  const visible = focused && focused.length > 0 ? focused : filter
    ? invoices.filter(i => displayInvoiceStatus(i, settings, today) === filter || (filter !== 'cancelled' && i.status === filter))
    : invoices.filter(i => i.status !== 'cancelled')

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Invoices"
        description={`${invoices.length} invoice${invoices.length !== 1 ? 's' : ''}`}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="w-4 h-4" /> New invoice
          </Button>
        }
      />

      {/* Manual creation → mints an empty draft, then hands off to the SAME inline
          draft editor a job-generated invoice uses. */}
      <NewInvoiceDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={async id => { setShowNew(false); await fetchInvoices(); setEditId(id) }}
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<button type="button" onClick={() => { setLoading(true); fetchInvoices() }} className="shrink-0 underline font-semibold">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {/* Stripe key set, webhook secret missing — the worst possible half-state, and
          until now a completely silent one. Checkout links keep working, so customers
          pay in full; but the webhook is the single writer of paid-state, so nothing
          ever records it and the invoice sits here as outstanding forever. The owner
          chases a customer who already paid. Warn on the page where those links get
          sent, since Stripe is env-configured and has no settings screen to warn on. */}
      {paymentsEnabled && !webhookReady && (
        <Banner tone="warn" icon={AlertTriangle}>
          Card payments will be <strong>taken but not recorded</strong> — the Stripe webhook isn&rsquo;t configured
          (STRIPE_WEBHOOK_SECRET), so paid invoices won&rsquo;t mark themselves paid and AutoPay won&rsquo;t charge.
          Add the endpoint in your Stripe dashboard, or record these payments by hand for now.
        </Banner>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {/* Drafts are the auto-invoiced recurring pipeline — they were invisible
              (Outstanding only counts unpaid/sent) and silently went unsent. */}
          <button onClick={() => setFilter(filter === 'draft' ? '' : 'draft')} aria-pressed={filter === 'draft'} className="text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Card className={cn(filter === 'draft' && 'border-accent/50')}>
              <CardBody>
                <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Drafts to review</p>
                <p className={cn('text-xl font-black tracking-tight tabular-nums', drafts.length ? 'text-sky-400' : 'text-ink-faint')}>{drafts.length ? formatCurrency(draftsTotal) : '—'}</p>
                {drafts.length > 0 && <p className="text-[11px] text-ink-faint mt-0.5">{drafts.length} draft{drafts.length !== 1 ? 's' : ''} — tap to review</p>}
              </CardBody>
            </Card>
          </button>
          <Card>
            <CardBody>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Outstanding</p>
              <p className="text-xl font-black tracking-tight tabular-nums text-amber-400">{formatCurrency(outstanding)}</p>
              <p className="text-[11px] text-ink-faint mt-0.5">Billed, unpaid</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Collected</p>
              <p className="text-xl font-black tracking-tight tabular-nums text-emerald-400">{formatCurrency(paidTotal)}</p>
              <p className="text-[11px] text-ink-faint mt-0.5">Payments received</p>
            </CardBody>
          </Card>
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        // One scrollable row on phones (the quotes-list idiom) — 9 pills used to
        // wrap into a 2-3 row wall between the KPIs and the first invoice.
        <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
          {FILTERS.map(f => (
            <FilterPill key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}{f.value === 'draft' && drafts.length > 0 ? ` (${drafts.length})` : ''}
            </FilterPill>
          ))}
        </div>
      )}
      {/* Deep-link focus (from a Convert toast / completed-job Invoice link) —
          always show the way back to the full list. */}
      {focus && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span>Showing {focus.invoice ? `invoice ${focus.invoice}` : 'the invoice for that job'}</span>
          <button onClick={() => { setFocus(null); if (typeof window !== 'undefined') window.history.replaceState({}, '', '/dashboard/invoices') }}
            className="font-semibold text-accent-text hover:underline">Show all</button>
        </div>
      )}

      {/* One-line status legend — 'Unpaid' vs 'Sent' is invisible tribal knowledge
          otherwise (tap the status pill on a row to flip between them). */}
      {!loading && !loadError && (filter === 'unpaid' || filter === 'sent') && (
        <p className="text-[11px] text-ink-faint -mt-3">
          Unpaid = issued but not yet sent to the customer · Sent = delivered, awaiting payment. Tap an invoice&apos;s status pill to switch.
        </p>
      )}

      {loading ? (
        <SkeletonRows count={6} />
      ) : loadError ? null : invoices.length === 0 ? (
        <EmptyState icon={FileText} title="No invoices yet"
          description={<>Completing a recurring visit drafts one automatically — or open an accepted quote and click <span className="font-medium text-ink">Convert to Invoice</span>.</>} />
      ) : visible.length === 0 ? (
        <InlineEmpty>{filter ? `No ${filter} invoices.` : 'No invoices to show.'}</InlineEmpty>
      ) : (
        <div className="space-y-3">
          {visible.map((inv, i) => (
            <Card key={inv.id} className={`card-lift animate-rise stagger-${Math.min(i + 1, 6)}`}>
              <CardBody>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <FileText className="w-4 h-4 text-accent-text" />
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
                              <span className="text-ink-muted font-medium shrink-0 tabular-nums">{formatCurrency(Number(li.amount))}</span>
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
                          <span className="text-lg font-bold text-ink tabular-nums">{formatCurrency(t.total)}</span>
                          {t.hasDiscount && (
                            <p className="text-[10px] font-semibold text-emerald-400 tabular-nums">{t.discountLabel ? `${t.discountLabel} off` : 'Discount'} −{formatCurrency(t.discountAmount)}</p>
                          )}
                          {t.hasGst && (
                            <p className="text-[10px] text-ink-faint tabular-nums">incl. {formatCurrency(t.gstAmount)} GST</p>
                          )}
                          {addonN > 0 && <p className="text-[10px] font-semibold text-accent-text">+{addonN} service{addonN !== 1 ? 's' : ''}</p>}
                        </div>
                      )
                    })()}
                    {(() => {
                      const ds = displayInvoiceStatus(inv, settings, today)
                      // The pill is THE lifecycle control: Draft/Unpaid → Sent → back,
                      // and Cancel/Reactivate — one obvious place. Money states stay
                      // locked (partial/paid/overpaid belong to the payments ledger).
                      const clickable = inv.status === 'draft' || inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'cancelled'
                      const setStatus = async (status: InvoiceStatus, msg: string) => {
                        const { error } = await supabase.from('invoices').update({ status }).eq('id', inv.id)
                        if (error) { notify.error('Could not update the status: ' + error.message); return }
                        fetchInvoices()
                        notify.success(msg)
                      }
                      // A $0 invoice can't be paid: both charge routes reject a
                      // zero balance with "This invoice is already paid", so
                      // approving one sends the customer a document that dead-ends.
                      // The auto-draft engine already refuses to create one — the
                      // manual path is the only way to reach this state, so it's
                      // the only place that has to say no. Uses the SAME ledger
                      // total the list, PDF and charge routes read.
                      const approveDraft = async () => {
                        if (invoiceBalance(inv, settings).total <= 0) {
                          notify.error(`${inv.invoice_number} is $0 — add a line item with a price before approving it.`)
                          return
                        }
                        await setStatus('unpaid', `${inv.invoice_number} approved — ready to send.`)
                      }
                      const doCancel = async () => {
                        const res = await cancelInvoice(supabase, inv)
                        if (res.error) { notify.error(res.error); return }
                        fetchInvoices()
                        notify.undo(`${inv.invoice_number} cancelled.`, async () => { await reactivateInvoice(supabase, inv.id); fetchInvoices() })
                      }
                      // Drafts list "Approve draft" first — it's the primary next step.
                      const statusItems = [
                        ...(inv.status === 'draft' ? [
                          { key: 'approve', label: 'Approve draft', onSelect: approveDraft },
                        ] : []),
                        ...(inv.status === 'draft' || inv.status === 'unpaid' ? [
                          { key: 'mark-sent', label: 'Mark sent', onSelect: () => setStatus('sent', `${inv.invoice_number} marked sent.`) },
                        ] : []),
                        ...(inv.status === 'sent' ? [
                          { key: 'mark-not-sent', label: 'Mark not sent', onSelect: () => setStatus('unpaid', `${inv.invoice_number} back to unpaid.`) },
                        ] : []),
                        ...(inv.status !== 'cancelled' && (Number(inv.amount_paid) || 0) <= 0.01 ? [
                          { key: 'cancel', label: 'Cancel invoice', danger: true, onSelect: doCancel },
                        ] : []),
                        ...(inv.status === 'cancelled' ? [
                          { key: 'reactivate', label: 'Reactivate', onSelect: () => setStatus('unpaid', `${inv.invoice_number} reactivated.`) },
                        ] : []),
                      ]
                      return (
                        <Menu align="start" width={190} ariaLabel="Invoice status" items={statusItems}>
                          {({ toggle, triggerProps }) => (
                            <button
                              type="button"
                              onClick={() => clickable && toggle()}
                              disabled={!clickable}
                              title={clickable ? 'Change status' : 'Status is set by payments'}
                              className={`text-[10px] px-2.5 rounded-full border uppercase tracking-wide font-semibold flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${clickable ? 'py-2 min-h-[36px] transition-opacity hover:opacity-80' : 'py-1 cursor-default'} ${INVOICE_STATUS_COLORS[ds]}`}
                              {...(clickable ? triggerProps : {})}
                            >
                              {ds === 'paid' && <Check className="w-3 h-3" />}
                              {INVOICE_STATUS_LABELS[ds]}
                              {/* "Overdue" collapses "never opened, nothing paid" and "part-paid,
                                  chase the rest" into one identical red word. Show what's LEFT so
                                  the owner knows which conversation to have. */}
                              {ds === 'overdue' && (Number(inv.amount_paid) || 0) > 0.01 && (
                                <span className="normal-case font-medium opacity-90">· {formatCurrency(invoiceBalance(inv, settings).balance)} left</span>
                              )}
                              {clickable && <ChevronDown aria-hidden className="w-3 h-3 opacity-60" />}
                            </button>
                          )}
                        </Menu>
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
                        <CreditCard className="w-3.5 h-3.5" /> Take payment
                      </Button>
                    )}
                    {/* Charge the saved card directly — recurring invoices, customer with a card on file. */}
                    {paymentsEnabled && inv.customer_id && cardCustomers.has(inv.customer_id) && inv.job_id && invoiceBalance(inv, settings).balance > 0 && (
                      <Button
                        onClick={async () => {
                          // Presentation-level guard only — a real card charge deserves one
                          // deliberate confirmation before the EXACT existing handler runs.
                          if (!(await confirmDialog({
                            title: 'Charge saved card',
                            message: `Charge ${formatCurrency(invoiceBalance(inv, settings).balance)} to the saved card for ${inv.invoice_number}?`,
                            confirmLabel: 'Charge card',
                          }))) return
                          chargeSavedCard(inv)
                        }}
                        size="sm" variant="secondary" loading={chargingId === inv.id}
                        className="border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                        title="Charge the customer's saved card on file">
                        <Zap className="w-3.5 h-3.5" /> Charge card
                      </Button>
                    )}
                    {inv.status === 'paid' && inv.payment_method && (
                      <span className="text-[10px] text-ink-faint">{paymentMethodLabel(inv.payment_method)}</span>
                    )}
                    {/* Send — the primary outbound action, in the cluster (not exiled below).
                        A draft AutoPay HELD for review is an amount the system itself
                        distrusted — never let one tap put it in front of the customer
                        without naming the anomaly first. */}
                    {inv.customer_id && inv.status !== 'cancelled' && (
                      <Button variant="secondary" size="sm" title="Send this invoice to the customer"
                        onClick={async () => {
                          // Send issues the invoice, so it can reach 'sent' without
                          // ever passing Approve — the $0 guard has to live on both
                          // doors, not just the one the owner usually uses.
                          if (invoiceBalance(inv, settings).total <= 0) {
                            notify.error(`${inv.invoice_number} is $0 — add a line item with a price before sending it.`)
                            return
                          }
                          const held = inv.status === 'draft' && (inv.notes || '').includes('AutoPay held')
                          if (held) {
                            const ok = await confirmDialog({
                              title: 'Send an invoice that was held for review?',
                              message: `${inv.invoice_number} was held because the amount looks unusual for this customer${inv.notes ? ` — ${inv.notes}` : ''}. Send it as-is?`,
                              confirmLabel: 'Send it anyway',
                            })
                            if (!ok) return
                          }
                          setMsgInvoice(inv)
                        }}>
                        <MessageSquare className="w-3.5 h-3.5" /> Send
                      </Button>
                    )}
                    {/* Overflow — secondary row actions (PDF + draft edit/delete) in ONE shared menu. */}
                    <Menu align="end" width={200} ariaLabel="More actions" items={[
                      { key: 'pdf', label: 'Download PDF', icon: FileDown, onSelect: () => openInvoicePdf(inv) },
                      ...(inv.status === 'draft' ? [
                        { key: 'edit', label: 'Edit draft', icon: Pencil, onSelect: () => setEditId(editId === inv.id ? null : inv.id) },
                        { key: 'delete', label: 'Delete draft', icon: Trash2, danger: true, onSelect: () => deleteInvoice(inv) },
                      ] : []),
                    ]}>
                      {({ toggle, triggerProps }) => (
                        <Button size="sm" variant="ghost" onClick={toggle} loading={openingId === inv.id || deletingId === inv.id}
                          aria-label="More actions" title="More actions" {...triggerProps}>
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      )}
                    </Menu>
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
                {/* Record payments, resolve overpayments, apply credit. Drafts are
                    included: completing a job auto-drafts the invoice, so gating this
                    on "issued" meant a contractor holding cash in the driveway had to
                    Send the invoice to their own customer before the app would let
                    them write the payment down. Recording a payment issues it (below). */}
                {uid && (
                  <InvoicePaymentControls
                    invoice={inv}
                    settings={settings}
                    uid={uid}
                    credit={inv.customer_id ? (creditByCustomer[inv.customer_id] || 0) : 0}
                    payments={paymentsByInvoice[inv.id] || []}
                    onChanged={fetchInvoices}
                    onIssueDraft={() => markSent(inv)}
                    defaultOpen={payIntent && focused?.length === 1 && focused[0].id === inv.id}
                  />
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {!loading && !loadError && invoices.length > 0 && <PaymentHistory settings={settings} />}

      {/* ONE shared Send Message dialog — sending marks the invoice sent. The amount
          is what's actually OWED (the ledger balance), never the original total: a
          customer who has already part-paid must never be asked for the full amount. */}
      {msgInvoice?.customer_id && (
        <SendMessageDialog open onClose={() => setMsgInvoice(null)}
          customerId={msgInvoice.customer_id} customerName={msgInvoice.customer_name}
          defaultTemplate="invoice" vars={{ amount: formatCurrency(invoiceBalance(msgInvoice, settings).balance) }}
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
  // Editable line items — a draft's breakdown belongs to the owner, not just the
  // job add-on flow. Amounts are gross; the discount applies to the sum below.
  // qty x unit price IS the amount. Engine-priced lines arrive without a
  // breakdown, so they open as 1 x their amount — identical figure, now editable
  // either way. `amount` stays the derived line total every total/PDF reads.
  const [items, setItems] = useState<{ description: string; qty: string; unit: string; kind: string }[]>(
    (inv.line_items || []).map(li => ({
      description: li.description,
      qty: String(li.qty ?? 1),
      unit: String(li.unit_price ?? (Number(li.amount) || 0)),
      kind: (li as { kind?: string }).kind || 'service',
    })),
  )
  const lineAmount = (li: { qty: string; unit: string }) => Math.round((Number(li.qty) || 0) * (Number(li.unit) || 0))
  const [saving, setSaving] = useState(false)

  const editItems = items.length > 0
  const itemsSum = items.reduce((s, li) => s + lineAmount(li), 0)
  const grossNum = Math.round(editItems ? itemsSum : (Number(base) || 0))
  const discount = dType && Number(dValue) > 0 ? { type: dType, value: Number(dValue) } : null
  const { net } = applyDiscount(grossNum, discount)
  const t = invoiceTotals(net, settings, discount)

  async function save() {
    // A priced line with no description is the one case where dropping it silently
    // diverges the books: the filter below removes the LINE, but `amount` is summed
    // from every row — so the money stayed on the invoice with nothing to explain
    // it, and the PDF's breakdown no longer added up to its own total. Blank rows
    // worth $0 are still dropped silently: they contribute nothing either way, so
    // filtering them changes no number.
    if (editItems && items.some(li => lineAmount(li) !== 0 && !li.description.trim())) {
      notify.error('Every priced line needs a description — otherwise it won’t appear on the invoice.')
      return
    }
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
    // Persist the breakdown the owner sees: edited rows when itemized, or the
    // single line kept in step with the base so the PDF total never diverges.
    if (editItems) {
      patch.line_items = items
        .filter(li => li.description.trim())
        .map(li => ({
          description: li.description.trim(),
          amount: lineAmount(li),          // the figure every total + the PDF reads
          kind: li.kind,
          // Only persist the breakdown when it says something the amount doesn't.
          // At qty 1 the unit price IS the amount, so writing it would add no
          // information — and would grow Qty/Unit columns on the PDF of every
          // engine-priced invoice the owner happens to open and save.
          ...(Number(li.qty) !== 1 ? { qty: Number(li.qty) || 0, unit_price: Number(li.unit) || 0 } : {}),
        }))
    }
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    setSaving(false)
    if (error) { notify.error('Could not save the invoice: ' + error.message); return }
    onSaved(patch as Partial<Invoice>)
  }

  return (
    // <form> so Enter in any field saves the draft (raw buttons below all carry
    // type="button" — the untyped-button-submits-the-form trap).
    <form onSubmit={e => { e.preventDefault(); if (!saving) save() }} className="mt-3 pt-3 border-t border-border space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5 text-accent-text" /> Edit draft</p>
        <button type="button" onClick={onCancel} className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Close editor"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Customer name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Service" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Weekly mowing" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Due date" type="date" value={due} onChange={e => setDue(e.target.value)} />
        {!editItems && (
          <Input label="Amount (before discount)" type="number" min="0" step="1" value={base} onChange={e => setBase(e.target.value)} />
        )}
      </div>

      {/* Line items — fully editable on a draft (description + price, add/remove).
          Note: a later job price/add-on edit re-syncs this draft from the job. */}
      {editItems && (
        <div>
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Line items</label>
          <div className="mt-1.5 space-y-1.5">
            <div className="hidden sm:flex items-center gap-2 px-0.5">
              <span className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Description</span>
              <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Qty</span>
              <span className="w-28 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Unit price</span>
              <span className="w-20 text-right text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Amount</span>
              <span className="w-3.5" aria-hidden />
            </div>
            {items.map((li, i) => (
              // Wraps on a phone: qty + unit + amount + remove need ~300px of fixed
              // width, which left the description a few pixels wide beside them.
              // Description takes its own row on mobile, one line on sm+.
              <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                <input value={li.description} placeholder="Description" aria-label="Line item description"
                  onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                  className="w-full sm:w-auto sm:flex-1 min-w-0 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
                {/* inputMode=decimal → the numeric keypad on a phone, not the
                    full keyboard. text-base on mobile stops iOS zooming the field. */}
                <input type="number" inputMode="decimal" min="0" step="1" value={li.qty} aria-label="Line item quantity"
                  onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                  className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-base sm:text-sm text-ink tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
                <div className="relative w-24 sm:w-28">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint text-sm" aria-hidden="true">$</span>
                  <input type="number" inputMode="decimal" min="0" step="1" value={li.unit} aria-label="Line item unit price"
                    onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))}
                    className="w-full bg-bg-tertiary border border-border-strong rounded-lg pl-6 pr-2 py-2 text-base sm:text-sm text-ink tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
                </div>
                {/* Derived, never typed — qty x unit is the single source for the line. */}
                <span className="flex-1 sm:flex-none sm:w-20 text-right text-sm font-medium text-ink tabular-nums" aria-label="Line total">{formatCurrency(lineAmount(li))}</span>
                <button type="button" onClick={() => setItems(prev => prev.filter((_, j) => j !== i))} disabled={items.length <= 1}
                  className="rounded-md text-ink-faint hover:text-red-400 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Remove line" title="Remove line">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <button type="button" onClick={() => setItems(prev => prev.length
          ? [...prev, { description: '', qty: '1', unit: '0', kind: 'addon' }]
          : [{ description: service.trim() || inv.service_type || 'Service', qty: '1', unit: base || '0', kind: 'service' }, { description: '', qty: '1', unit: '0', kind: 'addon' }])}
        className="text-xs font-semibold text-accent-text hover:underline rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        + Add line item
      </button>

      {/* Discount — none / fixed $ / percentage */}
      <div>
        <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Discount</label>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <div className="flex rounded-lg border border-border-strong overflow-hidden">
            <DiscBtn active={dType === ''} onClick={() => setDType('')}>None</DiscBtn>
            <DiscBtn active={dType === 'amount'} onClick={() => setDType('amount')} ariaLabel="Dollar discount"><DollarSign className="w-3.5 h-3.5" /></DiscBtn>
            <DiscBtn active={dType === 'percent'} onClick={() => setDType('percent')} ariaLabel="Percent discount"><Percent className="w-3.5 h-3.5" /></DiscBtn>
          </div>
          {dType && (
            <div className="relative w-36">
              <input
                type="number" min="0" step={dType === 'percent' ? '1' : '5'} max={dType === 'percent' ? '100' : undefined}
                autoFocus value={dValue} onChange={e => setDValue(e.target.value)}
                placeholder={dType === 'percent' ? '10' : '25'}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl pl-3 pr-8 py-2.5 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
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
        {t.hasGst && <Row label={`GST (${t.gstPercent}% — set in Settings)`} value={formatCurrency(t.gstAmount)} muted />}
        <div className="flex justify-between pt-1.5 border-t border-border"><span className="font-semibold text-ink">Total</span><span className="font-bold text-accent-text">{formatCurrency(t.total)}</span></div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" loading={saving}><Check className="w-3.5 h-3.5" /> Save draft</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function DiscBtn({ active, onClick, children, ariaLabel }: { active: boolean; onClick: () => void; children: React.ReactNode; ariaLabel?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} title={ariaLabel}
      className={cn('px-3 py-2 text-xs font-medium flex items-center gap-1 border-r border-border-strong last:border-r-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40',
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