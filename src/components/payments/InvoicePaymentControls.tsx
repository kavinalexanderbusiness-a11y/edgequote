'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { Invoice, BusinessSettings, Payment, PAYMENT_METHODS, paymentMethodLabel } from '@/types'
import { Button } from '@/components/ui/Button'
import { invoiceBalance, recordPayment, applyCreditToInvoice, overpaymentToCredit, recordRefund, receiptNumberFor, removePayment, restorePayment } from '@/lib/payments/ledger'
import { receiptMessageBody } from '@/lib/comms/templates'
import { Wallet, Plus, Gift, RotateCcw, Banknote, TrendingUp, X, FileDown, Mail, MessageSquare, ReceiptText } from 'lucide-react'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Per-invoice payment controls: the Total / Paid / Balance summary, a one-form
// Record-Payment (multiple payments per invoice), the overpayment resolver
// (credit / refund / raise total), and one-tap apply-credit. All movements go
// through the shared ledger so dashboard, portal and reports update automatically.
export function InvoicePaymentControls({ invoice, settings, uid, credit, payments = [], onChanged }: {
  invoice: Invoice
  settings: BusinessSettings | null
  uid: string
  credit: number              // the customer's available credit
  payments?: Payment[]        // this invoice's ledger rows (permanent receipts + revert)
  onChanged: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { total, paid, balance, overpaid } = invoiceBalance(invoice, settings)

  const [amount, setAmount] = useState(balance > 0 ? String(balance) : '')
  const [method, setMethod] = useState('etransfer')
  const [date, setDate] = useState(todayISO())
  const [notes, setNotes] = useState('')
  // The just-recorded payment → drives the automatic receipt panel (PDF/email/SMS).
  const [lastPayment, setLastPayment] = useState<Payment | null>(null)
  const [sendingReceipt, setSendingReceipt] = useState<string | null>(null)
  // Per-row busy state for the PERMANENT ledger list (receipt download / revert).
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  // Revert = remove the ledger row through the engine; the trigger re-derives the
  // invoice (paid → partial/unpaid) naturally. Undo re-inserts the same row.
  async function revertPayment(p: Payment) {
    setRowBusy(p.id)
    const res = await removePayment(supabase, p)
    setRowBusy(null)
    if (res.error) { toast.error(res.error); return }
    onChanged()
    toast.undo(`Payment of ${formatCurrency(Math.abs(Number(p.amount)))} reverted on ${invoice.invoice_number}.`, async () => {
      const r = await restorePayment(supabase, p)
      if (r.error) toast.error('Could not restore the payment: ' + r.error)
      onChanged()
    })
  }
  // Receipt for a HISTORIC row — amount_paid on the invoice prop is already
  // current, so render straight from the row + invoice (no balance projection).
  async function downloadRowReceipt(p: Payment) {
    setRowBusy(p.id)
    try {
      const [{ renderReceiptBlob }, { downloadBlob }] = await Promise.all([
        import('@/components/payments/ReceiptPDF'), import('@/lib/portalPdf'),
      ])
      downloadBlob(await renderReceiptBlob(p, invoice, settings), `${receiptNumberFor(p.id)}.pdf`)
    } catch { toast.error('Could not generate the receipt PDF.') }
    setRowBusy(null)
  }

  const applyable = Math.min(credit, balance)

  async function save() {
    setBusy(true)
    const res = await recordPayment(supabase, { userId: uid, invoice, amount: Number(amount), method, date, notes })
    setBusy(false)
    if (res.error) { toast.error('Could not record payment: ' + res.error); return }
    toast.success(`Recorded ${formatCurrency(Number(amount))} on ${invoice.invoice_number}.`)
    setOpen(false); setNotes('')
    if (res.payment) setLastPayment(res.payment)
    onChanged()
  }

  // ── Receipt actions — generated from the ledger row, never stored ──────────────
  // Balance AFTER this payment (component may render before the refetch lands).
  function balanceAfter(p: Payment): number {
    const paidNow = Math.max(paid, 0) >= Number(p.amount) ? paid : paid + Number(p.amount)
    return Math.max(0, Math.round((total - paidNow) * 100) / 100)
  }
  async function downloadReceipt(p: Payment) {
    setSendingReceipt('pdf')
    try {
      const [{ renderReceiptBlob }, { downloadBlob }] = await Promise.all([
        import('@/components/payments/ReceiptPDF'), import('@/lib/portalPdf'),
      ])
      const inv = { ...invoice, amount_paid: total - balanceAfter(p) }
      downloadBlob(await renderReceiptBlob(p, inv, settings), `${receiptNumberFor(p.id)}.pdf`)
    } catch { toast.error('Could not generate the receipt PDF.') }
    setSendingReceipt(null)
  }
  async function sendReceipt(p: Payment, channel: 'email' | 'sms') {
    if (!invoice.customer_id) { toast.error('No customer on this invoice.'); return }
    setSendingReceipt(channel)
    try {
      const remaining = balanceAfter(p)
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: invoice.customer_id,
          template: 'receipt',
          channels: [channel],
          bodyOverride: receiptMessageBody({
            invoiceNumber: invoice.invoice_number,
            receiptNumber: receiptNumberFor(p.id),
            amountPaid: formatCurrency(Number(p.amount) || 0),
            methodLabel: paymentMethodLabel(p.method || p.provider),
            balanceRemaining: remaining > 0.01 ? formatCurrency(remaining) : null,
          }),
        }),
      })
      const d = await res.json().catch(() => ({})) as { error?: string; results?: Record<string, { sent?: boolean; reason?: string }> }
      // The route returns 200 even when a send is skipped (no opt-in, no contact,
      // comms disabled) — only claim success when something actually went out.
      const delivered = Object.values(d.results || {}).some(r => r?.sent)
      if (res.ok && !d?.error && delivered) {
        toast.success(`Receipt ${channel === 'sms' ? 'texted' : 'emailed'} — logged in the customer's conversation.`)
      } else if (res.ok && !d?.error) {
        const reasons = Object.values(d.results || {}).map(r => r?.reason)
        if (reasons.includes('no-optin')) toast.error('Not sent — the customer hasn’t opted in to this channel. You can change that on their profile.')
        else if (reasons.includes('disabled')) toast.error('Not sent — messaging is off. Add Twilio/Resend keys in Settings to enable it.')
        else toast.error(`Not sent — no ${channel === 'sms' ? 'phone number' : 'email address'} on file for this customer.`)
      } else {
        toast.error(`Could not send the receipt${d?.error ? `: ${d.error}` : ''}.`)
      }
    } catch { toast.error('Could not send the receipt.') }
    setSendingReceipt(null)
  }
  async function run(fn: () => Promise<{ error?: string }>, ok: string) {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success(ok)
    onChanged()
  }
  // "Raise total" — set the invoice's net so the GST-inclusive total equals what was
  // paid (absorbs the overpayment into the price). The trigger then marks it Paid.
  async function raiseTotal() {
    const gst = Number(settings?.gst_percent) || 0
    const newNet = Math.round((paid / (1 + gst / 100)) * 100) / 100
    setBusy(true)
    const { error } = await supabase.from('invoices').update({ amount: newNet }).eq('id', invoice.id)
    setBusy(false)
    if (error) { toast.error('Could not adjust the total: ' + error.message); return }
    toast.success(`Invoice total raised to ${formatCurrency(total + overpaid)}.`)
    onChanged()
  }

  // Nothing to show, nothing to do → render nothing at all. An unpaid invoice
  // with no ledger rows gets the Record-payment action but never an empty
  // receipt area; a cancelled invoice with no history adds zero chrome.
  const canRecord = invoice.status !== 'paid' && invoice.status !== 'cancelled' && balance > 0
  const hasContent = payments.length > 0 || paid > 0 || balance !== total || overpaid > 0 || canRecord || !!lastPayment
  if (!hasContent) return null

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2.5">
      {/* Summary — only once money is involved (drafts/unpaid stay quiet) */}
      {(paid > 0 || balance !== total) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-ink-muted">Paid <span className="font-semibold text-emerald-400">{formatCurrency(paid)}</span></span>
          {overpaid > 0
            ? <span className="text-ink-muted">Overpaid <span className="font-semibold text-violet-400">{formatCurrency(overpaid)}</span></span>
            : <span className="text-ink-muted">Balance <span className={`font-semibold ${balance > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{formatCurrency(balance)}</span></span>}
        </div>
      )}

      {/* ── Payments on this invoice — PERMANENT, straight from the ledger. Every
          row keeps its receipt forever; manual rows can be safely reverted (the
          trigger re-derives the status — the invoice is never unlocked by hand). */}
      {payments.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
          {payments.map(p => {
            const negative = Number(p.amount) < 0
            const revertable = !negative && p.provider !== 'stripe'
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <div className="min-w-0 text-xs">
                  <span className={`font-semibold ${negative ? 'text-red-400' : 'text-emerald-400'}`}>
                    {negative ? '−' : ''}{formatCurrency(Math.abs(Number(p.amount)))}
                  </span>
                  <span className="text-ink-faint"> · {negative ? 'Refund' : paymentMethodLabel(p.method || p.provider)} · {new Date(p.paid_at || p.created_at).toLocaleDateString()}</span>
                  <span className="block font-mono text-[10px] text-ink-faint mt-0.5">{receiptNumberFor(p.id)}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => downloadRowReceipt(p)} disabled={rowBusy === p.id}
                    className="p-1.5 text-ink-faint hover:text-accent transition-colors"
                    aria-label={negative ? 'Download refund receipt' : 'Download receipt'}
                    title={`Download ${negative ? 'refund receipt' : 'receipt'} ${receiptNumberFor(p.id)}`}>
                    <FileDown className="w-3.5 h-3.5" />
                  </button>
                  {invoice.customers?.phone && (
                    <button onClick={() => sendReceipt(p, 'sms')} disabled={rowBusy === p.id || sendingReceipt !== null}
                      className="p-1.5 text-ink-faint hover:text-accent transition-colors"
                      aria-label="Text this receipt to the customer" title={`Text ${negative ? 'refund receipt' : 'receipt'} ${receiptNumberFor(p.id)} to the customer`}>
                      <MessageSquare className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {revertable && (
                    <button onClick={() => revertPayment(p)} disabled={rowBusy === p.id}
                      className="p-1.5 ml-1 pl-1 border-l border-border text-red-400/70 hover:text-red-400 transition-colors"
                      aria-label="Revert payment" title="Revert this payment (undoable) — the invoice recalculates from the ledger">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Overpayment resolver */}
      {overpaid > 0 && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] p-2.5 space-y-2">
          <p className="text-xs text-ink">Overpaid by <span className="font-semibold text-violet-400">{formatCurrency(overpaid)}</span> — what would you like to do?</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => overpaymentToCredit(supabase, { userId: uid, invoice, amount: overpaid }), `${formatCurrency(overpaid)} added to customer credit.`)}>
              <Gift className="w-3.5 h-3.5" /> Apply as credit
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => recordRefund(supabase, { userId: uid, invoice, amount: overpaid, notes: 'Overpayment refund' }), `Refund of ${formatCurrency(overpaid)} recorded.`)}>
              <Banknote className="w-3.5 h-3.5" /> Record refund
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={raiseTotal}>
              <TrendingUp className="w-3.5 h-3.5" /> Raise total
            </Button>
          </div>
          <p className="text-[10px] text-ink-faint">Card refunds are issued in your Stripe dashboard; this records it so your balances stay correct.</p>
        </div>
      )}

      {/* Actions */}
      {canRecord && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setAmount(balance > 0 ? String(balance) : ''); setOpen(o => !o) }}>
            <Plus className="w-3.5 h-3.5" /> Record payment
          </Button>
          {applyable > 0 && (
            <Button size="sm" variant="secondary" loading={busy}
              onClick={() => run(() => applyCreditToInvoice(supabase, { userId: uid, invoice, amount: applyable }), `Applied ${formatCurrency(applyable)} credit to ${invoice.invoice_number}.`)}>
              <Gift className="w-3.5 h-3.5" /> Apply {formatCurrency(applyable)} credit
            </Button>
          )}
        </div>
      )}

      {/* Record-payment form */}
      {open && (
        <form onSubmit={e => { e.preventDefault(); if (Number(amount) > 0 && !busy) save() }}
          className="rounded-lg border border-border bg-bg-secondary p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5 text-accent" /> Record a payment</p>
            <button type="button" onClick={() => setOpen(false)} className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Amount
              <div className="relative mt-1">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint text-sm">$</span>
                <input type="number" min="0" step="0.01" autoFocus value={amount} onChange={e => setAmount(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-lg pl-6 pr-2 py-2 text-base sm:text-sm font-normal text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </div>
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Method
              <select value={method} onChange={e => setMethod(e.target.value)}
                className="w-full mt-1 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm font-normal text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20">
                {PAYMENT_METHODS.filter(m => m.value !== 'credit').map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full mt-1 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm font-normal text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </label>
          </div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-ink-muted">Note
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. cheque #142 — optional"
              className="w-full mt-1 bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm font-normal text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" type="submit" loading={busy} disabled={!(Number(amount) > 0)} title={!(Number(amount) > 0) ? 'Enter an amount greater than $0 to record a payment.' : undefined}>Record {Number(amount) > 0 ? formatCurrency(Number(amount)) : 'payment'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            {balance > 0 && Number(amount) > 0 && Number(amount) < balance && <span className="text-[10px] text-amber-400 ml-auto">Partial — {formatCurrency(balance - Number(amount))} will remain</span>}
          </div>
        </form>
      )}

      {/* Automatic receipt — appears the moment a payment is recorded. Generated
          from the ledger row (never stored), delivered as PDF / email / text
          through the existing PDF + comms engines. */}
      {lastPayment && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-ink flex items-center gap-1.5">
              <ReceiptText className="w-3.5 h-3.5 text-emerald-400" />
              Receipt {receiptNumberFor(lastPayment.id)} · {formatCurrency(Number(lastPayment.amount) || 0)} {paymentMethodLabel(lastPayment.method || lastPayment.provider).toLowerCase()}
            </p>
            <button onClick={() => setLastPayment(null)} className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label="Dismiss"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={sendingReceipt === 'pdf'} onClick={() => downloadReceipt(lastPayment)}>
              <FileDown className="w-3.5 h-3.5" /> Download PDF
            </Button>
            {invoice.customers?.email && (
              <Button size="sm" variant="secondary" loading={sendingReceipt === 'email'} onClick={() => sendReceipt(lastPayment, 'email')}>
                <Mail className="w-3.5 h-3.5" /> Email receipt
              </Button>
            )}
            {invoice.customers?.phone && (
              <Button size="sm" variant="secondary" loading={sendingReceipt === 'sms'} onClick={() => sendReceipt(lastPayment, 'sms')}>
                <MessageSquare className="w-3.5 h-3.5" /> Text receipt
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
