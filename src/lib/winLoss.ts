import type { SupabaseClient } from '@supabase/supabase-js'
import { neighborhoodKey } from '@/lib/profitability'

// ── Win/Loss analysis (Growth) ──────────────────────────────────────────────────
// The win side is already in the data (quotes.status accepted vs declined). This
// module captures the missing half — WHY a quote was lost — and turns wins+losses
// into pricing intelligence: win rate overall and per neighbourhood, and where you
// keep losing on price. Pure analysis here; the Suggestions Center and the Grow
// Win/Loss panel both consume it so they never disagree. Reads quotes only; never
// touches the quoting flow.

export type LossReason = 'price' | 'competitor' | 'no_response' | 'timing' | 'scope' | 'not_needed' | 'other'

export const LOSS_REASONS: { key: LossReason; label: string }[] = [
  { key: 'price', label: 'Too expensive' },
  { key: 'competitor', label: 'Went with a competitor' },
  { key: 'no_response', label: 'Ghosted / no response' },
  { key: 'timing', label: 'Bad timing' },
  { key: 'scope', label: 'Wrong scope / not what they wanted' },
  { key: 'not_needed', label: 'No longer needed' },
  { key: 'other', label: 'Other' },
]
export const LOSS_REASON_LABEL: Record<string, string> = Object.fromEntries(LOSS_REASONS.map(r => [r.key, r.label]))

export interface QuoteOutcomeRow {
  quote_id: string
  reason: string
  detail: string | null
  competitor_price: number | null
}

// A minimal quote shape — what both the generator and the panel need.
export interface WLQuote {
  id: string
  status: string
  total: number | null
  property_id: string | null
}

export interface HoodWinLoss {
  hood: string
  decided: number
  won: number
  lost: number
  priceLosses: number       // losses tagged 'price'
  winRate: number           // 0..1
  lostValue: number         // $ of lost quotes (their totals)
}

export interface WinLossStats {
  decided: number           // accepted + declined
  won: number               // accepted
  lost: number              // declined
  winRate: number           // 0..1 over decided
  taggedLost: number        // declined quotes with a recorded reason
  untaggedLost: number      // declined quotes still needing a reason
  reasonCounts: Record<string, number>
  byHood: HoodWinLoss[]     // sorted: most price-loss first
}

// THE canonical won/lost classification (reused by quoteLearning — never duplicated).
export const isWon = (s: string) => s === 'accepted' || s === 'scheduled' || s === 'completed' || s === 'paid'
export const isLost = (s: string) => s === 'declined'

// Aggregate wins/losses. `hoodOf` maps a quote to its neighbourhood key (the
// caller resolves property → neighbourhood with the shared naming engine).
export function analyzeWinLoss(
  quotes: WLQuote[],
  outcomes: QuoteOutcomeRow[],
  hoodOf: (q: WLQuote) => string,
): WinLossStats {
  const reasonByQuote: Record<string, string> = {}
  for (const o of outcomes) reasonByQuote[o.quote_id] = o.reason

  let won = 0, lost = 0, taggedLost = 0
  const reasonCounts: Record<string, number> = {}
  const hoods: Record<string, HoodWinLoss> = {}
  const hood = (key: string): HoodWinLoss => (hoods[key] ||= { hood: key, decided: 0, won: 0, lost: 0, priceLosses: 0, winRate: 0, lostValue: 0 })

  for (const q of quotes) {
    const w = isWon(q.status), l = isLost(q.status)
    if (!w && !l) continue
    const h = hood(hoodOf(q))
    h.decided++
    if (w) { won++; h.won++ }
    if (l) {
      lost++; h.lost++; h.lostValue += Number(q.total || 0)
      const reason = reasonByQuote[q.id]
      if (reason) { taggedLost++; reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; if (reason === 'price') h.priceLosses++ }
    }
  }
  const decided = won + lost
  const byHood = Object.values(hoods)
    .map(h => ({ ...h, winRate: h.decided ? h.won / h.decided : 0 }))
    .sort((a, b) => b.priceLosses - a.priceLosses || b.lost - a.lost)

  return { decided, won, lost, winRate: decided ? won / decided : 0, taggedLost, untaggedLost: lost - taggedLost, reasonCounts, byHood }
}

// One-tap capture (idempotent upsert) from the Grow Win/Loss panel.
export async function recordQuoteOutcome(
  supabase: SupabaseClient,
  quoteId: string,
  reason: LossReason,
  opts?: { detail?: string | null; competitorPrice?: number | null },
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  const { error } = await supabase.from('quote_outcomes').upsert(
    { user_id: user.id, quote_id: quoteId, reason, detail: opts?.detail ?? null, competitor_price: opts?.competitorPrice ?? null },
    { onConflict: 'user_id,quote_id' },
  )
  return error ? { ok: false, error: error.message } : { ok: true }
}

// What the Grow Win/Loss panel renders: the stats + the declined quotes to tag.
export interface LostQuoteRow { id: string; customer_name: string; address: string; total: number | null; created_at: string; reason: string | null }
export interface WinLossData { stats: WinLossStats; lostQuotes: LostQuoteRow[] }

export async function loadWinLoss(supabase: SupabaseClient): Promise<WinLossData> {
  const empty: WinLossData = { stats: { decided: 0, won: 0, lost: 0, winRate: 0, taggedLost: 0, untaggedLost: 0, reasonCounts: {}, byHood: [] }, lostQuotes: [] }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return empty
  const uid = user.id
  const [qRes, pRes, oRes] = await Promise.all([
    supabase.from('quotes').select('id, customer_name, address, total, status, property_id, created_at').eq('user_id', uid),
    supabase.from('properties').select('id, postal_code, city, neighborhood').eq('user_id', uid),
    supabase.from('quote_outcomes').select('quote_id, reason, detail, competitor_price').eq('user_id', uid),
  ])
  const quotes = (qRes.data as (WLQuote & { customer_name: string; address: string; created_at: string })[]) || []
  const props: Record<string, { postal_code: string | null; city: string | null; neighborhood: string | null }> = {}
  for (const p of (pRes.data as { id: string; postal_code: string | null; city: string | null; neighborhood: string | null }[]) || []) props[p.id] = p
  const outcomes = (oRes.data as QuoteOutcomeRow[]) || []
  const reasonByQuote: Record<string, string> = {}
  for (const o of outcomes) reasonByQuote[o.quote_id] = o.reason

  const hoodOf = (q: WLQuote) => {
    const p = q.property_id ? props[q.property_id] : undefined
    return p ? neighborhoodKey(p.postal_code, p.city, p.neighborhood) : 'Unknown'
  }
  const stats = analyzeWinLoss(quotes, outcomes, hoodOf)
  const lostQuotes: LostQuoteRow[] = quotes
    .filter(q => q.status === 'declined')
    .map(q => ({ id: q.id, customer_name: q.customer_name, address: q.address, total: q.total, created_at: q.created_at, reason: reasonByQuote[q.id] ?? null }))
    .sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || b.created_at.localeCompare(a.created_at)) // untagged first
  return { stats, lostQuotes }
}
