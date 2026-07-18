'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { QuoteStatus, STATUS_LABELS, STATUS_COLORS } from '@/types'
import { markSentPatch } from '@/lib/quoteStatus'
import { markWonPatch } from '@/lib/followup'
import { localTodayISO } from '@/lib/utils'
import { ChevronDown, Loader2 } from 'lucide-react'

const ALL: QuoteStatus[] = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'paid', 'declined']

interface Props {
  quoteId: string
  status: QuoteStatus
  followUpCount?: number
  /** The quote's current send/expiry stamps, so the shared patches can leave an
   *  existing one alone. Optional: absent behaves as "not yet stamped", which is
   *  what a caller that doesn't track them means. */
  sentAt?: string | null
  validUntil?: string | null
  /** The price on the document, snapshotted if this control marks the quote won.
   *  Absent → the snapshot records null rather than a guess (see markWonPatch). */
  total?: number | null
  onChanged?: (s: QuoteStatus) => void
}

export function QuoteStatusControl({ quoteId, status, followUpCount, sentAt, validUntil, total, onChanged }: Props) {
  const supabase = createClient()
  const [current, setCurrent] = useState<QuoteStatus>(status)
  const [saving, setSaving] = useState(false)

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const s = e.target.value as QuoteStatus
    // "Scheduled" here only relabels the quote — it does NOT create a job, and it
    // hides the "Accepted — not scheduled yet" reminder. Say so before the owner
    // silently removes their own safety net.
    if (s === 'scheduled' && current !== 'scheduled') {
      const ok = await confirmDialog({
        title: 'Mark as Scheduled?',
        message: 'This only changes the label — it won’t add a job to your calendar. To actually book the visit, use Schedule on the quote instead.',
        confirmLabel: 'Just change the status',
      })
      if (!ok) return   // controlled select snaps back to `current` on its own
    }
    // A declined quote is lost — confirm before committing the transition.
    if (s === 'declined' && current !== 'declined') {
      const ok = await confirmDialog({
        title: 'Mark quote as declined?',
        message: 'This marks the quote as lost. You can change it back later.',
        confirmLabel: 'Mark declined',
        destructive: true,
      })
      if (!ok) return   // controlled select snaps back to `current` on its own
    }
    setCurrent(s)
    setSaving(true)
    // THE shared patches — this control used to hand-roll both. It re-spelled
    // markWonPatch's two accepted_* fields inline, and stamped sent_at in a SECOND
    // update that never wrote valid_until (which is why 0 of 55 quotes could expire).
    // One event, one patch, one write.
    const updates: Record<string, unknown> =
      s === 'sent'     ? markSentPatch({ sent_at: sentAt ?? null, valid_until: validUntil ?? null }, localTodayISO())
      : s === 'accepted' ? markWonPatch(followUpCount ?? 0, { acceptedPrice: Number(total) || null, selectedCadence: null })
      : { status: s }
    try {
      await queueOrRun(
        { kind: 'quote.update', payload: { id: quoteId, patch: updates }, label: `Quote → ${STATUS_LABELS[s]}` },
        async () => {
          const { error } = await supabase.from('quotes').update(updates).eq('id', quoteId)
          if (error) throw new Error(error.message)
        },
      )
      // Only tell the page on success (queueOrRun resolves for a queued offline
      // change too). Firing this from `finally` propagated a status the write had
      // REJECTED — the pill reverted while the page kept the new status.
      onChanged?.(s)
    } catch {
      setCurrent(status)   // hard failure → revert the optimistic status
      toast.error('Could not update the status — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative inline-block" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <select
        value={current}
        onChange={handleChange}
        disabled={saving}
        title="Change status"
        className={`appearance-none cursor-pointer pl-2.5 pr-6 py-1 rounded-full text-xs font-semibold border uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-opacity ${saving ? 'opacity-60' : ''} ${STATUS_COLORS[current]}`}
      >
        {ALL.map(s => (
          <option key={s} value={s} className="bg-bg-secondary text-ink normal-case">
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {saving
        ? <Loader2 className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none animate-spin" />
        : <ChevronDown className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />}
    </div>
  )
}