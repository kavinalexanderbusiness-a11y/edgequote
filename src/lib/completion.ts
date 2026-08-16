// ── Proof of work: what a finished visit LEFT BEHIND ─────────────────────────
// A visit that is `completed` already answers WHETHER and WHEN: `status` plus
// `completed_at`, stamped in exactly one place (lib/jobStatus.completionPatch).
// ⛔ Nothing here is a second completion state. This file adds no status, no
// second timestamp and no "completion record" table — only the two words-fields
// a completed visit may carry, and the pure helpers that read them back.
//
// ⭐ THE VISIBILITY BOUNDARY, which is the whole reason there are TWO fields:
//
//   jobs.completion_summary  → CUSTOMER-VISIBLE. "What was done." It is written
//                              to be read by the person who paid for it, and the
//                              portal renders it verbatim.
//   jobs.completion_issue    → INTERNAL. "What needs attention." Never leaves
//                              the business: not in get_portal_data's payload,
//                              not in any portal component, not in a PDF.
//
// The boundary is enforced at the SOURCE, not at the render: `completion_issue`
// is not selected by the portal RPC, so a future portal component cannot leak it
// even by accident — there is nothing in the payload to leak. `verify:completion`
// fails the build if either half of that drifts.
//
// ⚠️ WHY THE SPLIT EXISTS AT ALL — the defect it fixes. `jobs.notes` is authored
// as an INTERNAL instruction to whoever does the work: the job form calls it
// "notes for whoever does the work", crew_day ships it to the worker's phone
// labelled "the access note (gate code, where to park)". It was ALSO selected by
// get_portal_data and rendered verbatim in the customer's visit history. So the
// only note field a finished visit had was internal by authorship and public by
// render — 49 of 78 completed visits in production carried one, including
// "dog removal, keep gate closed". A field cannot be both. Hence: `notes` stays
// internal (and leaves the portal payload), and the customer gets a field that
// was written FOR them.
//
// Photos are NOT re-invented here. `job_photos` + the `job-photos` bucket are
// THE catalogue and THE storage (lib/photos for the owner, /api/crew/photos for
// a crew session), and `PhotoKind` has carried before/after/general since long
// before this file. Evidence reads that catalogue; it never opens a second one.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, JobPhoto } from '@/types'

// Long enough for "Mowed, trimmed, edged, blew off the drive. Front bed weeded."
// Short enough that nobody mistakes this for a report form. The cap is applied
// on the way IN (normalize truncates) so a paste of an essay can't be silently
// rejected by the database.
export const COMPLETION_SUMMARY_MAX = 500
export const COMPLETION_ISSUE_MAX = 500

/** The two fields as they live on the row. */
export interface CompletionRecord {
  completion_summary: string | null
  completion_issue: string | null
}

/** What a human typed, before it is trusted. */
export interface CompletionRecordInput {
  summary?: string | null
  issue?: string | null
}

// Whitespace is not a record. An empty box and a box holding three spaces mean
// the same thing — "nothing was said" — and both must land as NULL, or the
// portal renders an empty quote block and the owner's board claims a note that
// says nothing. Same rule the settings/contact seams already apply.
function clean(v: string | null | undefined, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max).trimEnd() : t
}

export function normalizeCompletionRecord(input: CompletionRecordInput): CompletionRecord {
  return {
    completion_summary: clean(input.summary, COMPLETION_SUMMARY_MAX),
    completion_issue: clean(input.issue, COMPLETION_ISSUE_MAX),
  }
}

/** Is this record any different from what the row already holds? A save that
 *  changes nothing must not be sent — it would bump `updated_at` and so break
 *  the optimistic-concurrency guard every other queued job patch rides on. */
export function completionRecordChanged(
  job: Partial<CompletionRecord>, next: CompletionRecord,
): boolean {
  return (job.completion_summary ?? null) !== next.completion_summary
    || (job.completion_issue ?? null) !== next.completion_issue
}

// ── Reading the record back ──────────────────────────────────────────────────

