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
  /** True when at least one tool could not complete its read, so the card set
   *  is incomplete in a way the card list alone does not show. */
  readIncomplete: boolean
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

// ── Owner-facing error text ─────────────────────────────────────────────────
// Two kinds of string end up in front of an owner as "why this didn't work":
// a Postgres/PostgREST message, and `automation_sweeps.error` — which is the
// PLATFORM-WIDE sweep table, so its text is written by a job that knows nothing
// about this tenant. Neither is authored for an owner's eyes and both can carry
// record identifiers: Postgres puts the offending values straight into the
// message ("Key (user_id)=(<uuid>) already exists"), and a platform error can
// embed a job's ids or a URL.
//
// The goal is NOT silence — "something failed" with no detail is a support
// ticket. It is a SHORT, BOUNDED hint with identifier-shaped runs replaced, so
// the owner still learns the shape of the problem ("relation does not exist",
// "permission denied") without reading anyone's record ids.
const ID_PATTERNS: Array<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\bhttps?:\/\/\S+/gi, '[url]'],
  // Postgres constraint detail: Key (col)=(value) — the value half is the leak.
  [/=\([^)]*\)/g, '=([value])'],
  [/\b\d{6,}\b/g, '[number]'],
]
const ERROR_HINT_MAX = 140

export function safeErrorHint(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : ''
  let out = stripInvisibles(text).replace(/\s+/g, ' ').trim()
  if (!out) return 'no further detail is available'
  for (const [re, to] of ID_PATTERNS) out = out.replace(re, to)
  return out.length > ERROR_HINT_MAX ? `${out.slice(0, ERROR_HINT_MAX - 1).trimEnd()}…` : out
}

// ── The GLOBAL sweep failure: a closed category, never the text ─────────────
// `automation_sweeps` has no tenant column. Its `error` is written by the
// platform-wide job, so the text belongs to whatever tenant's work happened to
// break — and it reaches THIS owner's card summary, warnings and answer.
//
// ⛔⛔ REDACTION IS THE WRONG TOOL HERE, and this is the correction that matters:
// safeErrorHint is a DENYLIST over identifier SHAPES (uuid, email, url,
// `=(value)`, long digit runs). Business content has none of those shapes, and
// Postgres routinely puts the offending value in the PRIMARY message, which
// never takes the `=(value)` form:
//     invalid input syntax for type numeric: "Bob's Landscaping Ltd"
//     relation "acme_window_cleaning_archive" does not exist
// Both survive redaction intact. A denylist cannot be a guarantee over
// free-form text from another tenant.
//
// ⭐ So this returns a value the PRODUCT authored, chosen from a closed set. The
// input is only ever *classified*; not one character of it is ever returned. The
// untouched string still goes to the server log, so diagnosis loses nothing.
//
// ⚠️ Deliberately NOT used for tools.ts `fail()`. That path reports failures
// reading the OWNER'S OWN tenant data through an RLS-scoped client — the
// owner's information shown to the owner, with no cross-tenant channel — and a
// specific hint there is genuinely useful. Widening this would destroy real
// signal to fix a leak that does not exist on that path.
export const SWEEP_FAILURE_CATEGORIES = [
  'a permission problem',
  'a missing database object',
  'a timeout',
  'a connection problem',
  'an unexpected error',
] as const
export type SweepFailureCategory = typeof SWEEP_FAILURE_CATEGORIES[number]

export function sweepFailureCategory(raw: unknown): SweepFailureCategory {
  const t = (typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '').toLowerCase()
  if (/permission|denied|not authori|forbidden|row-level security|policy/.test(t)) return 'a permission problem'
  if (/does not exist|undefined table|undefined column|undefined function|no such|not found/.test(t)) return 'a missing database object'
  if (/timeout|timed out|canceling statement|deadline/.test(t)) return 'a timeout'
  if (/econn|socket|network|unreachable|getaddrinfo|connection|dns/.test(t)) return 'a connection problem'
  return 'an unexpected error'
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
