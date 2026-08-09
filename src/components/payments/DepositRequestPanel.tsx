'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { formatCurrency, cn } from '@/lib/utils'
import type { Invoice, BusinessSettings } from '@/types'
import { Button } from '@/components/ui/Button'
import {
  depositState, validateDeposit, depositFromPercent,
  saveDepositRequest, clearDepositRequest,
} from '@/lib/payments/deposit'
import { HandCoins, Check, Send, Pencil, X, AlertTriangle, Clock } from 'lucide-react'

// ── Request a deposit ────────────────────────────────────────────────────────
// "50% before we start, the rest when it's done."
//
// The owner picks a percentage or a fixed amount and sees the three numbers that
// decide it — total, deposit, what's left — before anything is saved. There is no
// second invoice: the deposit is a PARTIAL PAYMENT of this one, so the money lands
// through the ledger exactly like any other payment and the balance takes care of
// itself (see lib/payments/deposit for why that is the canonical shape).
//
// The panel is a small state machine, because the honest answer to "where is my
// deposit?" has four different shapes:
//   none  → nothing asked for; offer to ask
//   draft → an amount is saved but the customer has not been told
//   sent  → they were told, on a date; waiting on the money
//   paid  → enough has arrived; show what's left and stop offering to change it
//
// Only ONE of them offers "Request deposit", which is what stops a second request
// being created by accident on an invoice that already has one.

const QUICK_PERCENTS = [25, 50] as const

