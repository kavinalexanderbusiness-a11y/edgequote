'use client'

// ── Payments section (Ways to pay + AutoPay + totals + payment history) ─────
// Faithful relocation of PortalClient's PaymentsTab + AutoPayCard. Presentational
// over { view, actions }: every money figure here is the ORIGINAL computation
// over view.data.payments (or view.derived.outstanding) — never a new formula.
// Granted exceptions for this file: fetch to the three /api/portal/* card routes,
// '@/lib/portalPdf', '@/lib/payments/ledger', '@/lib/payments/card', confirmDialog.

import { useEffect, useState } from 'react'
import {
  AlertTriangle, Banknote, Check, CheckCircle2, CreditCard, Copy, Download,
  Landmark, Receipt, ShieldCheck, Trash2, Wallet, Zap,
} from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { confirm as confirmDialog } from '@/lib/confirm'
import { downloadBlob, renderPortalReceiptBlob } from '@/lib/portalPdf'
import { receiptNumberFor } from '@/lib/payments/ledger'
import { cardExpLabel, cardExpiryState } from '@/lib/payments/card'
import { Empty, type TabProps } from './shared'
import type { PortalCard, PortalInvoice, PortalPayment } from '../model'

// ── Payment history ──
function paymentMethodLabel(provider: string): string {
  switch (provider) {
    case 'stripe': return 'Card'
    case 'etransfer': return 'E-transfer'
    case 'cash': return 'Cash'
    default: return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Payment'
  }
}

