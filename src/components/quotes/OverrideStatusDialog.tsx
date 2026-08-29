'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { STATUS_LABELS, type QuoteStatus } from '@/types'
import { ShieldAlert, Loader2 } from 'lucide-react'

// ── Advanced → Override status ───────────────────────────────────────────────
//
// ⭐⭐ CHANGING A STATUS IS NOT ACCEPTANCE, and this dialog's whole job is to
// stop the two feeling like one action. The everyday status dropdown used to be
// the acceptance door: picking "Approved" wrote a consent snapshot nobody had
// given, and the notification bell then told the owner their customer had
// accepted. That door is gone.
//
// Repairing a row is still a real need — a quote paid in cash months ago, a row
// imported wrong, a trigger that never fired — so this exists. It is simply
// honest about what it is:
//
//   • it lives under Advanced, not in the row's own pill;
//   • it says, in the case that matters most, that overriding to Accepted does
//     NOT record an acceptance and does NOT let the quote be scheduled or
//     invoiced on that basis;
//   • it REQUIRES the owner's own words for why, which land on the audit event
//     the status change already writes (no second audit table);
//   • and it cannot reach quote_acceptances — owner_override_quote_status has no
//     insert into it, and the table has no INSERT grant for any client role.
//
// ⛔ The reason is not optional and has no default. An override with no stated
// cause is indistinguishable, a month later, from a mistake.

/** The statuses an override may set. Draft and Sent have their own real doors —
 *  markSentPatch stamps the expiry clock and the chase anchor — and routing them
 *  through an "override" would teach an owner that sending a quote is an
 *  emergency action. The database refuses them too. */
export const OVERRIDABLE_STATUSES: QuoteStatus[] = ['accepted', 'scheduled', 'completed', 'paid', 'declined']

interface Props {
  open: boolean
  onClose: () => void
  quoteNumber: string
  currentStatus: QuoteStatus
  /** Resolves true when the override landed. */
  onOverride: (next: QuoteStatus, reason: string) => Promise<boolean>
}

export function OverrideStatusDialog({ open, onClose, quoteNumber, currentStatus, onOverride }: Props) {
  const [next, setNext] = useState<QuoteStatus | ''>('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  // Reset on each OPEN — a reason typed for last month's repair must never be
  // sitting in the box for this one.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) { setNext(''); setReason('') }
  }

  const canSave = !!next && reason.trim().length > 0 && !saving

  async function save() {
    if (!canSave || !next) return
    setSaving(true)
    try {
      const ok = await onOverride(next, reason.trim())
      if (ok) onClose()
    } finally { setSaving(false) }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose() }}
      size="md"
      icon={ShieldAlert}
      title={`Override the status of ${quoteNumber}`}
      onSubmit={save}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="danger" onClick={save} disabled={!canSave}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {next ? `Override to ${STATUS_LABELS[next]}` : 'Override'}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-ink-muted">
        This moves the label and nothing else. It is for repairing a row that is already
        wrong — not for recording what a customer decided.
      </p>

      <div className="mt-4">
        <p className="text-xs font-semibold text-ink uppercase tracking-wide mb-2">Set the status to</p>
        <div className="flex flex-wrap gap-2">
          {OVERRIDABLE_STATUSES.filter(s => s !== currentStatus).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setNext(s)}
              className={`min-h-[44px] px-3.5 rounded-xl text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                next === s
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                  : 'border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong'}`}
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {/* ⭐ The one warning that matters, shown only when it applies. Overriding to
          Accepted is the case an owner is most likely to reach for and most likely
          to misread as "I've recorded that they accepted". */}
      {next === 'accepted' && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3">
          <p className="text-xs text-ink">
            <span className="font-semibold">This does not record a customer acceptance.</span>{' '}
            The quote will still say no acceptance is on record, and it still can’t be scheduled
            or invoiced on this basis. If they really did accept it, close this and use{' '}
            <span className="text-ink font-medium">Record customer acceptance</span> instead —
            it asks who accepted and how, and that is what authorizes the work.
          </p>
        </div>
      )}

      <div className="mt-4">
        <label className="block text-xs font-semibold text-ink uppercase tracking-wide mb-2" htmlFor="override-reason">
          Why are you overriding this?
        </label>
        <textarea
          id="override-reason"
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={2}
          placeholder="e.g. Paid in cash in March; imported from the old system"
          className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
        <p className="text-xs text-ink-faint mt-1.5">
          Required. It’s saved to this quote’s history, so the change explains itself months from now.
        </p>
      </div>
    </Modal>
  )
}
