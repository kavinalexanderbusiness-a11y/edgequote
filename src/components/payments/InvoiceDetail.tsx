'use client'

import { ReactNode, useState } from 'react'
import { Invoice, InvoiceStatus, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, BusinessSettings, Payment, paymentMethodLabel } from '@/types'
import { InvoicePaymentControls } from '@/components/payments/InvoicePaymentControls'
import { DepositRequestPanel } from '@/components/payments/DepositRequestPanel'
import { displayInvoiceStatus } from '@/lib/payments/ledger'
import { isAutoPayHeld } from '@/lib/payments/autopay'
import {
  financiallyLocked, invoiceDoors, invoiceHeadline, invoiceMoney, invoiceNextActions,
  type HeadlineKind, type InvoiceAction, type InvoiceActionKind,
} from '@/lib/payments/invoiceActions'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Menu, type MenuItem } from '@/components/ui/Menu'
import { Collapsible } from '@/components/ui/Collapsible'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import {
  FileText, User, Check, FileDown, Trash2, CreditCard, Zap, AlertTriangle, Pencil,
  MessageSquare, MoreHorizontal, ChevronDown, HandCoins, Wallet, ReceiptText, ListTree,
} from 'lucide-react'

// ── The invoice DETAIL ───────────────────────────────────────────────────────
//
// `?invoice=` focus IS this surface — there is no route and no second data path
// (see the invoices page). This component is PRESENTATION ONLY: every figure is a
// read-through of the canonical engines via lib/payments/invoiceActions, and
// every write is a callback the page owns. So the list and the detail cannot
// disagree about money, and there is still exactly one place that mutates an
// invoice.
//
// WHAT THIS REPLACED (measured in real Chrome at 390px, per state)
// The detail rendered its whole capability set at one weight: the status menu,
// a Stripe-link button, charge-saved-card, Send, an overflow menu, the deposit
// panel and the payment controls — 6 to 11 visible buttons (14 worst case),
// 411–787px tall, with ZERO accent-weighted button on draft/paid/overpaid/
// cancelled and TWO on any invoice carrying a deposit. Nothing was disclosed.
// The single largest figure on the screen was the invoice TOTAL in all twelve
// states, including the ones where the owner is chasing a balance.
//
// THE SHAPE NOW, top to bottom, and why in that order:
//   1. WHO      — number, date, customer, state pill
//   2. HOW MUCH — one headline figure that is true NOW + its supporting facts
//   3. WHAT NEXT— one primary action, at most one secondary, then a menu
//   4. the surface that action opens (inline, never a jump)
//   5. what's ON the invoice        (disclosed)
//   6. what has HAPPENED to it     (disclosed)
// Everything that used to compete for the top of the card is still here; it is
// ranked instead of listed.

export interface InvoiceDetailProps {
  inv: Invoice
  settings: BusinessSettings | null
  today: string
  uid: string | null
  index: number
  /** This invoice's ledger rows — permanent receipts + revert. */
  payments: Payment[]
  /** The customer's available credit. */
  credit: number
  paymentsEnabled: boolean
  hasSavedCard: boolean
  /** `?pay=1` — open the record-payment form on mount. */
  payIntent: boolean
  paying: boolean
  charging: boolean
  opening: boolean
  deleting: boolean
  editorOpen: boolean
  /** The page's DraftInvoiceEditor, rendered when open. */
  editor: ReactNode
  onToggleEditor: () => void
  onDownloadPdf: () => void
  /** Download the receipt for the most recent payment on this invoice. */
  onDownloadReceipt: () => void
  onCardLink: () => void
  onChargeCard: () => void
  onSend: () => void
  onSendDepositRequest: (invoice: Invoice, amount: number) => void
  onDelete: () => void
  onSetStatus: (status: InvoiceStatus, msg: string) => void
  onApproveDraft: () => void
  onCancelInvoice: () => void
  onChanged: () => void
  onIssueDraft: () => Promise<void>
}

/** The headline's colour is the state, so the figure reads before the words do. */
const HEADLINE_TONE: Record<HeadlineKind, string> = {
  balance: 'text-amber-400',
  'deposit-due': 'text-amber-400',
  overdue: 'text-red-400',
  paid: 'text-emerald-400',
  overpaid: 'text-violet-400',
  'draft-total': 'text-ink',
  unpriced: 'text-ink-faint',
  cancelled: 'text-ink-faint',
}

