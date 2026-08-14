// ── THE sales stage vocabulary ───────────────────────────────────────────────
// Six rungs, one ladder, derived from records EdgeQuote already keeps. No
// `stage` column, no `pipeline_status`, no second lifecycle to keep in sync with
// quotes.status — the same posture lib/quoteStatus took with 'expired' and
// lib/payments/ledger took with 'overdue': a display state DERIVED from real
// state, never stored.
//
// Why this file is tiny and dependency-free: seven surfaces had already
// hand-rolled "which statuses count as won" as a local Set or inline array —
// customers/[id], properties, timeline, businessIntelligence, ai/assist,
// quotes/[id], and lib/winLoss. Six copies of one rule is how a business ends up
// with a conversion figure that disagrees with its customer profile. Anything
// that needs the rule imports it from here, including client components, so it
// must not drag a Supabase client or a pricing engine into their bundle.
//
// ⚠️ The ladder describes a DEAL, not a document. A quote is the document a deal
// usually wears once it exists; before that the deal is a lead. See lib/pipeline
// for how each rung is derived and what to do about it.

/**
 * The rungs, in ladder order.
 *
 * `quote_draft` is the rung the session brief called "Quote needed". It is named
 * for the record that puts a deal on it — a DRAFT QUOTE, written but never
 * delivered. Calling that "quote needed" would read as "nothing written yet",
 * which is the rung below it (`contacted`), and the two would be confusable in
 * exactly the wrong direction: the owner would go build a quote that already
 * exists. Same ladder, one truthful label.
 */
export type SalesStage = 'new_lead' | 'contacted' | 'quote_draft' | 'quote_sent' | 'won' | 'lost'

/** Ladder order — left to right, first contact to decided. */
export const STAGE_ORDER: SalesStage[] = ['new_lead', 'contacted', 'quote_draft', 'quote_sent', 'won', 'lost']

export const STAGE_LABELS: Record<SalesStage, string> = {
  new_lead: 'New lead',
  contacted: 'Contacted',
  quote_draft: 'Quote drafted',
  quote_sent: 'Quote sent',
  won: 'Won',
  lost: 'Lost',
}

/** One line saying what the rung MEANS, in the owner's words. */
export const STAGE_MEANING: Record<SalesStage, string> = {
  new_lead: 'They reached out and nobody has answered yet',
  contacted: 'You’ve replied — nothing is written down for them yet',
  quote_draft: 'A quote exists but the customer hasn’t seen it',
  quote_sent: 'It’s with them — waiting on their answer',
  won: 'They said yes, and it still needs something from you',
  lost: 'They said no',
}

// ── Won / lost ───────────────────────────────────────────────────────────────
// THE canonical won/lost classification. Moved here from lib/winLoss (which now
// re-exports it) so a client component can ask the question without importing a
// Supabase client. The reasoning below is load-bearing and moved with it.
//
// A quote is DECIDED only when someone answered it. `sent` is neither won nor lost, so
// it falls out of `decided` and out of `acceptance = won / decided` — which is how the
// owner's rule (2026-07-16) that **expired quotes do not count toward acceptance** is
// satisfied: an expired quote is still `sent`, so it was never counted in the first
// place. That is deliberate, not incidental. Do not "fix" it by adding expiry here.
//
// ⚠️ READ BEFORE CHANGING EITHER LINE. Excluding the unanswered is not free — it
// INFLATES acceptance, and only ever upward. Measured on the live book 2026-07-16:
//
//     won 34 · lost 6 · unanswered 14
//     acceptance = 34/40 = 0.850          ← what the learner sees
//     with ghosts counted = 34/54 = 0.630 ← what actually happened
//
// quoteLearning:231 raises the price when `acceptance >= 0.85`. It is sitting EXACTLY
// on that boundary, contributing +0.000 today. One more won quote → 0.854 → targetRatio
// 0.923, which finally clears the 0.92 floor. So the first price this learner ever
// moves, it moves UP, on a number that is 63% true.
//
// Whether a ghost is a loss is a Phase 5 decision for the owner (see the Quote V2
// roadmap) — NOT something to settle by editing this line. It is recorded here because
// this is where someone will come looking.
export const isWon = (s: string) => s === 'accepted' || s === 'scheduled' || s === 'completed' || s === 'paid'
export const isLost = (s: string) => s === 'declined'

/**
 * The rung a QUOTE puts its deal on. Total, not partial: every value
 * quotes.status can hold maps to exactly one rung, so a status this app has
 * never heard of lands on `quote_draft` — "written down, nobody has seen it" —
 * rather than silently vanishing from the board.
 *
 * Note what is NOT here: expiry. An expired quote is still `sent` (lib/quoteStatus
 * keeps 'expired' a display overlay), so it stays on `quote_sent` where it belongs —
 * it is a quote awaiting an answer that has run out of time, not a decided one.
 * The pipeline says so in the row's detail line instead of inventing a seventh rung.
 */
export function stageOfQuote(status: string): SalesStage {
  if (isWon(status)) return 'won'
  if (isLost(status)) return 'lost'
  if (status === 'sent') return 'quote_sent'
  return 'quote_draft'
}

/**
 * Every status a quote can hold once it has left the desk — i.e. everything but
 * 'draft'. A runtime ARRAY because a PostgREST `.in()` filter needs one, and the
 * one place that wanted it (the pricing advisor's history read) was spelling the
 * four won statuses out inline — a seventh copy hiding as a query filter.
 */
export const NON_DRAFT_QUOTE_STATUSES = ['sent', 'accepted', 'scheduled', 'completed', 'paid', 'declined']

/** Still being worked — not yet decided either way. */
export function isOpenStage(s: SalesStage): boolean {
  return s !== 'won' && s !== 'lost'
}
