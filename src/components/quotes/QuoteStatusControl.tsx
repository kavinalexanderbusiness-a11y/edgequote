'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { confirm as confirmDialog } from '@/lib/confirm'
import { QuoteStatus, STATUS_LABELS, STATUS_COLORS } from '@/types'
import { ChevronDown, Loader2 } from 'lucide-react'

const ALL: QuoteStatus[] = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'paid', 'declined']

interface Props {
  quoteId: string
  status: QuoteStatus
  followUpCount?: number
  onChanged?: (s: QuoteStatus) => void
}

export function QuoteStatusControl({ quoteId, status, followUpCount, onChanged }: Props) {
  const supabase = createClient()
  const [current, setCurrent] = useState<QuoteStatus>(status)
  const [saving, setSaving] = useState(false)

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const s = e.target.value as QuoteStatus
    // A declined quote is lost — confirm before committing the transition.
    if (s === 'declined') {
      const ok = await confirmDialog({
        title: 'Mark quote as declined?',
        message: 'This marks the quote as lost. You can change it back later.',
        confirmLabel: 'Mark declined',
        destructive: true,
      })
      if (!ok) { e.target.value = current; return }
    }
    setCurrent(s)
    setSaving(true)
    const updates: Record<string, unknown> = { status: s }
    if (s === 'accepted') {
      updates.accepted_after_followup = (followUpCount ?? 0) > 0
      updates.follow_up_count_at_acceptance = followUpCount ?? 0
    }
    try {
      await queueOrRun(
        { kind: 'quote.update', payload: { id: quoteId, patch: updates }, label: `Quote → ${STATUS_LABELS[s]}` },
        async () => {
          const { error } = await supabase.from('quotes').update(updates).eq('id', quoteId)
          if (error) throw new Error(error.message)
          // Stamp the first send time only once (never overwrite the original) — online-only nicety.
          if (s === 'sent') await supabase.from('quotes').update({ sent_at: new Date().toISOString() }).eq('id', quoteId).is('sent_at', null)
        },
      )
    } catch {
      setCurrent(status)   // hard failure → revert the optimistic status
    } finally {
      setSaving(false)
      onChanged?.(s)
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