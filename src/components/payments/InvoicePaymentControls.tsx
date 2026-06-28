'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { Invoice, BusinessSettings, PAYMENT_METHODS } from '@/types'
import { Button } from '@/components/ui/Button'
import { invoiceBalance, recordPayment, applyCreditToInvoice, overpaymentToCredit, recordRefund } from '@/lib/payments/ledger'
import { Wallet, Plus, Gift, RotateCcw, TrendingUp, X } from 'lucide-react'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Per-invoice payment controls: the Total / Paid / Balance summary, a one-form
// Record-Payment (multiple payments per invoice), the overpayment resolver
// (credit / refund / raise total), and one-tap apply-credit. All movements go
// through the shared ledger so dashboard, portal and reports update automatically.
export function InvoicePaymentControls({ invoice, settings, uid, credit, onChanged }: {
  invoice: Invoice
  settings: BusinessSettings | null
  uid: string
  credit: number              // the customer's available credit
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

  const applyable = Math.min(credit, balance)

  async function save() {
    setBusy(true)
    const res = await recordPayment(supabase, { userId: uid, invoice, amount: Number(amount), method, date, notes })
    setBusy(false)
    if (res.error) { toast.error('Could not record payment: ' + res.error); return }
    toast.success(`Recorded ${formatCurrency(Number(amount))} on ${invoice.invoice_number}.`)
    setOpen(false); setNotes('')
    onChanged()
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

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-2.5">
      {/* Summary — only once money is involved (drafts/unpaid stay quiet) */}
      {(paid > 0 || balance !== total) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-ink-muted">Total <span className="font-semibold text-ink">{formatCurrency(total)}</span></span>
          <span className="text-ink-muted">Paid <span className="font-semibold text-emerald-400">{formatCurrency(paid)}</span></span>
          {overpaid > 0
            ? <span className="text-ink-muted">Overpaid <span className="font-semibold text-violet-400">{formatCurrency(overpaid)}</span></span>
            : <span className="text-ink-muted">Balance <span className={`font-semibold ${balance > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{formatCurrency(balance)}</span></span>}
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
              <RotateCcw className="w-3.5 h-3.5" /> Record refund
            </Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={raiseTotal}>
              <TrendingUp className="w-3.5 h-3.5" /> Raise total
            </Button>
          </div>
          <p className="text-[10px] text-ink-faint">Card refunds are issued in your Stripe dashboard; this records it so your balances stay correct.</p>
        </div>
      )}

      {/* Actions */}
      {invoice.status !== 'paid' && balance > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setAmount(balance > 0 ? String(balance) : ''); setOpen(o => !o) }}>
            <Plus className="w-3.5 h-3.5" /> Record payment
          </Button>
          {applyable > 0 && (
            <Button size="sm" variant="ghost" className="text-accent" loading={busy}
              onClick={() => run(() => applyCreditToInvoice(supabase, { userId: uid, invoice, amount: applyable }), `Applied ${formatCurrency(applyable)} credit to ${invoice.invoice_number}.`)}>
              <Gift className="w-3.5 h-3.5" /> Apply {formatCurrency(applyable)} credit
            </Button>
          )}
        </div>
      )}

      {/* Record-payment form */}
      {open && (
        <div className="rounded-lg border border-border bg-bg-secondary p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5 text-accent" /> Record a payment</p>
            <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Amount
              <div className="relative mt-0.5">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint text-sm">$</span>
                <input type="number" min="0" step="0.01" autoFocus value={amount} onChange={e => setAmount(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-lg pl-6 pr-2 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent" />
              </div>
            </label>
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Method
              <select value={method} onChange={e => setMethod(e.target.value)}
                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-accent">
                {PAYMENT_METHODS.filter(m => m.value !== 'credit').map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-accent" />
            </label>
          </div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Note (optional)"
            className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent" />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} loading={busy} disabled={!(Number(amount) > 0)}>Record {Number(amount) > 0 ? formatCurrency(Number(amount)) : 'payment'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            {balance > 0 && Number(amount) > 0 && Number(amount) < balance && <span className="text-[10px] text-amber-400 ml-auto">Partial — {formatCurrency(balance - Number(amount))} will remain</span>}
          </div>
        </div>
      )}
    </div>
  )
}
