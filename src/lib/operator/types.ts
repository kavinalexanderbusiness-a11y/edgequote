export const OPERATOR_TOOL_NAMES = [
  'get_daily_brief',
  'list_genuine_unanswered_leads',
  'list_quote_followups_due',
  'list_accepted_unscheduled_work',
  'list_outstanding_balances',
  'list_jobs_missing_costs',
  'get_customer_timeline',
  'get_quote_details',
  'get_invoice_details',
  'get_schedule_availability',
  'get_worker_availability',
  'get_automation_health',
  'get_attribution_completeness',
] as const

export type OperatorToolName = typeof OPERATOR_TOOL_NAMES[number]
export type OperatorPriority = 'urgent' | 'high' | 'normal' | 'low'
export type OperatorCategory = 'messages' | 'quotes' | 'schedule' | 'money' | 'costs' | 'automation' | 'attribution' | 'customer' | 'data_quality'

export interface OperatorEvidence {
  record_type: string
  record_id: string
  label: string
  detail: string
  relevant_date?: string | null
  amount?: number | null
}

export interface OperatorActionCard {
  id: string
  priority: OperatorPriority
  category: OperatorCategory
  title: string
  summary: string
  why_it_matters: string
  evidence: OperatorEvidence[]
  financial_value: number | null
  recommended_action: string
  requires_approval: boolean
  customer_contact_required: boolean
  record_references: Array<{ type: string; id: string; href?: string }>
  data_quality_warnings: string[]
}

export interface OperatorToolResult {
  tool: OperatorToolName
  generated_at: string
  summary: string
  cards: OperatorActionCard[]
  records?: unknown[]
  warnings: string[]
}

export interface OperatorContextRefs {
  customer_id?: string
  quote_id?: string
  invoice_id?: string
}

export interface OperatorAnswer {
  answer: string
  cards: OperatorActionCard[]
  tools_used: OperatorToolName[]
  generated_at: string
  read_only: true
  warnings: string[]
}

export interface OperatorDashboardSnapshot {
  morning: string
  afternoon: string
  cards: OperatorActionCard[]
  /** Full pre-cap count, so the UI can say "showing 12 of N" honestly. */
  totalCards: number
  /** When the evidence behind these cards was actually READ (ISO). The page is
   *  force-dynamic, so this is fresh on load — but the tab can then sit open
   *  for hours, and money cards that old must not read as current. */
  generated_at: string
  automationWarning: string | null
  recentRuns: Array<{ id: string; question: string | null; status: string; created_at: string }>
  historyAvailable: boolean
}

// ── Format-control stripping ────────────────────────────────────────────────
// Invisible and bidirectional format characters have no legitimate place in
// operator text, and customer-controlled values (names, titles) flow into card
// titles the owner reads to make money decisions. Two distinct attacks:
//
//   1. EVASION — a zero-width character hidden inside a verb ("s<U+200B>ent")
//      walks past the word-boundary regex in claimsExecutedAction, so a
//      fabricated "I have sent it" ships as if it were a safe answer.
//   2. SPOOFING — a bidi override (U+202E) or isolate (U+2066) reverses the
//      visual order of everything after it. Operator titles are MACHINE-
//      COMPOSED from a customer value plus a money amount ("Bob — $10.00
//      overdue"), so one character inside the name can garble or reorder the
//      amount the owner is reading.
//
// Both are answered the same way: remove the characters. Nothing legitimate is
// lost — these are formatting directives, never content. Kept here in types (a
// leaf module) so engine and tools can both use it without an import cycle.
// The class is written with explicit escapes on purpose: literal invisible
// characters in source are unreviewable in a diff.
const FORMAT_CONTROLS = new RegExp(
  '[\\u00AD\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]', 'g')

export function stripInvisibles(s: string): string {
  return s.replace(FORMAT_CONTROLS, '')
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function validateContextRefs(raw: unknown): OperatorContextRefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const out: OperatorContextRefs = {}
  if (isUuid(o.customer_id)) out.customer_id = o.customer_id
  if (isUuid(o.quote_id)) out.quote_id = o.quote_id
  if (isUuid(o.invoice_id)) out.invoice_id = o.invoice_id
  return out
}
