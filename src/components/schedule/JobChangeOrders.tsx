'use client'

import { useState } from 'react'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { confirm } from '@/lib/confirm'
import {
  ChangeOrder, CHANGE_ORDER_LABELS, CHANGE_ORDER_TONES, authorizedValue, type AuthorizedValue,
} from '@/lib/changeOrders'
import { Plus, Send, X, Check, Ban, MessageSquare, FileSignature } from 'lucide-react'

// ── The owner's change-order surface, on the visit it belongs to ─────────────
//
// The whole point is the BREAKDOWN. Three figures that must never collapse into
// one: what was originally approved, what the customer has since approved, and
// what is merely asked. A pending change is shown OUTSIDE the authorized total
// and says so in words, because "authorized" is a claim about the customer's
// consent — not about the owner's hopes.

export interface ChangeOrderCreateInput { description: string; amount: number; send: boolean }

interface Props {
  /** The visit's originally agreed value (lib/visitValue's answer) — read, never written. */
  originalValue: number
  changeOrders: ChangeOrder[]
  /** All of this visit's job_line_items; the engine filters change-order-backed rows. */
  lineItems: { amount: number | string; change_order_id?: string | null }[]
  /** False when the visit has no customer — there is nobody to approve anything. */
  canAsk: boolean
  /** False when the customer has no phone and no email — the ask can't be delivered. */
  canMessage: boolean
  onCreate: (input: ChangeOrderCreateInput) => Promise<void>
  onSend: (co: ChangeOrder) => Promise<void>
  onCancel: (co: ChangeOrder) => Promise<void>
  onOwnerDecision: (co: ChangeOrder, decision: 'approve' | 'decline') => Promise<void>
  /** Text/email the ask again. Absent = no re-send affordance. */
  onRemind?: (co: ChangeOrder) => Promise<void>
}

export function JobChangeOrders({
  originalValue, changeOrders, lineItems, canAsk, canMessage,
  onCreate, onSend, onCancel, onOwnerDecision, onRemind,
}: Props) {
  const [adding, setAdding] = useState(false)
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const av = authorizedValue({ originalValue, changeOrders, lineItems })
  const open = changeOrders.filter(c => c.status === 'draft' || c.status === 'pending')
  const settled = changeOrders.filter(c => c.status !== 'draft' && c.status !== 'pending')
  const amt = Number(amount)
  const ready = desc.trim().length > 0 && amt > 0

  // Every action funnels through here so a failure is REPORTED rather than
  // optimistically painted. The doors throw (lib/changeOrders); swallowing that
  // would tell the owner a customer had approved something they hadn't.
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'That didn’t go through.') }
    setBusy(null)
  }

  async function submit(send: boolean) {
    if (!ready) return
    await run('new', async () => {
      await onCreate({ description: desc.trim(), amount: amt, send })
      setDesc(''); setAmount(''); setAdding(false)
    })
  }

  // Recording a decision on the customer's behalf is a claim ABOUT them. It is
  // stored as decided_via='owner' and never as a portal tap, and the owner is
  // asked to mean it — the same treatment marking an invoice paid by hand gets.
  async function ownerDecision(co: ChangeOrder, decision: 'approve' | 'decline') {
    const ok = await confirm({
      title: decision === 'approve' ? `Record ${co.co_number} as approved?` : `Record ${co.co_number} as declined?`,
      message: decision === 'approve'
        ? `Only do this if ${'the customer'} has actually agreed to ${co.description.trim()} for ${formatCurrency(Number(co.amount))}. It will be added to this visit and billed on its invoice.`
        : `This closes ${co.co_number}. The work won’t be added or billed, and it can’t be re-opened — you’d create a new change.`,
      confirmLabel: decision === 'approve' ? 'Yes, they approved it' : 'Yes, they declined',
      destructive: decision === 'decline',
    })
    if (ok) await run(co.id, () => onOwnerDecision(co, decision))
  }

  async function withdraw(co: ChangeOrder) {
    const ok = await confirm({
      title: `Withdraw ${co.co_number}?`,
      message: co.status === 'pending'
        ? 'The customer will no longer be asked to approve it. It stays on record as withdrawn.'
        : 'It stays on record as withdrawn. Nothing was sent, so the customer never saw it.',
      confirmLabel: 'Withdraw it',
      destructive: true,
    })
    if (ok) await run(co.id, () => onCancel(co))
  }

  return (
    <div className="space-y-2.5">
      <ValueBreakdown av={av} />

      {!canAsk && (
        <p className="text-xs text-amber-400">
          Link a customer to this visit before adding a change — somebody has to approve it.
        </p>
      )}

      {/* Open first: these are the ones that need a decision. */}
      {open.map(co => (
        <Row key={co.id} co={co} busy={busy === co.id}
          actions={
            <>
              {co.status === 'draft' && canMessage && (
                <RowBtn onClick={() => run(co.id, () => onSend(co))} icon={Send} label="Send for approval" tone="primary" />
              )}
              {co.status === 'pending' && onRemind && canMessage && (
                <RowBtn onClick={() => run(co.id, () => onRemind(co))} icon={MessageSquare} label="Ask again" />
              )}
              {co.status === 'pending' && (
                <>
                  <RowBtn onClick={() => ownerDecision(co, 'approve')} icon={Check} label="They approved" tone="emerald" />
                  <RowBtn onClick={() => ownerDecision(co, 'decline')} icon={Ban} label="They declined" />
                </>
              )}
              <RowBtn onClick={() => withdraw(co)} icon={X} label="Withdraw" />
            </>
          }
        />
      ))}

      {settled.map(co => <Row key={co.id} co={co} busy={busy === co.id} />)}

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Add — one description, one price, one decision about sending it. */}
      {adding ? (
        <div className="rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2">
          <input autoFocus value={desc} onChange={e => setDesc(e.target.value)}
            placeholder="What extra work? e.g. replace two gate posts"
            className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-2 py-2 text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
          <div className="flex items-center gap-2">
            <div className="relative shrink-0">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-sm">$</span>
              <input type="number" min="0" step="5" inputMode="decimal" value={amount}
                onChange={e => setAmount(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && ready && canMessage) submit(true) }}
                placeholder="0"
                className="w-28 bg-bg-tertiary border border-border-strong rounded-lg pl-5 pr-2 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
            <span className="text-[11px] text-ink-faint min-w-0">
              Added to this visit only. The original quote is not changed.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => submit(true)} loading={busy === 'new'} disabled={!ready || !canMessage}>
              <Send className="w-3.5 h-3.5" /> Send for approval
            </Button>
            <Button size="sm" variant="ghost" onClick={() => submit(false)} disabled={!ready || busy === 'new'}>
              Save without sending
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDesc(''); setAmount(''); setError(null) }}>
              Cancel
            </Button>
          </div>
          {!canMessage && (
            <p className="text-[11px] text-amber-400">
              This customer has no phone or email on file, so the ask can’t be sent. Save it here and get their answer another way.
            </p>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => { setAdding(true); setError(null) }} disabled={!canAsk}
          className="tap-target w-full h-10 rounded-lg border border-dashed border-border-strong text-sm font-medium text-ink-muted hover:text-ink hover:border-accent/50 flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:pointer-events-none">
          <Plus className="w-4 h-4" /> Add a change
        </button>
      )}
    </div>
  )
}

