import type { SupabaseClient } from '@supabase/supabase-js'
import { getAutomationHealth, getDailyBrief } from './tools'
import type { OperatorDashboardSnapshot } from './types'

type SB = SupabaseClient<any>

function sentence(cards: Awaited<ReturnType<typeof getDailyBrief>>['cards'], when: 'morning' | 'afternoon') {
  if (!cards.length) return when === 'morning'
    ? 'No evidence-backed urgent work is showing in the Phase 1 checks. Review today’s schedule before starting the day.'
    : 'No evidence-backed urgent work is showing in the Phase 1 checks. Review completed work and any new inbound messages before wrapping up.'
  const high = cards.filter(c => c.priority === 'urgent' || c.priority === 'high')
  const money = cards.filter(c => c.category === 'money').reduce((s,c) => s + (c.financial_value ?? 0), 0)
  if (when === 'morning') return `${high.length} high-priority items need review. ${money > 0 ? `$${money.toFixed(2)} of balances appear in the evidence set; not all are overdue. ` : ''}Start with customer-risk items before routine data cleanup.`
  return `${cards.length} items remain in the evidence-backed queue. Re-check new inbound messages, accepted work without linked visits, and any confirmed due balances before the day ends.`
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
    automationWarning: automation.warnings[0] ?? null,
    recentRuns: history.error ? [] : ((history.data ?? []) as OperatorDashboardSnapshot['recentRuns']),
    historyAvailable: !history.error,
  }
}