export function DepositRequestPanel({ invoice, settings, onChanged, onSendRequest }: {
  invoice: Invoice
  settings: BusinessSettings | null
  onChanged: () => void
  /**
   * Hand the request to the page's Send-Message dialog — the SAME one the invoice
   * send uses. It is the page's job to stamp "sent" only when a delivery actually
   * succeeds, so this component never claims it did.
   */
  onSendRequest?: (invoice: Invoice, amount: number) => void
}) {
  const supabase = useState(() => createClient())[0]
  const d = depositState(invoice, settings)

  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'percent' | 'amount'>('percent')
  const [value, setValue] = useState<string>('50')
  const [busy, setBusy] = useState(false)

  // What the owner is about to ask for, recomputed from the LIVE invoice total on
  // every keystroke — the percentage is never stored, so it can't drift from a
  // total that changed after the fact.
  const typed = Number(value)
  const preview = !Number.isFinite(typed) || typed <= 0
    ? null
    : kind === 'percent' ? depositFromPercent(d.total, typed) : Math.round(typed * 100) / 100
  const previewValid = preview != null && preview > 0 && preview <= d.total + 0.005
  const previewPercent = preview != null && d.total > 0
    ? Math.round((preview / d.total) * 1000) / 10
    : null

  function openForm(mode: 'new' | 'edit') {
    // Editing starts from what was actually asked for, expressed as the money it
    // is — re-deriving a percentage here would re-round it and change the figure.
    if (mode === 'edit' && d.requested != null) { setKind('amount'); setValue(String(d.requested)) }
    else { setKind('percent'); setValue('50') }
    setOpen(true)
  }

  async function save() {
    const v = validateDeposit({ kind, value: Number(value) }, d.total, d.paid)
    if (!v.ok) { toast.error(v.error); return }
    setBusy(true)
    const res = await saveDepositRequest(supabase, { invoiceId: invoice.id, amount: v.amount })
    setBusy(false)
    // A failed write must not look like a saved request — nothing changes and the
    // form stays open with the numbers still in it.
    if (res.error) { toast.error('Could not save the deposit request: ' + res.error); return }
    setOpen(false)
    toast.success(`Deposit of ${formatCurrency(v.amount)} requested on ${invoice.invoice_number}.`)
    onChanged()
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Remove this deposit request?',
      message: `${invoice.invoice_number} will go back to being payable in full. No money is moved — any deposit already paid stays on the invoice.`,
      confirmLabel: 'Remove request',
      icon: X,
    })
    if (!ok) return
    setBusy(true)
    const res = await clearDepositRequest(supabase, invoice.id)
    setBusy(false)
    if (res.error) { toast.error('Could not remove the deposit request: ' + res.error); return }
    toast.success('Deposit request removed.')
    onChanged()
  }

  // Nothing to ask for on a settled or worthless invoice — and asking on a
  // cancelled one would be asking for money the invoice itself says isn't owed.
  // (With no request, remainingAfter IS the open balance: total − paid.)
  const askable = d.total > 0 && d.remainingAfter > 0.005 && invoice.status !== 'cancelled'
  if (!askable && d.status === 'none') return null

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/50 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          <HandCoins className="w-3.5 h-3.5 text-accent-text" aria-hidden /> Deposit
        </span>
        {d.status === 'none' && !open && askable && (
          <Button size="sm" variant="secondary" onClick={() => openForm('new')}>
            Request deposit
          </Button>
        )}
      </div>

      {/* ── The saved request ─────────────────────────────────────────────── */}
      {d.status !== 'none' && !open && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold text-ink tabular-nums">
              {formatCurrency(d.requested ?? 0)}
              {d.percent != null && <span className="ml-1.5 text-xs font-medium text-ink-muted">({d.percent}% of {formatCurrency(d.total)})</span>}
            </span>
            <StatusChip status={d.status} at={invoice.deposit_requested_at ?? null} />
          </div>

          {/* The two facts the owner actually acts on. When it's paid the top line
              is history, so lead with what is still coming. */}
          <p className="text-xs text-ink-muted">
            {d.status === 'paid'
              ? <>Deposit received · <span className="font-semibold text-ink tabular-nums">{formatCurrency(d.remainingAfter)}</span> left to bill</>
              : <>Still to collect <span className="font-semibold text-ink tabular-nums">{formatCurrency(d.outstanding)}</span> · <span className="tabular-nums">{formatCurrency(d.remainingAfter)}</span> due after</>}
          </p>

          {/* The invoice was edited DOWN after the ask. Say so — silently clamping
              would leave the owner thinking the customer was asked for today's
              number when they were told a bigger one. */}
          {d.exceedsTotal && (
            <p className="flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              This deposit is more than the invoice now totals ({formatCurrency(d.total)}). Only the balance can be collected — edit the request to match.
            </p>
          )}

          {d.status !== 'paid' && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {onSendRequest && invoice.customer_id && (
                <Button size="sm" disabled={busy}
                  onClick={() => onSendRequest(invoice, d.outstanding)}>
                  <Send className="w-3.5 h-3.5" /> {d.status === 'sent' ? 'Send again' : 'Send request'}
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => openForm('edit')}>
                <Pencil className="w-3.5 h-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>Remove</Button>
            </div>
          )}
        </div>
      )}

      {/* ── The ask ───────────────────────────────────────────────────────── */}
      {open && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {QUICK_PERCENTS.map(p => (
              <button key={p} type="button"
                onClick={() => { setKind('percent'); setValue(String(p)) }}
                className={cn('tap-target-y text-xs font-semibold rounded-full px-3 py-1 border transition-colors',
                  kind === 'percent' && Number(value) === p
                    ? 'bg-accent text-black border-accent'
                    : 'border-border text-ink-muted hover:text-ink')}>
                {p}%
              </button>
            ))}
            <button type="button" onClick={() => setKind('percent')}
              className={cn('tap-target-y text-xs font-semibold rounded-full px-3 py-1 border transition-colors',
                kind === 'percent' && !QUICK_PERCENTS.includes(Number(value) as 25 | 50)
                  ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
              Other %
            </button>
            <button type="button" onClick={() => setKind('amount')}
              className={cn('tap-target-y text-xs font-semibold rounded-full px-3 py-1 border transition-colors',
                kind === 'amount' ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
              $ Amount
            </button>
          </div>

          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">
              {kind === 'percent' ? 'Percentage of the invoice' : 'Deposit amount'}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              {kind === 'amount' && <span className="text-sm text-ink-muted">$</span>}
              <input type="number" min="0" step={kind === 'percent' ? '5' : '10'} autoFocus
                value={value} onChange={e => setValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && previewValid && !busy) save() }}
                className="w-28 bg-bg-secondary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              {kind === 'percent' && <span className="text-sm text-ink-muted">%</span>}
            </div>
          </label>

          {/* THE decision, in the owner's words. Three lines, always in this order —
              what the job is, what we're asking for now, what is left after. */}
          <dl className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs space-y-1">
            <Row label="Invoice total" value={formatCurrency(d.total)} />
            <Row
              label={`Deposit requested${previewPercent != null && kind === 'amount' ? ` (${previewPercent}%)` : ''}`}
              value={preview != null ? formatCurrency(preview) : '—'}
              strong
            />
            <Row
              label="Remaining after"
              value={preview != null && previewValid ? formatCurrency(Math.round((d.total - preview) * 100) / 100) : '—'}
            />
          </dl>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} loading={busy} disabled={busy || !previewValid}>
              {d.status === 'none' ? 'Save request' : 'Update request'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
          {d.status !== 'none' && (
            <p className="text-[11px] text-ink-faint">
              Changing the amount clears the “sent” mark — the customer was told a different figure, so it needs sending again.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn('tabular-nums', strong ? 'text-ink font-bold text-sm' : 'text-ink')}>{value}</dd>
    </div>
  )
}

// Four states, four different words. "Requested" and "Sent" are deliberately not
// the same chip: the owner needs to know whether the customer has actually been
// asked, because a deposit that was never sent will never arrive.
function StatusChip({ status, at }: { status: 'none' | 'draft' | 'sent' | 'paid'; at: string | null }) {
  if (status === 'paid') {
    return (
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border text-emerald-400 border-emerald-500/30 bg-emerald-500/10 flex items-center gap-1">
        <Check className="w-3 h-3" aria-hidden /> Paid
      </span>
    )
  }
  if (status === 'sent') {
    const day = at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
    return (
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border text-sky-300 border-sky-400/30 bg-sky-400/10 flex items-center gap-1">
        <Clock className="w-3 h-3" aria-hidden /> Sent{day ? ` ${day}` : ''}
      </span>
    )
  }
  return (
    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border text-amber-400 border-amber-500/30 bg-amber-500/10">
      Not sent
    </span>
  )
}
