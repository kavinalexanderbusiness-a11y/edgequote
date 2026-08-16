'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { pageAll } from '@/lib/supabase/pageAll'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { usePaymentsStatus } from '@/hooks/usePaymentsStatus'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { Invoice, InvoiceStatus, InvoiceDisplayStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings, Payment } from '@/types'
import { InvoiceDetail } from '@/components/payments/InvoiceDetail'
import { financiallyLocked } from '@/lib/payments/invoiceActions'
import { markDepositRequestSent, depositChargeAmount, depositState } from '@/lib/payments/deposit'
import { buildInvoiceSearchIndex, queryTokens, entryMatches } from '@/lib/invoiceSearch'
import { invoiceBalance, displayInvoiceStatus, cancelInvoice, reactivateInvoice, assertCurrent, receiptNumberFor } from '@/lib/payments/ledger'
import { isAutoPayHeld } from '@/lib/payments/autopay'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { SearchInput } from '@/components/ui/SearchInput'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { invoiceTotals, applyDiscount, type DiscountType } from '@/lib/invoiceTotals'
import { toast as notify } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { FileText, Check, Trash2, AlertTriangle, Pencil, Percent, DollarSign, X, MessageSquare, ChevronRight, ArrowLeft, Plus } from 'lucide-react'
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
  // 'deposit' is not a stored status — it is the "I asked for money up front and it
  // hasn't landed" view, which was previously unreachable: those invoices sit in
  // Unpaid/Sent/Partial alongside everything else with nothing to tell them apart.
  const [filter, setFilter] = useState<'' | InvoiceDisplayStatus | 'deposit'>('')
  const [query, setQuery] = useState('')
  // ── Focus IS the detail surface ────────────────────────────────────────────
  // `?invoice=INV-0042` / `?job=<id>` already narrowed the page to one invoice
  // (a Convert toast, a completed job's Invoice link). That mechanism was doing
  // half of a list/detail split already — the missing half was that the LIST rows
  // rendered the same full control set as the focused one, so every row of the
  // book was a stacked detail page: identity, money breakdown, status menu, card
  // link, charge-card, send, overflow, the deposit panel and the payment
  // controls, ~418px and 6–8 decisions each, on every invoice.
  //
  // So: focused → the full detail. Not focused → a summary row whose ONE action
  // is to open it. No new route, no second data path (the list already holds
  // every invoice, its ledger rows and the customer's credit), no new financial
  // maths — the same canonical calls, rendered in two densities.
  const [focus, setFocus] = useState<{ invoice?: string; job?: string } | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search)
    const invoice = p.get('invoice') || undefined
    const job = p.get('job') || undefined
    return invoice || job ? { invoice, job } : null
  })
  // Opening pushes history, so the phone's Back gesture closes the detail instead
  // of leaving Invoices entirely — and the URL stays the shareable deep link it
  // has always been.
  const openInvoice = (inv: Invoice) => {
    setFocus({ invoice: inv.invoice_number })
    if (typeof window !== 'undefined') {
      window.history.pushState({ eqInvoice: inv.invoice_number }, '', `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`)
      window.scrollTo({ top: 0 })
    }
  }
  const closeInvoice = () => {
    setFocus(null)
    if (typeof window !== 'undefined') window.history.pushState({}, '', '/dashboard/invoices')
  }
  // Back/forward re-read the URL — the same parse the initial state uses, so a
  // deep link, a click and a history entry can never disagree about what's open.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search)
      const invoice = p.get('invoice') || undefined
      const job = p.get('job') || undefined
      setFocus(invoice || job ? { invoice, job } : null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // `?pay=1` — the field "Get paid" tap on a completed job card. Lands on that one
  // invoice with the record-payment form already open, so collecting in the driveway
  // is one tap from the schedule instead of a hunt through the invoice list.
  const [payIntent] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('pay') === '1'
  })
  // The ONE shared Send Message dialog, opened for a specific invoice's customer.
  const [msgInvoice, setMsgInvoice] = useState<Invoice | null>(null)
  // The deposit ASK, going through the SAME dialog — separate state because the
  // template, the amount and the on-success stamp are all different from a
  // full-invoice send (see the dialog at the bottom of the page).
  const [depositMsg, setDepositMsg] = useState<{ invoice: Invoice; amount: number } | null>(null)
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
        // PAGED. An unbounded select silently stops at 1000 rows, so on a busy book
        // the invoice list (and its Owed total) truncated to the newest 1000 while
        // the dashboard's Owed — already paged — counted them all. Two money figures
        // for the same question. pageAll appends the `id` tiebreak to created_at.
        pageAll<Invoice>(() => supabase
          .from('invoices')
          .select('*, customers(id, name, email, phone)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        // Which customers have a saved card → enables the "Charge saved card" action.
        supabase.from('payment_methods').select('customer_id').eq('user_id', user.id),
        // Customer credit ledger (kind='credit') → available credit per customer. Paged:
        // a truncated credit read understates the balance the owner may apply.
        pageAll<{ customer_id: string | null; amount: number }>(() => supabase
          .from('payments').select('customer_id, amount').eq('user_id', user.id).eq('kind', 'credit')),
        // Every invoice-linked ledger row → permanent per-invoice receipts + revert.
        // Paged: past 1000 payments, an invoice would silently lose its receipts.
        // `in ('payment','tip')` rather than `eq 'payment'`: a gratuity taken with
        // an online payment belongs on that invoice's payment list — it is money
        // the customer sent alongside this bill, and an owner looking at the
        // invoice should see it there rather than only in the ledger. It changes
        // no figure: the balance comes from invoices.amount_paid, which the
        // trigger derives from kind='payment' alone. Credit rows stay excluded —
        // they are the liability ledger and have their own reader above.
        pageAll<Payment>(() => supabase
          .from('payments').select('*').eq('user_id', user.id).in('kind', ['payment', 'tip']).not('invoice_id', 'is', null).order('paid_at', { ascending: true })),
      ])
      // A failed fetch must NOT render as "No invoices yet" on billing day.
      if (iRes.error) { setLoadError('Could not load invoices: ' + iRes.error); return }
      setLoadError(null)
      setInvoices(iRes.rows)
      // Cache only the first screenful — invoices carry a line_items jsonb + a customer
      // join, so serializing all 15k on every fetch (incl. each realtime tick) would blow
      // the sessionStorage quota and block the main thread. First screen paints instantly;
      // the full list follows from the query above.
      writeCache('invoices-list', iRes.rows.slice(0, 60))
      setSettings(sRes.data as BusinessSettings | null)
      setCardCustomers(new Set(((pmRes.data as { customer_id: string }[] | null) || []).map(r => r.customer_id)))
      const credit: Record<string, number> = {}
      for (const r of crRes.rows) {
        if (r.customer_id) credit[r.customer_id] = Math.round(((credit[r.customer_id] || 0) + Number(r.amount || 0)) * 100) / 100
      }
      setCreditByCustomer(credit)
      const byInv: Record<string, Payment[]> = {}
      for (const p of payRes.rows) { if (p.invoice_id) (byInv[p.invoice_id] ||= []).push(p) }
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
      // The engine refuses a cancelled invoice. Without its own branch this fell to
      // the generic "Could not charge" below — which reads as a failure to retry
      // rather than a deliberate refusal, and hides the one-tap fix.
      else if (d.result === 'skipped' && d.reason === 'cancelled') notify(`${inv.invoice_number} is cancelled — reactivate it first if this is still owed.`)
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

  // The receipt for the most recent money-in row on this invoice — the detail's
  // primary action once an invoice is settled. Same engine every other receipt
  // door uses (renderReceiptBlob off a ledger row); nothing is stored, and no
  // balance is projected.
  async function downloadLatestReceipt(inv: Invoice) {
    const rows = (paymentsByInvoice[inv.id] || []).filter(p => Number(p.amount) > 0)
    const p = rows[rows.length - 1]      // the fetch orders paid_at ascending
    if (!p) { notify.error('This invoice has no recorded payment to receipt yet.'); return }
    setOpeningId(inv.id)
    try {
      const [{ renderReceiptBlob }, { downloadBlob }] = await Promise.all([
        import('@/components/payments/ReceiptPDF'), import('@/lib/portalPdf'),
      ])
      downloadBlob(await renderReceiptBlob(p, inv, settings), `${receiptNumberFor(p.id)}.pdf`)
    } catch {
      notify.error('Could not generate the receipt PDF. Please try again.')
    } finally {
      setOpeningId(null)
    }
  }

  // ── The invoice's lifecycle writes ────────────────────────────────────────
  // These live on the page, not in the detail card: the detail is presentation,
  // and every mutation of an invoice belongs to the surface that owns the data.
  async function setInvoiceStatus(inv: Invoice, status: InvoiceStatus, msg: string) {
    // Same rule as markSent: a draft becoming 'sent' is being ISSUED today, and
    // its creation-day stamp would otherwise leave it in no reporting period at
    // all. Only from 'draft' — an 'unpaid' invoice is already counted in a period
    // that may already be filed.
    const patch: { status: InvoiceStatus; issued_date?: string } =
      status === 'sent' && inv.status === 'draft'
        ? { status, issued_date: todayISO() }
        : { status }
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    if (error) { notify.error('Could not update the status: ' + error.message); return }
    fetchInvoices()
    notify.success(msg)
  }

  // A $0 invoice can't be paid: both charge routes reject a zero balance with
  // "This invoice is already paid", so approving one sends the customer a
  // document that dead-ends. The auto-draft engine already refuses to create
  // one — the manual path is the only way to reach this state. Uses the SAME
  // ledger total the list, PDF and charge routes read.
  async function approveDraft(inv: Invoice) {
    if (invoiceBalance(inv, settings).total <= 0) {
      notify.error(`${inv.invoice_number} is $0 — add a line item with a price before approving it.`)
      return
    }
    await setInvoiceStatus(inv, 'unpaid', `${inv.invoice_number} approved — ready to send.`)
  }

  async function cancelWithUndo(inv: Invoice) {
    const res = await cancelInvoice(supabase, inv)
    if (res.error) { notify.error(res.error); return }
    fetchInvoices()
    notify.undo(`${inv.invoice_number} cancelled.`, async () => {
      const r = await reactivateInvoice(supabase, inv.id)
      if (r.error) notify.error('Could not reactivate the invoice: ' + r.error)
      fetchInvoices()
    })
  }

  // Send issues the invoice, so it can reach 'sent' without ever passing
  // Approve — the $0 guard has to live on both doors, not just the one the owner
  // usually uses. And a draft AutoPay HELD for review is an amount the system
  // itself distrusted: never let one tap put it in front of the customer without
  // naming the anomaly first.
  async function sendInvoice(inv: Invoice) {
    if (invoiceBalance(inv, settings).total <= 0) {
      notify.error(`${inv.invoice_number} is $0 — add a line item with a price before sending it.`)
      return
    }
    if (inv.status === 'draft' && isAutoPayHeld(inv)) {
      const ok = await confirmDialog({
        title: 'Send an invoice that was held for review?',
        message: `${inv.invoice_number} was held because the amount looks unusual for this customer${inv.internal_notes ? ` — ${inv.internal_notes}` : ''}. Send it as-is?`,
        confirmLabel: 'Send it anyway',
      })
      if (!ok) return
    }
    setMsgInvoice(inv)
  }

  // Presentation-level guard only — a real card charge deserves one deliberate
  // confirmation before the EXACT existing handler runs.
  // ⚠️ The figure is the BALANCE, not depositChargeAmount: AutoPay deliberately
  // charges the full balance (its `autopay:<invoiceId>` key allows ONE charge per
  // invoice ever, so a deposit-sized charge would make the remainder
  // uncollectable by AutoPay forever) and this button shares that engine. A
  // confirm quoting the deposit would name a figure that is not about to be taken.
  async function confirmChargeSavedCard(inv: Invoice) {
    if (!(await confirmDialog({
      title: 'Charge saved card',
      message: `Charge ${formatCurrency(invoiceBalance(inv, settings).balance)} to the saved card for ${inv.invoice_number}?`,
      confirmLabel: 'Charge card',
    }))) return
    chargeSavedCard(inv)
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
    // Sending a DRAFT is the moment it is issued, so stamp the date it was issued.
    //
    // Completing a job auto-drafts an invoice stamped with THAT day's issued_date.
    // Send it in a later quarter and it fell through every report: the tax summary
    // excludes drafts (correctly — nobody had been asked to pay), so it was out of
    // Q1 at filing time; and its issued_date still said Q1, so `inPeriod` kept it
    // out of Q2 as well. The invoice existed in NO period and its GST was never
    // remitted. The comment above already says sending IS issuing — this makes the
    // stored date agree with it.
    //
    // ONLY from 'draft'. An 'unpaid' invoice is already inside the reports (they
    // exclude drafts and cancelled, nothing else), so re-dating it on send would
    // yank it out of a quarter that may already be filed — trading this defect for
    // a worse one. A draft is in no report by definition, so stamping it is free.
    const patch: { status: InvoiceStatus; issued_date?: string } = { status: 'sent' }
    if (inv.status === 'draft') patch.issued_date = todayISO()
    setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, ...patch, status: 'sent' as InvoiceStatus } : i))
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    if (error) { setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, status: inv.status, issued_date: inv.issued_date } : i)); notify.error('Could not mark sent: ' + error.message) }
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
      // Restore everything that makes the invoice what it was — else Undo silently
      // drops it: the discount (its net wouldn't reproduce), the owner's internal
      // note (home of the AutoPay-hold flag — losing it un-holds a held invoice),
      // and the hand-edited-breakdown pin (else a restored change-order draft goes
      // back to auto-re-pricing and loses the owner's lines on the next job edit).
      discount_type: i.discount_type ?? null, discount_value: i.discount_value ?? null,
      internal_notes: i.internal_notes, line_items_edited: i.line_items_edited ?? false,
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
      // Warn on MONEY COLLECTED, not on the word "paid". Gating on
      // status === 'paid' missed 'partial' and 'overpaid' — the deposit states —
      // so deleting an invoice that had already taken $2,000 showed the plain
      // label and the owner lost the one cue that revenue was leaving the books.
      // The figure is the ledger's, not the pre-GST `amount` the row never showed.
      const collected = invoiceBalance(inv, settings).paid
      const label = collected > 0.01
        ? `Deleted ${inv.invoice_number} — ${formatCurrency(collected)} had been collected`
        : `Deleted ${inv.invoice_number}`
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
  // Outstanding = the unpaid BALANCE across issued invoices (partial payments count).
  // Cancelled invoices are dead paper — excluded from money totals.
  const outstanding = invoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((sum, i) => sum + Math.max(0, invoiceBalance(i, settings).balance), 0)
  const today = todayISO()
  // Filter on the DISPLAY status so the lifecycle states (Overdue, Viewed) are
  // filterable even though they're derived, not stored. Cancelled hides from All.
  const focused = focus
    ? invoices.filter(i => (focus.invoice && i.invoice_number === focus.invoice) || (focus.job && i.job_id === focus.job))
    : null
  // Status first, exactly as before — search NARROWS the chosen status, it does not
  // replace it. (A search box that silently drops back to "All" is how an owner
  // concludes an invoice is missing when it is merely paid.)
  const byStatus = focused && focused.length > 0 ? focused
    : filter === 'deposit'
      // "Asked for money up front and it hasn't landed" — draft (not yet sent) or
      // sent (awaiting payment). 'paid' deposits are done and 'none' never asked.
      // depositState is the canonical engine; nothing is recomputed here.
      ? invoices.filter(i => {
          const d = depositState(i, settings)
          return (d.status === 'draft' || d.status === 'sent') && i.status !== 'cancelled'
        })
      : filter
        ? invoices.filter(i => displayInvoiceStatus(i, settings, today) === filter || (filter !== 'cancelled' && i.status === filter))
        : invoices.filter(i => i.status !== 'cancelled')
  // Built once per data change, not per keystroke — the whole book is already in
  // memory (see lib/invoiceSearch), so a keystroke is a substring scan, not a query.
  // How many deposits are still waiting on money — gates the pill's existence and
  // labels it, so the owner can see the size of the ask without opening the filter.
  const depositWaitingCount = invoices.filter(i => {
    if (i.status === 'cancelled') return false
    const d = depositState(i, settings)
    return d.status === 'draft' || d.status === 'sent'
  }).length
  const searchEntries = useMemo(() => {
    const m = new Map<string, { text: string; ident: string }>()
    for (const e of buildInvoiceSearchIndex(invoices)) m.set(e.item.id, { text: e.text, ident: e.ident })
    return m
  }, [invoices])
  const tokens = queryTokens(query)
  const searching = tokens.length > 0
  // Plain derivation, not a memo: byStatus is rebuilt every render anyway, so a memo
  // over it would either recompute regardless or need a dependency lie. The scan is
  // a Map lookup + substring test per row over prepared strings.
  const visible = searching
    ? byStatus.filter(i => { const e = searchEntries.get(i.id); return !!e && entryMatches(e, tokens) })
    : byStatus
  // Detail when the page is focused on a specific invoice (or a job's invoices —
  // `?job=` can legitimately match more than one, and each of those deserves the
  // full surface). Everything else is the list. Derived from the SAME `focused`
  // set `byStatus` already uses, so the two can't disagree about what's open.
  const detailMode = !!focus && focused !== null && focused.length > 0

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

      {/* ONE figure, because this page has one job: what is still owed.
          Two tiles left with it and are not missed. "Drafts to review" was a
          filter button dressed as a statistic, identical in appearance to two
          inert cards beside it, and its count already rides on the Drafts pill
          six pixels below — the same filter with two controls. "Collected" was
          all-time lifetime revenue on the screen about UNPAID work; it lives on
          Payments, which is the ledger. Removing them takes ~90px of chrome off
          the top of the fold and deletes a duplicate control. */}
      {!loading && !loadError && invoices.length > 0 && (
        <Card>
          <CardBody className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Outstanding</p>
              <p className="text-xl font-black tracking-tight tabular-nums text-amber-400">{formatCurrency(outstanding)}</p>
            </div>
            <p className="text-[11px] text-ink-faint">Billed and still owed — partial payments already deducted.</p>
          </CardBody>
        </Card>
      )}

      {!loading && !loadError && invoices.length > 0 && (
        // One scrollable row on phones (the quotes-list idiom) — 9 pills used to
        // wrap into a 2-3 row wall between the KPIs and the first invoice.
        <div className="space-y-2">
          <SearchInput
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              // A deep link (?invoice=/?job=) pins the list to ONE row. Typing is an
              // explicit "show me something else", so the pin is released — otherwise
              // search appears broken: you type and the same single invoice stays put.
              if (e.target.value && focus) {
                setFocus(null)
                if (typeof window !== 'undefined') window.history.replaceState({}, '', '/dashboard/invoices')
              }
            }}
            placeholder="Search invoice #, customer, address or service"
            aria-label="Search invoices"
          />
          <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {FILTERS.map(f => (
              <FilterPill key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}{f.value === 'draft' && drafts.length > 0 ? ` (${drafts.length})` : ''}
              </FilterPill>
            ))}
            {/* Only for businesses that actually take deposits — a dead pill on every
                other book is clutter, and this list is already nine pills wide. */}
            {depositWaitingCount > 0 && (
              <FilterPill active={filter === 'deposit'} onClick={() => setFilter(filter === 'deposit' ? '' : 'deposit')}>
                Deposit due ({depositWaitingCount})
              </FilterPill>
            )}
          </div>
          {/* Says what the list is showing WITHOUT making you count rows, and gives
              the one-tap way back. Only while searching — silence when it's just the list. */}
          {searching && (
            <p className="text-[11px] text-ink-faint flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>
                {visible.length === 0
                  ? 'No matches'
                  : `${visible.length} of ${byStatus.length} ${byStatus.length === 1 ? 'invoice' : 'invoices'}`}
                {filter ? ` in ${filter === 'deposit' ? 'deposit due' : filter}` : ''}
              </span>
              <button type="button" onClick={() => setQuery('')} className="font-semibold text-accent-text hover:underline">
                Clear search
              </button>
            </p>
          )}
        </div>
      )}
      {/* The way out of the detail. Reads as a back control now that focus IS the
          detail surface, not just a deep-link filter. */}
      {focus && (
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={closeInvoice}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 tap-target-y">
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> All invoices
          </button>
          {/* A link to an invoice that has since been deleted used to fall through
              to the full list with a lone "Show all" — indistinguishable from
              having opened the list on purpose. Say which one is missing. */}
          {!loading && !detailMode && (
            <span className="text-xs text-ink-faint">
              {focus.invoice ? `${focus.invoice} isn’t here any more` : 'That job has no invoice yet'} — showing everything instead.
            </span>
          )}
        </div>
      )}

      {/* One-line status legend — 'Unpaid' vs 'Sent' is invisible tribal knowledge
          otherwise (tap the status pill on a row to flip between them). */}
      {!loading && !loadError && (filter === 'unpaid' || filter === 'sent') && (
        <p className="text-[11px] text-ink-faint -mt-3">
          Unpaid = issued but not yet sent to the customer · Sent = delivered, awaiting payment. Open an invoice to switch.
        </p>
      )}

      {loading ? (
        <SkeletonRows count={6} />
      ) : loadError ? null : invoices.length === 0 ? (
        <EmptyState icon={FileText} title="No invoices yet"
          description={<>Completing a recurring visit drafts one automatically — or open an accepted quote and click <span className="font-medium text-ink">Convert to Invoice</span>.</>} />
      ) : visible.length === 0 ? (
        // Three different nothings, said differently — "no results for what you typed"
        // is a dead end if it reads the same as "you have no unpaid invoices".
        <InlineEmpty>
          {searching ? (
            <>
              Nothing matches <span className="font-semibold text-ink">“{query.trim()}”</span>
              {filter ? ` in ${filter === 'deposit' ? 'deposit due' : filter}` : ''}.{' '}
              <button type="button" onClick={() => setQuery('')} className="font-semibold text-accent-text hover:underline">Clear search</button>
              {filter ? <> or <button type="button" onClick={() => setFilter('')} className="font-semibold text-accent-text hover:underline">search all invoices</button></> : null}
            </>
          ) : filter === 'deposit' ? 'No deposits are waiting on payment.'
            : filter ? `No ${filter} invoices.` : 'No invoices to show.'}
        </InlineEmpty>
      ) : (
        /* ── ONE panel, not 66 cards ─────────────────────────────────────────
           In detail mode each invoice IS its own object (its own payments, its
           own deposit panel), so it keeps its own card. The LIST is one thing —
           "which invoice?" — and 66 separately-bordered, separately-filled,
           gap-separated cards asked the eye to parse 66 objects to answer it.
           Measured on the real page: 66 drawn boundaries became 1. A hairline
           between rows carries the same separation at a fraction of the weight,
           which is the pattern the app's best surfaces (the dashboard's work
           days, Grow's Customer Health) already use by hand. */
        <div className={detailMode ? 'space-y-3' : 'rounded-card border border-border bg-surface divide-y divide-border overflow-hidden'}>
          {visible.map((inv, i) => detailMode ? (
            <InvoiceDetail
              key={inv.id}
              inv={inv}
              settings={settings}
              today={today}
              uid={uid}
              index={i}
              payments={paymentsByInvoice[inv.id] || []}
              credit={inv.customer_id ? (creditByCustomer[inv.customer_id] || 0) : 0}
              paymentsEnabled={paymentsEnabled}
              hasSavedCard={!!inv.customer_id && cardCustomers.has(inv.customer_id)}
              payIntent={payIntent && focused?.length === 1 && focused[0].id === inv.id}
              paying={payingId === inv.id}
              charging={chargingId === inv.id}
              opening={openingId === inv.id}
              deleting={deletingId === inv.id}
              editorOpen={editId === inv.id}
              editor={
                <DraftInvoiceEditor
                  inv={inv}
                  settings={settings}
                  onCancel={() => setEditId(null)}
                  onSaved={async patch => {
                    const updated = { ...inv, ...patch } as Invoice
                    setInvoices(prev => prev.map(x => x.id === inv.id ? updated : x))
                    setEditId(null)
                    // The customer is holding the OLD version. Editing silently
                    // would leave two different truths for one invoice number —
                    // so ask, and hand off to the SAME send dialog the Send
                    // action uses. Declining is fine: the edit is saved either
                    // way, and the invoice still offers Send.
                    if (inv.status === 'sent') {
                      const ok = await confirmDialog({
                        title: `Resend ${inv.invoice_number}?`,
                        message: `${inv.customer_name || 'The customer'} already has the previous version. Send them the updated invoice so their copy matches your books?`,
                        confirmLabel: 'Resend it',
                        cancelLabel: 'Not now',
                      })
                      if (ok) setMsgInvoice(updated)
                    }
                  }}
                />
              }
              onToggleEditor={() => setEditId(editId === inv.id ? null : inv.id)}
              onDownloadPdf={() => openInvoicePdf(inv)}
              onDownloadReceipt={() => downloadLatestReceipt(inv)}
              onCardLink={() => payNow(inv)}
              onChargeCard={() => confirmChargeSavedCard(inv)}
              onSend={() => sendInvoice(inv)}
              onSendDepositRequest={(invoice, amount) => setDepositMsg({ invoice, amount })}
              onDelete={() => deleteInvoice(inv)}
              onSetStatus={(status, msg) => setInvoiceStatus(inv, status, msg)}
              onApproveDraft={() => approveDraft(inv)}
              onCancelInvoice={() => cancelWithUndo(inv)}
              onChanged={fetchInvoices}
              onIssueDraft={() => markSent(inv)}
            />
          ) : (
            /* ── The LIST row ──────────────────────────────────────────────────
               Answers "which invoice?" and nothing else: number, customer, what
               state it's in, the figure that matters, and one way in. Every
               other control this invoice has lives one tap away, in the detail.

               The money figure is the BALANCE once anything has been paid — that
               is the number an owner is chasing, and it used to render at
               text-[10px] inside the status pill while the invoice TOTAL (a
               historical fact) took the 18px slot. Both come from invoiceBalance;
               nothing new is computed. */
            (() => {
              const ds = displayInvoiceStatus(inv, settings, today)
              const bal = invoiceBalance(inv, settings)
              const partPaid = bal.paid > 0.01 && bal.balance > 0.01
              const dep = depositState(inv, settings)
              const depositDue = dep.status === 'draft' || dep.status === 'sent'
              return (
                <button
                  key={inv.id}
                  type="button"
                  onClick={() => openInvoice(inv)}
                  aria-label={`Open ${inv.invoice_number} for ${inv.customer_name || 'this customer'}`}
                  // A row in a panel, no longer a card of its own: the border,
                  // radius and fill live on the panel now, so the row carries
                  // only its hover. focus ring is `-inset` so it draws INSIDE
                  // the clipped panel instead of being cut off by it.
                  className={`w-full text-left bg-transparent hover:bg-surface-raised active:scale-[0.997] transition-all px-4 py-3.5 flex items-center gap-3 animate-rise stagger-${Math.min(i + 1, 6)} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}
                >
                  <div className="min-w-0 flex-1">
                    {/* flex-wrap: an invoice can carry BOTH a status pill and the
                        deposit chip ("Partially Paid" + "Deposit due" ≈ 248px of
                        shrink-0 content in the ~198px this column gets at 390px),
                        and the identity must never be the thing that gets clipped. */}
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="text-sm font-semibold text-ink shrink-0">{inv.invoice_number}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border uppercase tracking-wide font-semibold shrink-0 ${INVOICE_STATUS_COLORS[ds]}`}>
                        {INVOICE_STATUS_LABELS[ds]}
                      </span>
                      {/* The one state the status vocabulary can't express: money
                          was ASKED FOR up front and hasn't arrived. Same engine
                          the Deposit-due filter counts. */}
                      {depositDue && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-accent-text uppercase tracking-wide font-semibold shrink-0">
                          Deposit due
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted truncate mt-0.5">
                      {inv.customer_name || 'No customer'}
                      <span className="text-ink-faint"> · {formatDate(inv.issued_date || inv.created_at)}</span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-base font-bold text-ink tabular-nums">
                      {formatCurrency(partPaid ? bal.balance : bal.total)}
                    </span>
                    <p className="text-[10px] text-ink-faint tabular-nums">
                      {partPaid ? `left of ${formatCurrency(bal.total)}` : bal.balance <= 0.01 && bal.total > 0 ? 'paid' : 'total'}
                    </p>
                  </div>
                  <ChevronRight aria-hidden className="w-4 h-4 text-ink-faint shrink-0" />
                </button>
              )
            })()
          ))}
        </div>
      )}

      {/* The page ends at the invoice list.
          A recent-payments feed and the Stripe reconciliation panel used to hang
          below it — both are LEDGER surfaces, and both already exist on Payments
          in stronger form (search, kind filters, date ranges, CSV, credit
          balances). Keeping a weaker copy here cost this page its answer to
          "what do I still need to collect", and cost Payments its reason to
          exist: the same word "Collected" appeared on both, scoped differently,
          with neither saying so. Per-invoice receipts are untouched — they live
          on the invoice card, which is where an invoice's own history belongs. */}

      {/* ONE shared Send Message dialog — sending marks the invoice sent. The amount
          is what's actually DUE NOW, never the original total: a customer who has
          already part-paid must never be asked for the full amount, and neither
          must one who was asked for a deposit.
          depositChargeAmount is the SAME rule the Pay button and the invoice PDF
          use, so the message, the document and the checkout can't name three
          different figures. While a deposit is outstanding the composer also opens
          on the deposit template — "your invoice for $2,000" would misdescribe a
          $4,000 invoice, where "a deposit of $2,000" is exactly true. The owner can
          still switch template in the dialog. */}
      {msgInvoice?.customer_id && (() => {
        const due = depositChargeAmount(msgInvoice, settings)
        return (
          <SendMessageDialog open onClose={() => setMsgInvoice(null)}
            customerId={msgInvoice.customer_id} customerName={msgInvoice.customer_name}
            defaultTemplate={due.isDeposit ? 'deposit_request' : 'invoice'}
            vars={{ amount: formatCurrency(due.amount) }}
            onSent={async () => {
              await markSent(msgInvoice)
              // Sending the deposit ask from THIS door is still the deposit ask —
              // it must stamp the request, or the panel keeps saying "Not sent"
              // about a message the customer already has.
              if (due.isDeposit) {
                const res = await markDepositRequestSent(supabase, msgInvoice.id)
                if (res.error) notify.error('Sent, but couldn’t record it as sent — the deposit will still show as “Not sent”.')
                fetchInvoices()
              }
            }} />
        )
      })()}

      {/* The deposit ASK — the SAME dialog and pipeline as the invoice send, with
          three deliberate differences: the template names the amount as a deposit
          (not "your invoice for…"), {{amount}} is the deposit still to collect
          (never the total), and success stamps deposit_requested_at — which is the
          ONLY writer of that stamp, and it runs ONLY after the dialog confirms a
          delivery (or a persisted scheduled send — the same contract markSent
          already accepts). A failed send stamps nothing and the panel keeps
          reading "Not sent". Sending the ask also issues a draft (markSent): the
          message points the customer at the portal, where the invoice is now
          visible — same one-intent-one-action rule as sending the invoice. */}
      {depositMsg?.invoice.customer_id && (
        <SendMessageDialog open onClose={() => setDepositMsg(null)}
          customerId={depositMsg.invoice.customer_id} customerName={depositMsg.invoice.customer_name}
          title={`Request deposit — ${depositMsg.invoice.invoice_number}`}
          defaultTemplate="deposit_request" templates={['deposit_request', 'custom']}
          vars={{ amount: formatCurrency(depositMsg.amount) }}
          onSent={async () => {
            const inv = depositMsg.invoice
            await markSent(inv)
            const res = await markDepositRequestSent(supabase, inv.id)
            // The message reached the customer but the stamp didn't land: say so
            // honestly — the panel will still read "Not sent", and re-sending is
            // harmless (same amount, same idempotent pipeline).
            if (res.error) notify.error('Sent, but couldn’t record it as sent — the deposit will still show as “Not sent”.')
            fetchInvoices()
          }} />
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
  onSaved: (patch: Partial<Invoice>) => void | Promise<void>
  onCancel: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const liSum = (inv.line_items || []).reduce((s, li) => s + Number(li.amount || 0), 0)
  const itemized = (inv.line_items?.length ?? 0) > 1
  const initial = invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value })
  // Settled money is history: the figures lock, the words don't.
  const locked = financiallyLocked(inv, settings)
  const paidSoFar = Math.round((Number(inv.amount_paid) || 0) * 100) / 100

  const [name, setName] = useState(inv.customer_name || '')
  const [service, setService] = useState(inv.service_type || '')
  const [due, setDue] = useState(inv.due_date || '')
  const [notes, setNotes] = useState(inv.notes || '')
  const [internalNotes, setInternalNotes] = useState(inv.internal_notes || '')
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
  // The exact shape persisted to invoices.line_items — reused to detect a genuine
  // breakdown edit (persisted-vs-baseline, so a blank row, key order, or a
  // defaulted kind can't fake an edit).
  const toPersisted = (arr: { description: string; qty: string; unit: string; kind: string }[]) =>
    arr
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
  // Snapshot the loaded breakdown once, so save can tell an owner edit from a no-op.
  const [baselinePersistedJSON] = useState(() => JSON.stringify(toPersisted(items)))
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
    if (!locked && editItems && items.some(li => lineAmount(li) !== 0 && !li.description.trim())) {
      notify.error('Every priced line needs a description — otherwise it won’t appear on the invoice.')
      return
    }
    // You cannot bill LESS than you've already taken. Dropping the total under
    // amount_paid would leave the ledger holding money the invoice no longer
    // claims — the recompute trigger would flip it to 'overpaid' and the owner
    // would owe a refund they never agreed to. Compared on the SAME GST-inclusive
    // total the list, PDF and charge routes read.
    if (!locked && paidSoFar > 0 && t.total < paidSoFar) {
      notify.error(`${formatCurrency(paidSoFar)} is already paid on ${inv.invoice_number} — the total can’t go below that. Refund the difference first if the price really dropped.`)
      return
    }
    setSaving(true)
    // A payment landing while the editor was open makes every figure above stale.
    // Same guard the credit/refund writers use — one staleness rule, not two.
    const stale = await assertCurrent(supabase, inv)
    if (stale) { setSaving(false); notify.error(stale); return }
    const hasD = !!dType && Number(dValue) > 0
    // invoice_number and status are deliberately ABSENT: an edit is the same
    // document, so it keeps its number, and approving/sending is not undone by
    // fixing a typo. (A 'sent' invoice stays sent — the page offers a resend.)
    const patch: Record<string, unknown> = {
      customer_name: name.trim() || inv.customer_name,
      service_type: service.trim() || null,
      due_date: due || null,
      notes: notes.trim() || null,
      // Non-financial → stays editable even on a settled invoice.
      internal_notes: internalNotes.trim() || null,
    }
    // The money half — omitted entirely once the invoice is settled, so a locked
    // invoice cannot have its figures rewritten even if state went stale.
    if (!locked) {
      patch.amount = Math.round(net)
      patch.discount_type = hasD ? dType : null
      patch.discount_value = hasD ? Number(dValue) : null
    }
    // Persist the breakdown the owner sees: edited rows when itemized, or the
    // single line kept in step with the base so the PDF total never diverges.
    if (!locked && editItems) {
      const nextLineItems = toPersisted(items)
      patch.line_items = nextLineItems
      // The moment the owner's breakdown diverges from what loaded, this draft is
      // theirs: pin it so syncDraftInvoiceAmounts never silently re-derives their
      // line_items/amount from the job later (the change-order-loss bug). Set only,
      // never cleared — a later no-op save can't un-own it.
      if (JSON.stringify(nextLineItems) !== baselinePersistedJSON) patch.line_items_edited = true
    }
    const { error } = await supabase.from('invoices').update(patch).eq('id', inv.id)
    setSaving(false)
    if (error) { notify.error('Could not save the invoice: ' + error.message); return }
    // A money edit re-derives status/amount_paid/paid_at in the DB (the same
    // recompute engine payments fire — trg_recompute_invoice_on_edit). RETURNING
    // can't see that AFTER-trigger write, so read the row back: discounting an
    // invoice to exactly what's been paid flips it to 'paid' and the pill must
    // say so now, not after a refresh. Best-effort — on a failed read the edit
    // is still saved and the next fetch shows the derived state.
    if (!locked) {
      const { data: derived } = await supabase.from('invoices')
        .select('status, amount_paid, paid_at').eq('id', inv.id).maybeSingle()
      if (derived) Object.assign(patch, derived)
    }
    onSaved(patch as Partial<Invoice>)
  }

  return (
    // <form> so Enter in any field saves the draft (raw buttons below all carry
    // type="button" — the untyped-button-submits-the-form trap).
    <form onSubmit={e => { e.preventDefault(); if (!saving) save() }} className="mt-3 pt-3 border-t border-border space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5">
          <Pencil className="w-3.5 h-3.5 text-accent-text" /> {locked ? 'Edit notes' : inv.status === 'draft' ? 'Edit draft' : `Edit ${inv.invoice_number}`}
        </p>
        <button type="button" onClick={onCancel} className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Close editor"><X className="w-4 h-4" /></button>
      </div>

      {/* Say WHY the money is read-only, next to the money — not as a surprise on save. */}
      {locked && (
        <Banner tone="info" icon={Check}>
          {formatCurrency(paidSoFar)} received — this invoice is settled, so the amount, line items and discount are locked. Notes and details are still editable.
        </Banner>
      )}
      {/* An already-sent invoice is in the customer's hands: saying so up front is
          the difference between an edit and a surprise. */}
      {!locked && inv.status === 'sent' && (
        <Banner tone="warn" icon={MessageSquare}>
          {inv.invoice_number} is already with the customer. Saving changes it here — you&rsquo;ll be asked whether to resend it.
        </Banner>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Customer name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Service" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Weekly mowing" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Due date" type="date" value={due} onChange={e => setDue(e.target.value)} />
        {!locked && !editItems && (
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

      {/* Two notes, and the labels have to make the difference obvious — the whole
          point is that one of these is printed and the other never is. */}
      <Textarea label="Notes (the customer sees this)" value={notes} onChange={e => setNotes(e.target.value)} rows={2}
        placeholder="Shown on the invoice PDF — e.g. “Thanks for your business!”" />
      <Textarea label="Internal note (private — never on the PDF)" value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2}
        placeholder="Only you see this. The app also records here why a draft exists, and why AutoPay held a charge." />

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