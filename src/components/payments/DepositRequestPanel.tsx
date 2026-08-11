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
import { HandCoins, X } from 'lucide-react'

// ── Request a deposit — the FORM ─────────────────────────────────────────────
// "50% before we start, the rest when it's done."
//
// The owner picks a percentage or a fixed amount and sees the three numbers that
// decide it — total, deposit, what's left — before anything is saved. There is no
// second invoice: the deposit is a PARTIAL PAYMENT of this one, so the money lands
// through the ledger exactly like any other payment and the balance takes care of
// itself (see lib/payments/deposit for why that is the canonical shape).
//
// ⚠️ THIS PANEL USED TO BE THE WHOLE DEPOSIT SURFACE, and it rendered on every
// invoice with a balance — a bordered "DEPOSIT / Request deposit" box above the
// payment controls, on every unpaid invoice in a business that has never taken a
// deposit in its life. Where a request DID exist it then showed the four figures
// a second time (the detail's headline shows them now) plus Send / Edit / Remove
// at the same weight as the invoice's own actions: measured at 390px, a
// deposit-bearing invoice carried NINE buttons and TWO accent-primary ones.
//
// So the state display moved to the invoice headline (one place says what is
// requested, collected and still due) and the send action moved to the detail's
// action ladder (one place decides what to do next). What is left here is the one
// thing only this component can do: capture and store the ask. It renders ONLY
// when the owner has explicitly opened it.
//
// The four-state machine still lives in `depositState`; nothing about how a
// deposit is stored, validated or collected has changed.

const QUICK_PERCENTS = [25, 50] as const

export function DepositRequestPanel({ invoice, settings, mode, onClose, onChanged }: {
  invoice: Invoice
  settings: BusinessSettings | null
  /** 'new' starts from 50%; 'edit' starts from what was actually asked for. */
  mode: 'new' | 'edit'
  onClose: () => void
  onChanged: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const d = depositState(invoice, settings)

  // Editing starts from what was actually asked for, expressed as the money it
  // is — re-deriving a percentage here would re-round it and change the figure.
  const editing = mode === 'edit' && d.requested != null
  const [kind, setKind] = useState<'percent' | 'amount'>(editing ? 'amount' : 'percent')
  const [value, setValue] = useState<string>(editing ? String(d.requested) : '50')
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

  async function save() {
    const v = validateDeposit({ kind, value: Number(value) }, d.total, d.paid)
    if (!v.ok) { toast.error(v.error); return }
    setBusy(true)
    const res = await saveDepositRequest(supabase, { invoiceId: invoice.id, amount: v.amount })
    setBusy(false)
    // A failed write must not look like a saved request — nothing changes and the
    // form stays open with the numbers still in it.
    if (res.error) { toast.error('Could not save the deposit request: ' + res.error); return }
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

  // Asking on a cancelled invoice would be asking for money the invoice itself
  // says isn't owed. The detail's action rules already refuse to open this form
  // on one; this is the door's own guard, because a guard on the caller is a
  // guard on today's caller only.
  if (invoice.status === 'cancelled') return null

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/50 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          <HandCoins className="w-3.5 h-3.5 text-accent-text" aria-hidden />
          {mode === 'edit' ? 'Edit deposit request' : 'Request a deposit'}
        </span>
        <button type="button" onClick={onClose} aria-label="Close deposit form"
          className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <X className="w-4 h-4" />
        </button>
      </div>

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
          <input type="number" inputMode="decimal" min="0" step={kind === 'percent' ? '5' : '10'} autoFocus
            value={value} onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && previewValid && !busy) save() }}
            className="w-28 bg-bg-secondary border border-border-strong rounded-lg px-2 py-1.5 text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
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

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} loading={busy} disabled={busy || !previewValid}>
          {d.status === 'none' ? 'Save request' : 'Update request'}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        {/* Removal is deliberately in here rather than in the menu: it is one step
            further than opening the form, and the figures it destroys are on screen
            while the owner decides. */}
        {d.status !== 'none' && d.status !== 'paid' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove} className="ml-auto">Remove request</Button>
        )}
      </div>
      {d.status !== 'none' && (
        <p className="text-[11px] text-ink-faint">
          Changing the amount clears the “sent” mark — the customer was told a different figure, so it needs sending again.
        </p>
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
