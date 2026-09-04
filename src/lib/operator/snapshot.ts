import type { SupabaseClient } from '@supabase/supabase-js'
import { getAutomationHealth, getDailyBrief } from './tools'
import type { OperatorActionCard, OperatorDashboardSnapshot } from './types'

type SB = SupabaseClient<any>

const CAD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

// The brief SENTENCES only state what the card set actually shows. Within the
// money category, priority IS the overdue split (listOutstandingBalances sets
// high = canonically overdue, normal = merely remaining) — so the sentence can
// say how much is overdue instead of guessing "not all are overdue".
function sentence(cards: OperatorActionCard[], when: 'morning' | 'afternoon') {
  if (!cards.length) return when === 'morning'
    ? 'No evidence-backed urgent work is showing in the Phase 1 checks. Review today’s schedule before starting the day.'
    : 'No evidence-backed urgent work is showing in the Phase 1 checks. Review completed work and any new inbound messages before wrapping up.'
  const high = cards.filter(c => c.priority === 'urgent' || c.priority === 'high')
  const moneyCards = cards.filter(c => c.category === 'money')
  const overdueSum = moneyCards.filter(c => c.priority === 'urgent' || c.priority === 'high').reduce((s, c) => s + (c.financial_value ?? 0), 0)
  const remainingSum = moneyCards.reduce((s, c) => s + (c.financial_value ?? 0), 0) - overdueSum
  const moneyClause = moneyCards.length
    ? `${overdueSum > 0 ? `${CAD.format(overdueSum)} is canonically overdue` : 'No balance is canonically overdue'}${remainingSum > 0 ? `; ${CAD.format(remainingSum)} more remains without evidence of being due now` : ''}. `
    : ''
  if (when === 'morning') return `${high.length} high-priority items need review. ${moneyClause}Start with customer-risk items before routine data cleanup.`
  return `${cards.length} items remain in the evidence-backed queue. ${moneyClause}Re-check new inbound messages and accepted work without linked visits before the day ends.`
}

export async function loadOperatorSnapshot(sb: SB, userId: string): Promise<OperatorDashboardSnapshot> {
  const [brief, automation, history] = await Promise.all([
    getDailyBrief(sb, userId),
    getAutomationHealth(sb, userId),
    sb.from('operator_runs').select('id,question,status,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(8),
  ])
  return {
    morning: sentence(brief.cards, 'morning'),
    afternoon: sentence(brief.cards, 'afternoon'),
    cards: brief.cards.slice(0, 12),
    totalCards: brief.cards.length,
    // ⛔ Did any tool fail to read? A failed tool returns cards:[] plus a
    // warning, so the brief can be SILENTLY INCOMPLETE — the card list looks
    // shorter, nothing says why. The banner must not assert completeness over
    // that, so it is told rather than left to guess.
    readIncomplete: brief.warnings.length > 0,
    // The brief's own read stamp — not "now" — so the age shown is the age of
    // the evidence, even if this snapshot is assembled later.
    generated_at: brief.generated_at,
    automationWarning: automation.warnings[0] ?? null,
    recentRuns: history.error ? [] : ((history.data ?? []) as OperatorDashboardSnapshot['recentRuns']),
    historyAvailable: !history.error,
  }
}
