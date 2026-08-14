'use client'

// ── Changes to a visit, in the customer's words ─────────────────────────────
//
// The one thing this surface must never do is let "extra work" read as "the
// price went up". So the card always says three separate things, in this order:
// what you originally approved, what you have approved since, and what is merely
// being ASKED. A pending change is never inside a total.
//
// Deliberately small. Approving extra work on a phone, in a hallway, while
// somebody waits, is a two-tap decision — not a contract to scroll.

import { useState } from 'react'
import { FileSignature, Check, X, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { fmtMoney, type PortalActions } from './shared'
import type { PortalChangeOrder, VisitChanges } from '../model'

/** The three-figure story. Rendered wherever a visit's money is shown. */
export function ChangeBreakdown({ v, className }: { v: VisitChanges; className?: string }) {
  if (v.approved.length === 0 && v.pending.length === 0) return null
  return (
    <div className={cn('rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2 space-y-1', className)}>
      <Row label="Originally approved" value={fmtMoney(v.original)} />
      {v.approvedChanges > 0 && (
        <Row label={v.approved.length === 1 ? 'Approved change' : `Approved changes (${v.approved.length})`}
          value={`+${fmtMoney(v.approvedChanges)}`} tone="text-emerald-400" />
      )}
      {v.approvedChanges > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-1">
          <span className="text-xs font-semibold text-ink">Approved total</span>
          <span className="text-sm font-bold text-ink tabular-nums">{fmtMoney(v.authorized)}</span>
        </div>
      )}
      {v.pending.length > 0 && (
        <p className="text-[11px] text-amber-400 pt-0.5">
          {v.pending.length === 1 ? 'One change is waiting for your decision' : `${v.pending.length} changes are waiting for your decision`} — not included above.
        </p>
      )}
      {v.declined.length > 0 && (
        <p className="text-[11px] text-ink-faint">
          {v.declined.length === 1 ? 'One change was declined' : `${v.declined.length} changes were declined`} — not charged.
        </p>
      )}
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-ink-muted min-w-0 truncate">{label}</span>
      <span className={cn('text-xs font-semibold tabular-nums shrink-0', tone || 'text-ink')}>{value}</span>
    </div>
  )
}

/**
 * ONE pending change, with the decision on it.
 *
 * `originalTotal` is the figure the customer already agreed to. It is printed on
 * the card because the single most likely misreading of this screen is "they're
 * changing what I signed up for" — the answer has to be visible at the moment of
 * the decision, not a tab away.
 */
export function PendingChangeCard({
  co, originalTotal, actions, onDecide, deciding,
}: {
  co: PortalChangeOrder
  originalTotal: number | null
  actions: PortalActions
  onDecide: (co: PortalChangeOrder, decision: 'approve' | 'decline') => void
  deciding: string | null
}) {
  const [confirming, setConfirming] = useState(false)
  const busy = deciding === co.id

  return (
    <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] card-lift animate-rise p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0">
          <FileSignature className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">Extra work needs your approval</p>
          <p className="text-xs text-ink-muted">Reference {co.co_number}</p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
        <p className="text-sm text-ink break-words">{co.description}</p>
        <p className="text-xl font-bold text-ink tabular-nums mt-1">{fmtMoney(co.amount)}</p>
      </div>

      {/* ⭐ The sentence this whole feature exists to be able to say. */}
      <p className="text-xs text-ink-muted">
        {originalTotal != null && originalTotal > 0
          ? <>Your original approved total of <span className="font-semibold text-ink tabular-nums">{fmtMoney(originalTotal)}</span> doesn’t change — this would be added to it.</>
          : <>This would be added to the work you already approved, which doesn’t change.</>}
        {' '}Nothing is charged until the work is done and invoiced.
      </p>

      {confirming ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink">Approve {fmtMoney(co.amount)} of extra work?</p>
          <div className="flex items-center gap-2">
            <Button className="flex-1" onClick={() => onDecide(co, 'approve')} loading={busy}>
              <Check className="w-4 h-4" /> Yes, approve
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Button className="w-full" onClick={() => setConfirming(true)} disabled={busy}>
            <Check className="w-4 h-4" /> Approve {fmtMoney(co.amount)}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="flex-1" onClick={() => onDecide(co, 'decline')} loading={busy}>
              <X className="w-4 h-4" /> No thanks
            </Button>
            <Button variant="ghost" className="flex-1"
              onClick={() => actions.askAbout(`About ${co.co_number} (${co.description} — ${fmtMoney(co.amount)}): `)}>
              <MessageSquare className="w-4 h-4" /> Ask about it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
