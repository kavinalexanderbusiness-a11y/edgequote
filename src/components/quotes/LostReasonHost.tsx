'use client'

import { useState, useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { subscribeLostReason, getLostReason, settleLostReason } from '@/lib/lostReason'
import { LOSS_REASONS, recordQuoteOutcome, type LossReason } from '@/lib/winLoss'
import { Loader2, HelpCircle } from 'lucide-react'

// ── Why was this lost? — one optional question, asked once ───────────────────
// Renders the shared lost-reason sheet from the store (lib/lostReason). Mounted
// once in the dashboard layout, exactly like <ConfirmHost/>.
//
// The reason store already exists: `quote_outcomes`, written through THE recorder
// (lib/winLoss recordQuoteOutcome — an idempotent upsert on user_id+quote_id) and
// read by Grow's Win/Loss panel, the pricing advisor and the Pipeline. This adds
// no table, no column and no second vocabulary. It is the same seven reasons,
// asked at the moment the answer is actually known rather than weeks later on an
// analytics page.
//
// OPTIONAL, and it means it. There is a real Skip, Escape closes it, the backdrop
// closes it, and nothing is blocked by declining to answer. A quote is often lost
// for a reason the owner genuinely doesn't know, and forcing a choice would fill
// the field with tidy noise — worse than a sparse field of truth, because the
// pricing advisor believes what it reads.
export function LostReasonHost() {
  const req = useSyncExternalStore(subscribeLostReason, getLostReason, getLostReason)
  const [saving, setSaving] = useState<LossReason | null>(null)

  if (!req) return null
  const { quoteId, customerName } = req.opts

  async function pick(reason: LossReason) {
    if (saving) return
    setSaving(reason)
    const res = await recordQuoteOutcome(createClient(), quoteId, reason)
    setSaving(null)
    // A failed write keeps the sheet OPEN. Closing on failure would leave the
    // owner believing they answered while the reason is silently absent from the
    // board and from Win/Loss — the quiet-lie failure mode this codebase keeps
    // paying for.
    if (!res.ok) { toast.error(res.error || 'Couldn’t save that just now — try again.'); return }
    settleLostReason(reason)
  }

  function skip() { if (!saving) settleLostReason(null) }

  return (
    <Modal
      open
      onClose={skip}
      size="sm"
      icon={HelpCircle}
      title={customerName ? `Why did ${customerName} say no?` : 'Why was this lost?'}
    >
      <p className="text-xs text-ink-muted mb-3">
        Optional. It’s the only way EdgeQuote can tell you where you keep losing on price —
        and it never changes the quote.
      </p>
      <div className="flex flex-wrap gap-2">
        {LOSS_REASONS.map(r => (
          <button
            key={r.key}
            type="button"
            onClick={() => pick(r.key)}
            disabled={!!saving}
            // 44px minimum: this is the dialog most likely to be answered
            // one-handed on a phone, standing in someone's driveway.
            className="min-h-[44px] px-3.5 rounded-xl text-sm font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-accent/40 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {saving === r.key && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {r.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={skip}
        disabled={!!saving}
        className="mt-4 min-h-[44px] w-full rounded-xl text-sm font-medium text-ink-faint hover:text-ink-muted transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        Skip — I’d rather not say
      </button>
    </Modal>
  )
}