export interface CompletionEvidence {
  /** The canonical completion stamp. null = this visit is not finished, and
   *  NOTHING below may be presented as proof of a completed visit. */
  completedAt: string | null
  summary: string | null
  issue: string | null
  photos: number
  before: number
  after: number
  minutes: number | null
  /** Did this completion leave anything behind at all? Drives "no proof yet"
   *  copy — distinct from "not completed", which `completedAt` answers. */
  hasProof: boolean
}

export function completionEvidence(
  job: Pick<Job, 'completed_at' | 'actual_minutes'> & Partial<CompletionRecord>,
  photos: Pick<JobPhoto, 'kind'>[] = [],
): CompletionEvidence {
  const summary = job.completion_summary ?? null
  const issue = job.completion_issue ?? null
  const before = photos.filter(p => p.kind === 'before').length
  const after = photos.filter(p => p.kind === 'after').length
  return {
    completedAt: job.completed_at ?? null,
    summary,
    issue,
    photos: photos.length,
    before,
    after,
    // A visit with no check-in has null minutes, never 0 — a fabricated zero is
    // a 100%-margin job (the rule completionPatch already holds the line on).
    minutes: job.actual_minutes ?? null,
    hasProof: !!summary || !!issue || photos.length > 0,
  }
}

/** The compact one-liner: "2 photos · 45 min". Returns '' when there is nothing
 *  true to say — never "0 photos", which reads as an accusation rather than a
 *  fact about a visit that simply didn't need any. */
export function evidenceLine(ev: CompletionEvidence): string {
  const parts: string[] = []
  if (ev.photos > 0) parts.push(`${ev.photos} photo${ev.photos === 1 ? '' : 's'}`)
  if (ev.minutes != null && ev.minutes > 0) parts.push(`${ev.minutes} min`)
  return parts.join(' · ')
}

// ── The write ────────────────────────────────────────────────────────────────
// ⛔ This writes the two record columns and NOTHING else. It never touches
// status, completed_at, actual_minutes, price or any invoice: recording what
// happened is not a lifecycle transition, and a completion that has already been
// billed must not be re-billed because somebody added a photo caption an hour
// later. `verify:completion` pins that ("no invoice engine reachable from here").
//
// The owner writes the row directly — RLS scopes it to their own jobs, which is
// the tenancy boundary for every other owner-side write in the app. A crew
// session cannot: it holds NO table grants at all (crew-mode's rule), so its
// path is the typed DEFINER RPC in lib/crewJob.

export interface CompletionSaveResult {
  ok: boolean
  error?: string
  /** true when the input matched the row and no write was needed. */
  unchanged?: boolean
  /**
   * ⭐ ACCEPTED, BUT NOT YET ON THE SERVER — the words are durably queued on the
   * device and will replay when there is signal (lib/field/fieldWrite).
   *
   * `ok: true` with `pending: true` is deliberately a distinct state from a
   * plain success, and callers MUST NOT collapse them: the office cannot read a
   * note that is still on a phone, so a confirmation that said "Saved" for both
   * would be the exact false-success this contract forbids. Never set by the
   * owner's direct write, which is only ever ok or not.
   */
  pending?: boolean
}

export async function saveCompletionRecord(
  supabase: SupabaseClient,
  job: Pick<Job, 'id'> & Partial<CompletionRecord>,
  record: CompletionRecord,
): Promise<CompletionSaveResult> {
  // Re-normalized even though the sheet already did: normalize is idempotent
  // (a trimmed, capped string passes through unchanged), and this is the last
  // gate before the database — a future caller that skips the UI still cannot
  // write whitespace or an unbounded string.
  const next = normalizeCompletionRecord({
    summary: record.completion_summary, issue: record.completion_issue,
  })
  if (!completionRecordChanged(job, next)) return { ok: true, unchanged: true }
  // `.select('id')` is not optional politeness: a PostgREST update that matches
  // ZERO rows returns success with no error, so an update that RLS silently
  // dropped would report "Saved" for a write that never happened — the exact
  // false-Saved shape the business_settings seam was bitten by. Asking for the
  // row back makes "nothing was written" observable.
  const { data, error } = await supabase
    .from('jobs').update(next).eq('id', job.id).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'That visit could not be found — refresh and try again.' }
  }
  return { ok: true }
}