export function PaymentsSection({ view, actions }: TabProps) {
  const { data, derived } = view
  const payments = data.payments
  const invoices = data.invoices
  const outstanding = derived.outstanding
  const business = data.business
  const customerName = data.customer.name
  // Same fallback chain the receipt PDF always used: primary property, then the
  // customer's own address text.
  const fallbackAddress = data.property?.address || data.customer.address || null
  const { token, paymentsEnabled } = actions

  // Receipt download — re-rendered from the ledger row on demand, so every receipt
  // stays PERMANENTLY available (nothing stored, nothing to lose).
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null)
  const [receiptErr, setReceiptErr] = useState<string | null>(null)
  async function downloadReceipt(p: PortalPayment, inv: PortalInvoice) {
    setReceiptBusy(p.id); setReceiptErr(null)
    try {
      downloadBlob(await renderPortalReceiptBlob(p, inv, customerName, fallbackAddress, business), `${receiptNumberFor(p.id)}.pdf`)
    } catch {
      // "The button stays available to retry" was the old rationale — but from the outside
      // this was: tap, spinner, spinner stops, nothing. No file, no message, no reason to
      // think a second tap would differ. This is the one action someone takes to PROVE
      // they paid; it must never end in silence. DocActions already handles the identical
      // failure this way.
      setReceiptErr(p.id)
    }
    setReceiptBusy(null)
  }
  const invById = new Map(invoices.map(i => [i.id, i]))
  // Receipts (money movements) vs the customer-credit ledger — kept apart so totals
  // and history stay honest.
  const receipts = payments.filter(p => p.kind !== 'credit')
  // Refunds are negative rows in the ledger. Netting them into "Total paid" makes the
  // headline contradict the list directly beneath it — pay $500, get refunded $500, and
  // the tile reads "Total paid $0.00" above a row showing the $500 you paid. Show what
  // was paid, and name the refund separately.
  const totalPaid = receipts.filter(p => Number(p.amount) > 0).reduce((s, p) => s + Number(p.amount), 0)
  const refunded = Math.abs(receipts.filter(p => Number(p.amount) < 0).reduce((s, p) => s + Number(p.amount), 0))
  const availableCredit = Math.round(payments.filter(p => p.kind === 'credit').reduce((s, p) => s + Number(p.amount || 0), 0) * 100) / 100

  // ── Ways to pay ── copy-to-clipboard for the e-transfer details. The recipient
  // is ONLY the business-configured Interac email (Settings → Payments & Fees) —
  // never a generic contact email, which may not be bank-registered for e-transfers.
  const [copied, setCopied] = useState<string | null>(null)
  async function copyText(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 2000) } catch { /* clipboard blocked — button just no-ops */ }
  }
  const etransferEmail = (business?.etransfer_email || '').trim()
  // Which invoice(s) an e-transfer should reference — exact number when there's
  // one owing invoice, generic guidance when several. Balance comes from the
  // prebuilt docItems (the same per-invoice balance the Billing rows show).
  const owingNums = view.docItems.filter(d => d.kind === 'invoice' && d.balance > 0).map(d => d.number)
  return (
    <div className="space-y-3">
      {/* ── Ways to pay — Card / E-transfer / Cash (cheque retired). E-transfer
          details come from Business Settings (one source of truth). ── */}
      <div className="rounded-card border border-border bg-bg-secondary p-4 space-y-3 animate-rise">
        <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold">Ways to pay</p>
        <div className="flex items-start gap-3">
          <span aria-hidden><CreditCard className="w-4 h-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Card</p>
            <p className="text-xs text-ink-muted">{paymentsEnabled ? 'Pay any invoice securely online with the Pay button.' : 'Ask us for a secure card payment link.'}</p>
            {paymentsEnabled && <p className="text-[11px] text-ink-faint mt-1 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" /> Secure checkout by Stripe — your card details never touch us.</p>}
          </div>
        </div>
        {/* Only advertise e-transfer once the business has set its address —
            never show a customer owner-facing setup instructions. */}
        {etransferEmail && (
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <span aria-hidden><Landmark className="w-4 h-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">E-transfer</p>
            <p className="text-xs text-ink-muted">Recipient: <span className="font-medium text-ink">{business?.company_name || 'Your service provider'}</span></p>
            <p className="text-xs text-ink-muted mt-1">Send payment to:</p>
            <p className="text-sm font-semibold text-accent-text break-all">{etransferEmail}</p>
            {owingNums.length === 1 && (
              <p className="text-xs text-ink-muted mt-1">Please include invoice number <span className="font-semibold text-ink">{owingNums[0]}</span> in the e-transfer message.</p>
            )}
            {owingNums.length > 1 && (
              <p className="text-xs text-ink-muted mt-1">Please include your invoice number (e.g. <span className="font-semibold text-ink">{owingNums[0]}</span>) in the e-transfer message.</p>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              <Button size="sm" variant="secondary" onClick={() => copyText('email', etransferEmail)}>
                {copied === 'email' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'email' ? 'Copied' : 'Copy email'}
              </Button>
              {outstanding > 0 && (
                <Button size="sm" variant="secondary" onClick={() => copyText('amount', outstanding.toFixed(2))}>
                  {copied === 'amount' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied === 'amount' ? 'Copied' : `Copy amount (${formatCurrency(outstanding)})`}
                </Button>
              )}
            </div>
            {/* Sending money to a copy-pasted address is the loneliest moment in this
                product. The old line described OUR balance updating; it never told the
                customer they'd hear anything, or what to do if they didn't. Give them the
                evidence trail and a deadline at which it's right to chase us. */}
            <p className="text-[11px] text-ink-faint mt-2">
              E-transfers usually arrive within a few hours. Once we accept it, your payment appears in your history below with a receipt you can download.
              If you don&rsquo;t see it within one business day, give us a call and we&rsquo;ll track it down.
            </p>
          </div>
        </div>
        )}
        <div className="flex items-start gap-3 border-t border-border pt-3">
          <span aria-hidden><Banknote className="w-4 h-4" /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Cash</p>
            {/* "send your receipt" promised an automatic send; for cash/e-transfer the
                receipt is a button the owner may never press. Point at what IS guaranteed:
                the payment history, which is written the moment the payment is recorded. */}
            <p className="text-xs text-ink-muted">Pay your crew in person at your next visit. We&rsquo;ll record it, and your payment and receipt will appear in your history below.</p>
          </div>
        </div>
      </div>
      {paymentsEnabled && <AutoPayCard token={token} card={data.payment_method ?? null} autopayEnabled={!!data.customer.autopay_enabled} onChanged={() => { void actions.refresh() }} />}
      {availableCredit > 0 && (
        <div className="rounded-card border border-accent/25 bg-accent/[0.06] p-3.5 flex items-center justify-between gap-3 animate-rise">
          <p className="text-[10px] uppercase tracking-[0.14em] text-accent-text font-semibold flex items-center gap-1"><Wallet className="w-3 h-3" /> Available credit</p>
          <p className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(availableCredit)}</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 animate-rise">
        <div className="rounded-card border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Total paid</p>
          <p className="text-lg font-bold text-ink mt-1 tabular-nums">{formatCurrency(totalPaid)}</p>
          {refunded > 0 && <p className="text-[11px] text-ink-faint mt-0.5 tabular-nums">{formatCurrency(refunded)} refunded</p>}
        </div>
        <div className="rounded-card border border-border bg-bg-secondary p-3.5">
          {/* Same figure as the Home tile, so it must carry the same name — one number
              with two labels ("Outstanding" here, "Amount due" there) reads as two
              different numbers. "Outstanding" is also collections vocabulary. */}
          <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold flex items-center gap-1"><Receipt className="w-3 h-3" /> Amount due</p>
          <p className={cn('text-lg font-bold mt-1 tabular-nums', outstanding > 0 ? 'text-amber-400' : 'text-emerald-400')}>{formatCurrency(outstanding)}</p>
        </div>
      </div>

      {/* The receipts below were an unheaded list hanging off the totals — name it, so
          it reads as a record you can rely on rather than a loose pile of rows. */}
      {receipts.length > 0 && (
        <p className="text-[10px] uppercase tracking-[0.14em] text-ink-faint font-semibold pt-1">
          Payment history{receipts.length > 1 ? ` · ${receipts.length} payments` : ''}
        </p>
      )}
      {receipts.length === 0 ? (
        <Empty icon={Receipt} text="No payments yet — once you pay an invoice, your receipts will live here." />
      ) : receipts.map(p => {
        const inv = p.invoice_id ? invById.get(p.invoice_id) : null
        return (
          <div key={p.id} className="rounded-card border border-border bg-bg-secondary p-4 flex flex-col sm:flex-row sm:items-center gap-3 animate-rise">
            {/* Details + status — the badge stays with the details on every width. */}
            <div className="flex items-center justify-between gap-3 min-w-0 flex-1">
              <div className="flex items-center gap-3 min-w-0">
                <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', Number(p.amount) < 0 ? 'border-red-500/25 bg-red-500/10' : 'border-emerald-500/25 bg-emerald-500/10')}><CheckCircle2 className={cn('w-4 h-4', Number(p.amount) < 0 ? 'text-red-400' : 'text-emerald-400')} /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink tabular-nums">{Number(p.amount) < 0 ? '−' : ''}{formatCurrency(Math.abs(Number(p.amount)))}</p>
                  <p className="text-xs text-ink-muted truncate">{p.paid_at ? formatDate(p.paid_at) : formatDate(p.created_at)}{inv ? ` · ${inv.invoice_number}` : ''} · {Number(p.amount) < 0 ? 'Refund' : paymentMethodLabel(p.provider)}</p>
                </div>
              </div>
              <span className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', Number(p.amount) < 0 ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>{Number(p.amount) < 0 ? 'Refunded' : 'Paid'}</span>
            </div>
            {/* Receipt download — a quiet utility action (the paid status is the
                story), full-width on mobile, right-aligned on desktop. */}
            {inv && (
              <div className="w-full sm:w-auto shrink-0">
                <Button size="sm" variant="secondary" className="w-full sm:w-auto"
                  onClick={() => downloadReceipt(p, inv)} loading={receiptBusy === p.id}>
                  <Download className="w-4 h-4" /> Download {Number(p.amount) < 0 ? 'refund ' : ''}receipt
                </Button>
                {receiptErr === p.id && <p className="text-xs text-red-400 mt-1 sm:text-right">Couldn&rsquo;t build the receipt — please try again.</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Card on file + AutoPay (customer self-serve) ──
// Relocated verbatim. onChanged = actions.refresh (the original's onChanged=load):
// success paths re-fetch so the card/autopay shown is the SERVER's truth; the
// local `removed` override only bridges the gap until that fetch lands.
function AutoPayCard({ token, card: cardProp, autopayEnabled, onChanged }: {
  token: string; card: PortalCard | null; autopayEnabled: boolean; onChanged: () => void
}) {
  const [autopay, setAutopay] = useState(autopayEnabled)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [removed, setRemoved] = useState(false)
  useEffect(() => { setAutopay(autopayEnabled) }, [autopayEnabled])
  // Fresh data wins: when the payload's card changes, drop the local override.
  useEffect(() => { setRemoved(false) }, [cardProp])
  const card = removed ? null : cardProp

  async function addCard() {
    setBusy('card'); setErr(null)
    try {
      const res = await fetch('/api/portal/setup-card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return }   // hosted Stripe setup
      setErr('Could not start card setup. Please try again.')
    } catch { setErr('Could not start card setup. Please try again.') }
    setBusy(null)
  }
  async function removeCard() {
    const ok = await confirmDialog({ title: 'Remove your saved card?', message: 'AutoPay will be turned off. You can add a card again anytime.', confirmLabel: 'Remove card', destructive: true })
    if (!ok) return
    setBusy('remove'); setErr(null)
    try {
      const res = await fetch('/api/portal/remove-card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      if (res.ok) { setAutopay(false); setRemoved(true); onChanged() } else setErr('Could not remove the card.')
    } finally { setBusy(null) }
  }
  async function toggle() {
    if (!card && !autopay) { setErr('Add a card first to use AutoPay.'); return }
    const next = !autopay
    setAutopay(next); setErr(null)   // optimistic
    const res = await fetch('/api/portal/autopay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, enabled: next }) })
    const d = await res.json().catch(() => ({}))
    if (!d.ok) { setAutopay(!next); setErr('Could not update AutoPay.'); return }
    onChanged()
  }
  const exp = cardExpLabel(card)
  const expState = cardExpiryState(card)
  const brand = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card'

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 animate-rise">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CreditCard className="w-4 h-4 text-accent-text" /> Payment method &amp; AutoPay</p>
      {/* Saving a card is the largest ask in this portal, and it used to be answered with
          one sentence about Stripe — which addresses a fear the customer doesn't have.
          What they actually want to know is WHEN, HOW MUCH, and HOW TO STOP. All three are
          true of the engine today (autopay.ts only charges invoices tied to a recurring
          visit, after completion, for that visit's amount) — the portal just never said so.
          Note this reassurance must render BEFORE the Add-card button, not only after. */}
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Your card is stored securely by Stripe — never by us.</p>
      <ul className="text-xs text-ink-muted mb-3 space-y-1">
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> We charge only the invoice from each recurring visit — after that visit is done, for that visit&rsquo;s amount.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> One-off jobs and extra work are never charged automatically — we&rsquo;ll always ask you first.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> Every charge gets a receipt, and shows up in your payment history here.</li>
        <li className="flex items-start gap-1.5"><Check className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" /> Turn AutoPay off or remove your card any time — it takes effect right away.</li>
      </ul>
      {card ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
          <span className="text-sm text-ink flex items-center gap-2 min-w-0">
            <CreditCard className="w-4 h-4 text-ink-muted shrink-0" />
            <span className="truncate">{brand} •••• {card.last4 || '????'}{exp ? ` · ${exp}` : ''}</span>
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={addCard} disabled={busy !== null} className="text-xs font-medium text-accent-text hover:underline disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Replace</button>
            <button onClick={removeCard} disabled={busy !== null} className="text-xs font-medium text-red-400/70 hover:text-red-400 disabled:opacity-50 flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Trash2 className="w-3.5 h-3.5" /> Remove</button>
          </div>
        </div>
      ) : (
        <Button className="w-full" onClick={addCard} disabled={busy !== null} loading={busy === 'card'}>
          <CreditCard className="w-4 h-4" /> Add a card
        </Button>
      )}
      <div className="flex items-center justify-between gap-3 mt-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
        <span className="text-sm text-ink flex items-center gap-2"><Zap className="w-4 h-4 text-accent-text" /> AutoPay recurring invoices</span>
        <button onClick={toggle} disabled={!card && !autopay} aria-pressed={autopay} aria-label="AutoPay recurring invoices"
          className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', autopay ? 'bg-accent' : 'bg-border-strong', (!card && !autopay) && 'opacity-40 cursor-not-allowed')}>
          <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', autopay && 'translate-x-5')} />
        </button>
      </div>
      {/* The customer is the only person who can actually fix an expiring card, and this
          is the only screen where they see it. Silence here means their next visit
          declines and they find out from a chase message instead. */}
      {card && (expState === 'expired' || expState === 'expiring') && (
        <p className="text-xs text-amber-400 mt-2 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            {expState === 'expired'
              ? <>This card expired{exp ? ` in ${exp}` : ''}, so AutoPay can&rsquo;t charge it. Tap <strong>Replace</strong> to add a current one.</>
              : <>This card expires{exp ? ` in ${exp}` : ' soon'}. Tap <strong>Replace</strong> to keep AutoPay running without a gap.</>}
          </span>
        </p>
      )}
      {card && expState !== 'expired' && <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-emerald-400" /> Secured by Stripe. You can remove your card or turn off AutoPay anytime.</p>}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
    </div>
  )
}
