'use client'

import Link from 'next/link'
import type { RunRecord } from '@/lib/automation/types'
import type { Tone } from '@/lib/tone'

// ── Automation Center — the vocabulary its screens speak ─────────────────────
// The Automation Center is two READ views over the engine's two tables: the index
// lists what the engine did across the book, `subject/[type]/[id]` follows one
// subject through it. They must put the SAME words on the same row. A run that
// reads "Watching — not acting yet" on one screen and "suppressed (mode_suggest)"
// on the other is two answers to one question — which is the exact drift the
// engine's design (one ledger, one registry, no re-derivation) exists to prevent.
// So the labels, the payload reader and the subject naming live here once and both
// screens import them. Nothing in this file writes, decides, or re-derives a
// condition: it puts words on values the engine already recorded.

// ── Row shapes ───────────────────────────────────────────────────────────────
// The columns BOTH screens select. `automation_runs.signal_id` is deliberately
// absent: the index page doesn't select it, so widening this interface would make
// its `as RunRow[]` cast a lie about a field that isn't in the response. The
// subject timeline — which does select it — extends this instead.
export interface SignalRow {
  id: string
  signal: string
  subject_type: string
  subject_id: string
  detected_on: string
  payload: Record<string, unknown> | null
  created_at: string
}

export interface RunRow {
  id: string
  rule_key: string
  subject_type: string | null
  subject_id: string | null
  evaluated_on: string
  decision: 'fired' | 'suppressed'
  suppressed_reason: Reason | null
  created_at: string
}

// ── The engine's vocabulary, rendered ────────────────────────────────────────
// Presentation only. These maps put WORDS on values the engine defines; they never
// decide anything. Keying them off the engine's own unions means a new suppression
// reason is a TYPE ERROR here rather than a silently unlabelled row (the same
// reason lib/comms/reach has no `default:` case).

export type Reason = NonNullable<RunRecord['suppressedReason']>

export const REASON_META: Record<Reason, { label: string; tone: Tone; hint: string }> = {
  mode_suggest: {
    label: 'Watching — not acting yet',
    tone: 'info',
    hint: 'The condition was real and the rule saw it. It has no authority to act yet — by design.',
  },
  mode_off: {
    label: 'No authority to act',
    tone: 'neutral',
    hint: 'The rule is off — or it had authority but no dispatcher exists to carry the action out, which the engine records the same way rather than claiming a send that could never happen.',
  },
  quiet_hours: {
    label: 'Outside the send window',
    tone: 'neutral',
    hint: 'Correct message, wrong hour. It was held rather than sent outside the rule’s send window.',
  },
  frequency_cap: {
    label: 'Frequency cap',
    tone: 'warn',
    hint: 'Already contacted often enough — or the history could not be counted, which the engine treats as a cap hit rather than a reason to send.',
  },
  no_consent: {
    label: 'No consent',
    tone: 'warn',
    hint: 'The customer is not opted in on a channel this action would use.',
  },
  deduped: {
    label: 'Already handled',
    tone: 'neutral',
    hint: 'An action already exists for this exact dedupe key.',
  },
  signal_absent: {
    label: 'Signal gone',
    tone: 'neutral',
    hint: 'The condition stopped being true before the rule acted.',
  },
}

// Owner-facing names for the detectors the sweep writes. Falls back to the raw key
// — a signal this page has never heard of should still render honestly, not vanish.
const SIGNAL_LABELS: Record<string, string> = {
  recurring_ran_out: 'Recurring series ran out',
  churn_risk: 'Drifting past cadence',
}
export const signalLabel = (k: string) => SIGNAL_LABELS[k] ?? k

// ── Subjects ─────────────────────────────────────────────────────────────────
// The subject is polymorphic — (subject_type, subject_id) — and there is NO foreign
// key from subject_id to customers, deliberately: the ledger outlives the row it
// describes. So a name is a best-effort lookup that must degrade, never throw.

export function subjectName(type: string | null, id: string | null, names: Record<string, string>): string {
  if (!id) return '—'
  if (type === 'customer') return names[id] ?? 'Unknown customer'
  // A type this build has no lookup for (quotes/invoices/properties are anticipated
  // by the schema) still identifies itself rather than rendering blank.
  return `${type ?? 'subject'} ${id.slice(0, 8)}`
}

export const subjectHref = (type: string, id: string) =>
  `/dashboard/automation/subject/${encodeURIComponent(type)}/${encodeURIComponent(id)}`

/** The subject cell in both ledger tables. Links to that subject's timeline when
 *  the route can actually be built. `automation_runs.subject_type` is NULLABLE, so
 *  a run can carry an id with no type — there is no honest URL for that (inventing
 *  'customer' would be a guess the ledger never made), so it renders as plain text. */
export function SubjectLink({ type, id, names }: {
  type: string | null
  id: string | null
  names: Record<string, string>
}) {
  const label = subjectName(type, id, names)
  if (!id || !type) return <span className="text-ink-muted">{label}</span>
  return (
    <Link
      href={subjectHref(type, id)}
      className="text-ink-muted hover:text-accent-text transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {label}
    </Link>
  )
}

// ── Payload ──────────────────────────────────────────────────────────────────
/** The detector's own detail, read back. The payload is loose by design (each
 *  signal owns its shape), so this reads the keys the sweep actually writes and
 *  silently ignores the rest — an unknown key is a detector this build predates,
 *  not an error. */
export function payloadBits(p: Record<string, unknown> | null): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = []
  if (!p) return out
  const push = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== '') out.push({ k, v: String(v) }) }
  push('days since', p.daysSince)
  push('cadence', p.cadenceDays != null ? `${p.cadenceDays}d` : null)
  // The RAW freq the sweep resolved `cadence` from, beside the resolved days — the
  // two together are what expose the known sweep-vs-screens cadence disagreement
  // (see the long comment in api/cron/signals): the sweep reads the raw freq, while
  // customerHealth / revenueIntelligence still compose it through the LOSSY
  // effectiveFreq, so for a custom interval they disagree about the same customer.
  //
  // Rendered from the KEY's presence, not its value, because null is the finding.
  // `freq` is null for exactly the custom intervals this is meant to reveal
  // (cadenceDays then derives the days from interval_count instead of a standard
  // bucket) — so skipping null the way `push` does would hide the only case worth
  // looking at. 'none' is the literal truth for both null causes: no standard freq
  // bucket was recorded.
  if ('cadence' in p) out.push({ k: 'freq', v: p.cadence == null ? 'none' : String(p.cadence) })
  push('level', p.level)
  push('ratio', p.ratio)
  push('overdue', p.overdueDays != null ? `${p.overdueDays}d` : null)
  push('last service', p.lastServiceDate)
  if (p.urgent === true) out.push({ k: 'urgent', v: 'yes' })
  return out
}

/** The payload, as chips. Shared so a detector's detail reads identically in the
 *  signals table and in the timeline. */
export function PayloadChips({ payload }: { payload: Record<string, unknown> | null }) {
  const bits = payloadBits(payload)
  if (bits.length === 0) return <span className="text-xs text-ink-faint">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {bits.map(b => (
        <span key={b.k} className="text-[10px] rounded-full border border-border bg-surface px-2 py-0.5 text-ink-muted whitespace-nowrap">
          {b.k} <span className="text-ink tabular-nums">{b.v}</span>
        </span>
      ))}
    </div>
  )
}