const ACTION_ICON: Partial<Record<InvoiceActionKind, typeof Wallet>> = {
  record: Wallet,
  'card-link': CreditCard,
  send: MessageSquare,
  remind: MessageSquare,
  'send-deposit': HandCoins,
  receipt: ReceiptText,
  price: Pencil,
}

export function InvoiceDetail({
  inv, settings, today, uid, index, payments, credit, paymentsEnabled, hasSavedCard,
  payIntent, paying, charging, opening, deleting, editorOpen, editor,
  onToggleEditor, onDownloadPdf, onDownloadReceipt, onCardLink, onChargeCard, onSend,
  onSendDepositRequest, onDelete, onSetStatus, onApproveDraft, onCancelInvoice, onChanged, onIssueDraft,
}: InvoiceDetailProps) {
  // The two surfaces an action opens. Held here so the primary button and the
  // form it opens are adjacent — a button that scrolls something into view three
  // panels below reads as doing nothing on a phone.
  const [recordOpen, setRecordOpen] = useState(payIntent)
  const [depositForm, setDepositForm] = useState<'new' | 'edit' | null>(null)

  const ctx = { paymentsEnabled, hasSavedCard, hasPayments: payments.length > 0 }
  const m = invoiceMoney(inv, settings, today)
  const doors = invoiceDoors(inv, settings, ctx)
  const head = invoiceHeadline(inv, settings, today)
  const { primary, secondary } = invoiceNextActions(inv, settings, today, ctx)
  const ds = displayInvoiceStatus(inv, settings, today)
  const t = invoiceTotals(inv.amount, settings, { type: inv.discount_type, value: inv.discount_value })
  const d = m.deposit
  const depositLive = d.status !== 'none' && d.status !== 'paid'

  // ── What each action kind DOES ────────────────────────────────────────────
  // One map, so an action has the same behaviour whether it is reached as the
  // primary button, the secondary button or a menu item.
  const run: Record<InvoiceActionKind, () => void> = {
    price: onToggleEditor,
    send: onSend,
    remind: onSend,
    'send-deposit': () => onSendDepositRequest(inv, d.outstanding),
    // Toggle, not open: with the form already up (a `?pay=1` landing, or a second
    // tap) an open-only handler is a button that visibly does nothing.
    record: () => setRecordOpen(o => !o),
    'card-link': onCardLink,
    receipt: onDownloadReceipt,
    'resolve-overpayment': () => {},
    none: () => {},
  }
  const loadingFor = (k: InvoiceActionKind) =>
    k === 'card-link' ? paying : k === 'receipt' ? opening : false

  const actionButton = (a: InvoiceAction, kind: 'primary' | 'secondary') => {
    const Icon = ACTION_ICON[a.kind]
    return (
      <Button
        onClick={run[a.kind]}
        variant={kind === 'primary' ? 'primary' : 'secondary'}
        loading={loadingFor(a.kind)}
        className={kind === 'primary' ? 'w-full sm:w-auto' : undefined}
        title={a.kind === 'record' ? 'Write down cash, cheque or e-transfer money already in hand'
          : a.kind === 'card-link' ? `Create a Stripe payment link for ${formatCurrency(m.due.amount)}`
            : undefined}
      >
        {Icon && <Icon className="w-4 h-4" />} {a.label}
      </Button>
    )
  }

  // ── Everything else, named ────────────────────────────────────────────────
  // Rare and secondary actions live in one menu instead of a row of buttons. The
  // gates are `doors.*` — the shared rules — so "can this invoice be collected
  // on?" is answered in one place rather than once per button.
  const shown = new Set<InvoiceActionKind>([primary.kind, secondary?.kind].filter(Boolean) as InvoiceActionKind[])
  const menuItems: MenuItem[] = [
    // Send / share — one coherent group, in the order an owner reaches for them.
    ...(doors.canSend && !shown.has('send') && !shown.has('remind') ? [{
      key: 'send', label: inv.status === 'draft' || inv.status === 'unpaid' ? 'Send invoice' : 'Send again',
      description: 'Email or text it to the customer', icon: MessageSquare, onSelect: onSend,
    }] : []),
    ...(depositLive && doors.canSend && !shown.has('send-deposit') ? [{
      key: 'send-deposit', label: d.status === 'sent' ? 'Send deposit request again' : 'Send deposit request',
      description: `Ask for the ${formatCurrency(d.outstanding)} still owed up front`,
      icon: HandCoins, onSelect: () => onSendDepositRequest(inv, d.outstanding),
    }] : []),
    { key: 'pdf', label: 'Download PDF', icon: FileDown, onSelect: onDownloadPdf },
    ...(doors.canCardLink && !shown.has('card-link') ? [{
      key: 'card-link', label: m.due.isDeposit ? 'Card link — deposit' : 'Card payment link',
      description: `A Stripe link for ${formatCurrency(m.due.amount)}`, icon: CreditCard, onSelect: onCardLink,
    }] : []),
    // ⚠️ The BALANCE, never the deposit: this shares the AutoPay engine, which
    // deliberately charges the full balance (one charge per invoice, ever).
    ...(doors.canChargeSavedCard ? [{
      key: 'charge', label: 'Charge saved card',
      description: `Take the full ${formatCurrency(m.balance)} off the card on file now`, icon: Zap, onSelect: onChargeCard,
    }] : []),
    // Money in.
    ...(doors.canRecord && !shown.has('record') ? [{
      key: 'record', label: 'Record payment',
      description: 'Cash, cheque or e-transfer already in hand', icon: Wallet, onSelect: () => setRecordOpen(true),
    }] : []),
    ...(ctx.hasPayments && !shown.has('receipt') ? [{
      key: 'receipt', label: 'Download receipt', icon: ReceiptText, onSelect: onDownloadReceipt,
    }] : []),
    // The deposit ask — one door, whichever state it is in.
    ...(doors.canAskDeposit ? [{
      key: 'ask-deposit', label: 'Request a deposit',
      description: 'Collect part of this invoice up front', icon: HandCoins,
      onSelect: () => setDepositForm('new'),
    }] : []),
    ...(depositLive ? [{
      key: 'edit-deposit', label: 'Edit deposit request',
      description: `Currently ${formatCurrency(d.requested ?? 0)} — or remove it`, icon: HandCoins,
      onSelect: () => setDepositForm('edit'),
    }] : []),
    // The document.
    ...(doors.canEdit && !shown.has('price') ? [{
      key: 'edit',
      label: financiallyLocked(inv, settings) ? 'Edit notes' : inv.status === 'draft' ? 'Edit draft' : 'Edit invoice',
      icon: Pencil, onSelect: onToggleEditor,
    }] : []),
    ...(inv.status === 'draft' ? [{
      key: 'delete', label: 'Delete draft', danger: true, icon: Trash2, onSelect: onDelete,
    }] : []),
  ]

  // The status pill is THE lifecycle control — Draft/Unpaid → Sent → back, plus
  // Cancel/Reactivate. Money states stay locked: partial/paid/overpaid belong to
  // the payments ledger, never to a menu.
  const statusClickable = inv.status === 'draft' || inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'cancelled'
  const statusItems: MenuItem[] = [
    ...(inv.status === 'draft' ? [{ key: 'approve', label: 'Approve draft', onSelect: onApproveDraft }] : []),
    ...(inv.status === 'draft' || inv.status === 'unpaid' ? [
      { key: 'mark-sent', label: 'Mark sent', onSelect: () => onSetStatus('sent', `${inv.invoice_number} marked sent.`) },
    ] : []),
    ...(inv.status === 'sent' ? [
      { key: 'mark-not-sent', label: 'Mark not sent', onSelect: () => onSetStatus('unpaid', `${inv.invoice_number} back to unpaid.`) },
    ] : []),
    ...(inv.status !== 'cancelled' && (Number(inv.amount_paid) || 0) <= 0.01 ? [
      { key: 'cancel', label: 'Cancel invoice', danger: true, onSelect: onCancelInvoice },
    ] : []),
    ...(inv.status === 'cancelled' ? [
      { key: 'reactivate', label: 'Reactivate', onSelect: () => onSetStatus('unpaid', `${inv.invoice_number} reactivated.`) },
    ] : []),
  ]

  const items = inv.line_items || []
  const addonN = items.filter(li => li.kind === 'addon').length

  return (
    <Card className={`card-lift animate-rise stagger-${Math.min(index + 1, 6)}`}>
      <CardBody className="space-y-4">
        {/* ── 1. Who is this for ───────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
              <FileText className="w-4 h-4 text-accent-text" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{inv.invoice_number}</p>
              <p className="text-xs text-ink-muted flex items-center gap-1 mt-0.5 min-w-0">
                <User className="w-3 h-3 shrink-0" aria-hidden />
                <span className="truncate">{inv.customer_name || 'No customer'}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* AutoPay held this invoice for review (amount differs from usual). */}
            {inv.status === 'draft' && isAutoPayHeld(inv) && (
              <span title={inv.internal_notes || undefined} className="text-[10px] px-2 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 font-semibold flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Review
              </span>
            )}
            <Menu align="end" width={190} ariaLabel="Invoice status" items={statusItems}>
              {({ toggle, triggerProps }) => (
                <button
                  type="button"
                  onClick={() => statusClickable && toggle()}
                  disabled={!statusClickable}
                  title={statusClickable ? 'Change status' : 'Status is set by payments'}
                  className={cn('text-[10px] px-2.5 rounded-full border uppercase tracking-wide font-semibold flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    statusClickable ? 'py-2 min-h-[36px] transition-opacity hover:opacity-80' : 'py-1 min-h-[24px] cursor-default',
                    INVOICE_STATUS_COLORS[ds])}
                  {...(statusClickable ? triggerProps : {})}
                >
                  {ds === 'paid' && <Check className="w-3 h-3" />}
                  {INVOICE_STATUS_LABELS[ds]}
                  {statusClickable && <ChevronDown aria-hidden className="w-3 h-3 opacity-60" />}
                </button>
              )}
            </Menu>
          </div>
        </div>

        {/* ── 2. How much ──────────────────────────────────────────────────────
            ONE figure, and it is the one that is true now: the balance, the
            deposit still owed, the overpayment, or the settled total. The
            supporting facts sit under it in small type and never repeat it.
            Every number here is an engine output — see invoiceHeadline. */}
        <div>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-ink-faint">{head.label}</p>
          <p className={cn('text-3xl font-black tracking-tight tabular-nums leading-none mt-1', HEADLINE_TONE[head.kind])}>
            {formatCurrency(head.amount)}
          </p>
          {head.facts.length > 0 && (
            <p className="mt-1.5 text-[11px] text-ink-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {head.facts.map((f, i) => (
                <span key={f.label} className="flex items-center gap-1">
                  {i > 0 && <span className="text-ink-faint mr-1" aria-hidden>·</span>}
                  {f.label} <span className="font-semibold text-ink tabular-nums">{formatCurrency(f.amount)}</span>
                </span>
              ))}
            </p>
          )}
          {/* The document's own facts — dates, tax, how it was settled. Small,
              because they never change what the owner does next. */}
          <p className="mt-1 text-[11px] text-ink-faint flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {inv.issued_date || inv.created_at ? <span>Issued {formatDate(inv.issued_date || inv.created_at)}</span> : null}
            {inv.due_date && doors.owes && (
              <span className={cn('flex items-center gap-1', head.kind === 'overdue' && 'text-red-400 font-semibold')}>
                <span aria-hidden>·</span> {head.kind === 'overdue' ? 'Was due' : 'Due'} {formatDate(inv.due_date)}
              </span>
            )}
            {head.kind === 'paid' && inv.paid_at && (
              <span><span aria-hidden>·</span> Paid {formatDate(inv.paid_at)}{inv.payment_method ? ` by ${paymentMethodLabel(inv.payment_method).toLowerCase()}` : ''}</span>
            )}
            {d.status === 'paid' && <span><span aria-hidden>·</span> Deposit received</span>}
            {depositLive && (
              <span><span aria-hidden>·</span> Deposit {d.status === 'sent'
                ? `requested ${inv.deposit_requested_at ? formatDate(inv.deposit_requested_at) : ''}`.trim()
                : 'not sent yet'}</span>
            )}
            {t.hasDiscount && <span><span aria-hidden>·</span> {t.discountLabel ? `${t.discountLabel} off` : 'Discount'} −{formatCurrency(t.discountAmount)}</span>}
            {t.hasGst && <span><span aria-hidden>·</span> incl. {formatCurrency(t.gstAmount)} GST</span>}
          </p>
          {/* The invoice was edited DOWN after the ask. Say so — silently clamping
              would leave the owner thinking the customer was asked for today's
              number when they were told a bigger one. */}
          {d.exceedsTotal && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              The {formatCurrency(d.requested ?? 0)} deposit is more than this invoice now totals ({formatCurrency(d.total)}).
              Only the balance can be collected — edit the request to match.
            </p>
          )}
        </div>

        {/* ── 3. What next ─────────────────────────────────────────────────────
            One primary, at most one secondary, then everything else by name.
            A cancelled invoice gets no money action at all: it keeps its full
            balance, so every "is there something to collect?" test passes on it
            — which is exactly how two live collection doors ended up on
            withdrawn production invoices. See invoiceActions.owes. */}
        <div className="flex flex-wrap items-center gap-2">
          {primary.kind !== 'none' && primary.kind !== 'resolve-overpayment' && actionButton(primary, 'primary')}
          {secondary && actionButton(secondary, 'secondary')}
          <Menu align="end" width={264} ariaLabel="More actions" items={menuItems}>
            {({ toggle, triggerProps }) => (
              <Button size="sm" variant="ghost" onClick={toggle} loading={deleting}
                className="ml-auto" aria-label="More actions" title="More actions" {...triggerProps}>
                <MoreHorizontal className="w-4 h-4" /> More
              </Button>
            )}
          </Menu>
        </div>

        {/* ── 4. The surface the action opened ─────────────────────────────── */}
        {editorOpen && editor}
        {/* Keyed on the mode so opening the form always starts from the right
            numbers — 'new' from 50%, 'edit' from what was actually asked for. */}
        {depositForm && (
          <DepositRequestPanel
            key={depositForm}
            invoice={inv}
            settings={settings}
            mode={depositForm}
            onClose={() => setDepositForm(null)}
            onChanged={() => { setDepositForm(null); onChanged() }}
          />
        )}
        {uid && (
          <InvoicePaymentControls
            invoice={inv}
            settings={settings}
            uid={uid}
            credit={credit}
            payments={payments}
            onChanged={onChanged}
            onIssueDraft={onIssueDraft}
            open={recordOpen}
            onOpenChange={setRecordOpen}
          />
        )}

        {/* ── 5. What is ON this invoice ────────────────────────────────────
            The breakdown used to sit in the header at 12px, above the money and
            above every action, on every invoice. It is reference, not work. */}
        {(items.length > 0 || inv.service_type || inv.notes) && (
          <Collapsible
            title="What's on this invoice"
            icon={ListTree}
            summary={items.length > 1
              ? `${items.length} lines${addonN > 0 ? ` · +${addonN} service${addonN !== 1 ? 's' : ''}` : ''}`
              : inv.service_type || undefined}
          >
            {items.length > 0 ? (
              <div className="space-y-1">
                {items.map((li, i) => (
                  <p key={i} className="text-xs flex items-baseline justify-between gap-3">
                    <span className="text-ink-muted min-w-0">{li.description}</span>
                    <span className="text-ink font-medium shrink-0 tabular-nums">{formatCurrency(Number(li.amount))}</span>
                  </p>
                ))}
              </div>
            ) : inv.service_type ? (
              <p className="text-xs text-ink-muted">{inv.service_type}</p>
            ) : null}
            {/* The same totals the PDF, the portal and the charge routes read. */}
            <div className="pt-2 border-t border-border space-y-1 text-xs">
              <Row label="Subtotal" value={formatCurrency(t.subtotal)} />
              {t.hasDiscount && <Row label={`Discount${t.discountLabel ? ` (${t.discountLabel})` : ''}`} value={`−${formatCurrency(t.discountAmount)}`} tone="text-emerald-400" />}
              {t.hasGst && <Row label={`GST (${t.gstPercent}%)`} value={formatCurrency(t.gstAmount)} muted />}
              <div className="flex justify-between pt-1 border-t border-border">
                <span className="font-semibold text-ink">Invoice total</span>
                <span className="font-bold text-ink tabular-nums">{formatCurrency(t.total)}</span>
              </div>
            </div>
            {inv.notes && (
              <p className="text-xs text-ink-muted border-t border-border pt-2">
                <span className="text-ink-faint">Note to the customer: </span>{inv.notes}
              </p>
            )}
          </Collapsible>
        )}
      </CardBody>
    </Card>
  )
}

function Row({ label, value, tone, muted }: { label: string; value: string; tone?: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-ink-faint' : 'text-ink-muted'}>{label}</span>
      <span className={cn('font-medium tabular-nums', tone || (muted ? 'text-ink-muted' : 'text-ink'))}>{value}</span>
    </div>
  )
}
