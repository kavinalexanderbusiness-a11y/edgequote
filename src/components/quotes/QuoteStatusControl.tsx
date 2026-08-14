'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { QuoteStatus, STATUS_LABELS, STATUS_COLORS } from '@/types'
import { markSentPatch, isSystemAdvancedQuoteStatus, QUOTE_STATUS_MEANING } from '@/lib/quoteStatus'
import { markWonPatch } from '@/lib/followup'
import { askLostReason } from '@/lib/lostReason'
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
  /** Only to address the lost-reason question by name ("Why did Dana say no?").
   *  Absent simply drops the name from the title. */
  customerName?: string
  onChanged?: (s: QuoteStatus) => void
}

export function QuoteStatusControl({ quoteId, status, followUpCount, sentAt, validUntil, total, customerName, onChanged }: Props) {
  const supabase = createClient()
  const [current, setCurrent] = useState<QuoteStatus>(status)
  const [saving, setSaving] = useState(false)

  // Adopt an EXTERNAL status change. `current` seeds from the prop once at
  // mount, and the quote list renders this control under a stable key={q.id} —
  // so when the customer accepted in the portal (or another tab/Stripe changed
  // the row) and the list's realtime refetch delivered the new status, the pill
  // kept showing the mount-time value forever. Reconcile only when the PROP
  // ITSELF changes (tracked in a ref): a parent re-render that still carries
  // the OLD status — the normal state right after our own successful write,
  // before its refetch lands — must not revert the optimistic value we just
  // set. Never adopt mid-save either; the in-flight change owns the pill.
  const lastPropStatus = useRef(status)
  useEffect(() => {
    if (saving) return
    if (status !== lastPropStatus.current) {
      lastPropStatus.current = status
      setCurrent(status)
    }
  }, [status, saving])

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
    // ── Overriding a state the app normally derives ───────────────────────────
    // completed and paid are advanced by DATABASE TRIGGERS from real events:
    // sync_quote_on_job_complete fires when the job completes (only from
    // accepted/scheduled), sync_quote_on_invoice_paid when the invoice is paid
    // (only from completed). Because each trigger advances FROM an expected prior
    // state, a hand-set value is never re-derived — mark a quote Paid today and the
    // invoice actually being paid tomorrow will NOT correct it. It stays wrong, and
    // it is wrong about money.
    //
    // Repair is still allowed — a genuinely stuck row needs it — but it stops being
    // an everyday click. Same confirmDialog this control already uses for Scheduled
    // and Declined, so nothing new is introduced; the message just names what the
    // app would have done and that it won't do it later.
    if (isSystemAdvancedQuoteStatus(s) && s !== 'scheduled' && current !== s) {
      const ok = await confirmDialog({
        title: `Set this quote to ${STATUS_LABELS[s]} by hand?`,
        message: s === 'paid'
          ? 'EdgeQuote marks a quote Paid on its own when the invoice is paid. Setting it here does NOT record a payment, and it will not be corrected when real money arrives — the quote will simply say Paid. Only do this to fix a quote that is already wrong.'
          : 'EdgeQuote marks a quote Completed on its own when the work is finished. Setting it here does NOT complete any visit, and it will not be corrected later. Only do this to fix a quote that is already wrong.',
        confirmLabel: `Set ${STATUS_LABELS[s]} anyway`,
        destructive: true,
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
      // ── The one moment the reason is actually known ────────────────────────
      // Ask AFTER the write lands, never before: the reason is a note ABOUT a
      // decline, so offering it on a decline that failed would record why a quote
      // was lost that is in fact still marked sent. Fire-and-forget through the
      // shared store (lib/lostReason) — this control is about to be REMOUNTED by
      // the very status change that triggered the question (the quote page renders
      // it with key={quote.status}), so the dialog cannot live here. Not awaited:
      // nothing about the status write depends on the answer.
      if (s === 'declined' && current !== 'declined') {
        void askLostReason({ quoteId, customerName })
      }
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
        {/* Grouped, not filtered. Three of these seven are advanced by DATABASE
            TRIGGERS from real events — a job being booked, work completing, an
            invoice being paid (see SYSTEM_ADVANCED_QUOTE_STATUSES). Setting one by
            hand asserts something the app cannot see, and because each trigger only
            advances FROM an expected prior state, it is never re-derived later: a
            hand-set "Paid" simply stays wrong. The owner keeps the ability to
            correct a row — that is a real need — but the group heading says which
            half of this list the app normally manages, which is the difference
            between an informed correction and an accident. */}
        <optgroup label="You set these" className="bg-bg-secondary text-ink normal-case">
          {ALL.filter(s => !isSystemAdvancedQuoteStatus(s)).map(s => (
            <option key={s} value={s} title={QUOTE_STATUS_MEANING[s]} className="bg-bg-secondary text-ink normal-case">
              {STATUS_LABELS[s]}
            </option>
          ))}
        </optgroup>
        <optgroup label="Set automatically — override with care" className="bg-bg-secondary text-ink normal-case">
          {ALL.filter(isSystemAdvancedQuoteStatus).map(s => (
            <option key={s} value={s} title={QUOTE_STATUS_MEANING[s]} className="bg-bg-secondary text-ink normal-case">
              {STATUS_LABELS[s]}
            </option>
          ))}
        </optgroup>
      </select>
      {saving
        ? <Loader2 className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none animate-spin" />
        : <ChevronDown className="w-3 h-3 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none opacity-60" />}
    </div>
  )
}