// ── The breakdown ────────────────────────────────────────────────────────────
// Reads top to bottom as the story the owner has to be able to tell a customer:
// this is what you approved, this is what you approved since, this is the total
// you have agreed to — and, separately, this is what is still only asked.
function ValueBreakdown({ av }: { av: AuthorizedValue }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/60 px-2.5 py-2 space-y-1">
      <Line label="Originally approved" value={formatCurrency(av.original)} />
      {av.approvedChanges > 0 && (
        <Line label={`Approved changes${av.approvedCount > 1 ? ` (${av.approvedCount})` : ''}`}
          value={`+${formatCurrency(av.approvedChanges)}`} tone="text-emerald-300" />
      )}
      <div className="flex items-center justify-between border-t border-border pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Authorized value</span>
        <span className="text-base font-bold text-ink tabular-nums">{formatCurrency(av.authorized)}</span>
      </div>
      {av.pending > 0 && (
        <p className="text-[11px] text-amber-400 flex items-center justify-between gap-2 pt-0.5">
          <span>Awaiting approval{av.pendingCount > 1 ? ` (${av.pendingCount})` : ''} — not counted yet</span>
          <span className="font-semibold tabular-nums shrink-0">{formatCurrency(av.pending)}</span>
        </p>
      )}
      {av.extras > 0 && (
        <>
          <Line label="Extra services you added" value={`+${formatCurrency(av.extras)}`} />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-muted">Total this visit will bill</span>
            <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(av.billable)}</span>
          </div>
        </>
      )}
    </div>
  )
}

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-ink-muted min-w-0 truncate">{label}</span>
      <span className={cn('font-semibold tabular-nums shrink-0', tone || 'text-ink')}>{value}</span>
    </div>
  )
}

// ── One change order ─────────────────────────────────────────────────────────
function Row({ co, busy, actions }: { co: ChangeOrder; busy: boolean; actions?: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border bg-bg-secondary p-2.5 space-y-1.5', busy && 'opacity-60 pointer-events-none')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink min-w-0 flex-1 break-words">{co.description}</span>
        <span className="text-sm font-bold text-ink tabular-nums shrink-0">{formatCurrency(Number(co.amount))}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] font-mono text-ink-faint">{co.co_number}</span>
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border', CHANGE_ORDER_TONES[co.status])}>
          {CHANGE_ORDER_LABELS[co.status]}
        </span>
        <span className="text-[10px] text-ink-faint">{provenance(co)}</span>
      </div>
      {actions && <div className="flex items-center gap-1.5 flex-wrap pt-0.5">{actions}</div>}
    </div>
  )
}

// ⭐ Says HOW a decision was recorded, always. "Approved" alone would let an
// owner-entered approval read as the customer's own tap on every screen that
// shows it afterwards — which is exactly the ambiguity this feature removes.
function provenance(co: ChangeOrder): string {
  const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
  if (co.status === 'approved') {
    return co.decided_via === 'portal'
      ? `Approved by the customer ${day(co.approved_at)}`
      : `Recorded as approved by you ${day(co.approved_at)}`
  }
  if (co.status === 'declined') {
    return co.decided_via === 'portal'
      ? `Declined by the customer ${day(co.declined_at)}`
      : `Recorded as declined by you ${day(co.declined_at)}`
  }
  if (co.status === 'cancelled') return `Withdrawn ${day(co.cancelled_at)}`
  if (co.status === 'pending') return `Sent ${day(co.sent_at)} — waiting on them`
  return 'Not sent yet'
}

function RowBtn({ onClick, icon: Icon, label, tone }: {
  onClick: () => void; icon: typeof Plus; label: string; tone?: 'primary' | 'emerald'
}) {
  return (
    <button type="button" onClick={onClick}
      className={cn(
        'tap-target h-9 sm:h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 active:scale-95 transition-transform',
        tone === 'primary' ? 'bg-accent border-accent text-black font-semibold hover:opacity-90'
          : tone === 'emerald' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
            : 'border-border text-ink-muted hover:text-ink hover:border-border-strong',
      )}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}

export { FileSignature as ChangeOrderIcon }
