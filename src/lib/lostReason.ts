'use client'

// ── "Why was this lost?" — one door, asked from anywhere ─────────────────────
// A tiny external store mirroring lib/confirm and lib/toast, consumed by
// <LostReasonHost/> (mounted once in the dashboard layout). Call from anywhere:
//
//   const reason = await askLostReason({ quoteId, customerName })
//   // → a LossReason key if they answered, null if they skipped
//
// WHY IMPERATIVE RATHER THAN A LOCAL <Sheet open={…}>. The first cut held the
// sheet inside QuoteStatusControl, which is rendered on the quote detail page as
// `<QuoteStatusControl key={quote.status} …>` — a deliberate remount-on-change.
// So the instant the decline write landed and the page's status prop moved to
// 'declined', the control unmounted and took the open dialog with it: the
// question flashed for one frame and disappeared, on the exact door it exists
// to serve. A dialog whose lifetime is tied to the thing that just changed is
// structurally wrong here; the store outlives every remount.
//
// The REASON STORE itself is not new — it is `quote_outcomes`, written through
// lib/winLoss recordQuoteOutcome. This file owns the asking, not the recording.

import type { LossReason } from '@/lib/winLoss'

export interface LostReasonOptions {
  quoteId: string
  /** Names the question ("Why did Dana say no?"). Absent = a generic title. */
  customerName?: string
}

export interface LostReasonRequest {
  id: number
  opts: LostReasonOptions
  resolve: (reason: LossReason | null) => void
}

let current: LostReasonRequest | null = null
let seq = 0
const listeners = new Set<() => void>()
function emit() { for (const l of Array.from(listeners)) l() }

export function subscribeLostReason(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function getLostReason(): LostReasonRequest | null { return current }

/** Resolve + clear the active request. `null` = skipped, which is a legitimate
 *  and complete answer — the reason is optional by design. */
export function settleLostReason(reason: LossReason | null) {
  const r = current
  if (!r) return
  current = null
  emit()
  r.resolve(reason)
}

export function askLostReason(opts: LostReasonOptions): Promise<LossReason | null> {
  // One at a time; an older ask resolves as skipped rather than being orphaned.
  if (current) settleLostReason(null)
  return new Promise<LossReason | null>(resolve => {
    current = { id: ++seq, opts, resolve }
    emit()
  })
}
