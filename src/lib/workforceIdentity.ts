// ── Workforce identity — "are these two rows the same person?" ───────────────
// THE one place that answers it for the roster, and it answers WARNING ONLY.
//
// ⛔⛔ THIS MODULE CANNOT MERGE, DELETE OR ARCHIVE ANYTHING, AND THAT IS THE
// POINT. It is pure: rows in, findings out. There is no write, no Supabase
// client, no id-rewriting helper, and nothing that moves a row from one
// technician to another. `technicians.archived_at`'s own schema comment says why
// — a technician's `time_entries`, `wage_history` and `pto_entries` are
// STATUTORY records kept for years, and a delete used to CASCADE all three away.
// A duplicate detector that could act would be one bug away from doing exactly
// that, to the record of what somebody was paid.
//
// ── ⛔⛔ THE RULE THAT SHAPES EVERYTHING: NEVER BY NAME ALONE ────────────────
// Two workers called "John Smith" are two workers until something else says
// otherwise. A name is not an identifier — it is the least reliable field on the
// row, it is routinely shared, and in a workforce it is often the ONLY thing a
// hurried entry has. So a name match is not evidence here and never produces a
// duplicate verdict. It appears in exactly one place: the `uncheckable` list,
// which says "we cannot tell these apart" and names the identifier that would
// settle it. That list carries no verdict and must never be read as one.
//
// ── The evidence, and why the ladder is shaped this way ─────────────────────
// This is a WORKFORCE, not a customer book, and the difference matters:
//
//   auth_account   Two rows pointing at the same auth user ARE one person. The
//                  database already said so — the same human logs into both.
//                  Nothing else earns CONFIRMED.
//   shared_invite  One invitation, two rows. Machine-generated per row, so there
//                  is no innocent reason for two to carry it.
//   shared_email   Personal in practice, but a business CAN run one inbox.
//   shared_phone   ⚠️ THE WEAKEST, and weaker here than it would be for a
//                  customer: crews are routinely issued ONE company handset, so
//                  two workers legitimately sharing a number is an ordinary
//                  thing rather than a red flag.
//
// ⭐ A rehire — one archived row, one active row, employment windows that do not
// overlap — is CORROBORATION, never evidence. It cannot create a finding on its
// own; it can only firm up one that contact evidence already raised. "They left
// and came back" is a story that fits two different people just as well.
//
// ⛔ Cross-tenant pairs are refused structurally, not filtered late: two rows
// with different `user_id` are never compared at all.

import { normalizeEmail, normalizePhone, phoneMatches } from '@/lib/customers'

/** The columns identity actually needs. Deliberately narrow — a caller passing
 *  whole rows still works, and nothing here can reach a field it should not. */
export interface WorkerIdentityLike {
  id: string
  user_id: string
  name: string
  email?: string | null
  phone?: string | null
  /** The stable account link. THE only thing that earns CONFIRMED. */
  auth_user_id?: string | null
  invite_code?: string | null
  is_active?: boolean | null
  archived_at?: string | null
  hired_on?: string | null
  ended_on?: string | null
}

export type EvidenceKind = 'auth_account' | 'shared_invite' | 'shared_email' | 'shared_phone'

/** ⭐ Ordered strongest-first. The UI reads this order; the ladder below reads it
 *  too, so adding a kind in the wrong place cannot silently re-rank a finding. */
export const EVIDENCE_STRENGTH: readonly EvidenceKind[] = [
  'auth_account', 'shared_invite', 'shared_email', 'shared_phone',
]

export interface Evidence {
  kind: EvidenceKind
  /** What the owner reads. Never the raw value of a contact field — the roster
   *  screen already shows those, and a warning banner is not the place to
   *  reprint somebody's phone number. */
  detail: string
}

export type IdentityConfidence = 'confirmed' | 'probable' | 'possible'

export interface DuplicateWorkerFinding {
  /** The two technician ids, ordered so the pair is stable across reloads. */
  aId: string
  bId: string
  confidence: IdentityConfidence
  evidence: Evidence[]
  /** One archived, one active, non-overlapping employment. Corroboration only. */
  rehireShaped: boolean
  /** Sentences for the owner, in the order they should be read. */
  reasons: string[]
}

/** A pair we could NOT judge. ⛔ Carries no verdict, and the word "duplicate"
 *  must never be attached to it — that is the whole reason it is a separate
 *  type rather than a low-confidence finding. */
export interface UncheckablePair {
  aId: string
  bId: string
  /** What they share — a name, which is not evidence. */
  sharedName: string
  /** Which identifiers are absent on one or both rows, so the owner can fix it. */
  missing: Array<'account' | 'email' | 'phone'>
}

// ── Evidence gathering ───────────────────────────────────────────────────────

const norm = (s: string | null | undefined) => String(s ?? '').trim()

/**
 * What links these two rows, if anything. Pure and order-independent.
 *
 * ⛔ Every comparison requires BOTH sides to be non-empty. Two rows that both
 * have no email do not "share an email" — that is the empty-string trap, and it
 * would silently pair every under-filled row in the roster with every other.
 */
export function identityEvidence(a: WorkerIdentityLike, b: WorkerIdentityLike): Evidence[] {
  // ⛔ Different tenants are not comparable. Asserted here as well as at the
  // caller, because a pure function that can be handed two arrays is a pure
  // function that will eventually be handed the wrong two.
  if (a.user_id !== b.user_id) return []
  if (a.id === b.id) return []

  const out: Evidence[] = []

  const authA = norm(a.auth_user_id), authB = norm(b.auth_user_id)
  if (authA && authB && authA === authB) {
    out.push({ kind: 'auth_account', detail: 'Both records are linked to the same sign-in account.' })
  }

  const invA = norm(a.invite_code), invB = norm(b.invite_code)
  if (invA && invB && invA === invB) {
    out.push({ kind: 'shared_invite', detail: 'Both records came from the same invitation.' })
  }

  const emA = normalizeEmail(a.email), emB = normalizeEmail(b.email)
  if (emA && emB && emA === emB) {
    out.push({ kind: 'shared_email', detail: 'Both records use the same email address.' })
  }

  // THE canonical phone rule (lib/customers.phoneMatches) — last-ten-digits with
  // a 7-digit floor. Reused rather than re-implemented: two doors deciding "same
  // person?" differently is how one person becomes two records, which is the
  // exact defect this file exists to surface.
  if (normalizePhone(a.phone) && normalizePhone(b.phone) && phoneMatches(a.phone, b.phone)) {
    out.push({ kind: 'shared_phone', detail: 'Both records use the same phone number.' })
  }

  return out.sort((x, y) => EVIDENCE_STRENGTH.indexOf(x.kind) - EVIDENCE_STRENGTH.indexOf(y.kind))
}

/**
 * ⭐ Is this pair shaped like a rehire — one archived, one active, and employment
 * windows that do not overlap?
 *
 * ⛔ CORROBORATION, NEVER EVIDENCE. It cannot raise a finding on its own, because
 * "somebody left and somebody else started" describes two different people
 * perfectly well. It only firms up a finding that contact evidence already made.
 *
 * ⚠️ Missing dates answer FALSE, not true. An unknown employment window is not a
 * non-overlapping one.
 */
export function isRehireShaped(a: WorkerIdentityLike, b: WorkerIdentityLike): boolean {
  const archived = (w: WorkerIdentityLike) => !!norm(w.archived_at) || w.is_active === false
  const oneOfEach = archived(a) !== archived(b)
  if (!oneOfEach) return false

  const past = archived(a) ? a : b
  const present = archived(a) ? b : a
  const left = norm(past.ended_on)
  const started = norm(present.hired_on)
  if (!left || !started) return false
  return left <= started
}

/**
 * The ladder. ⭐ Read the comment block at the top of this file for WHY each rung
 * sits where it does — the short version is that a workforce legitimately shares
 * phones and sometimes inboxes, so only the account link is definitive.
 *
 * Returns null when nothing links the pair, which is the ordinary case and must
 * stay cheap to express.
 */
export function confidenceFor(evidence: readonly Evidence[], rehireShaped: boolean): IdentityConfidence | null {
  if (!evidence.length) return null
  const kinds = new Set(evidence.map(e => e.kind))

  // ⭐ The database already answered. Nothing below can raise or lower this.
  if (kinds.has('auth_account')) return 'confirmed'

  // Two independent channels agreeing is a different claim from one channel
  // twice — a shared handset explains one, not both.
  if (kinds.size >= 2) return 'probable'

  if (kinds.has('shared_invite')) return 'probable'
  if (kinds.has('shared_email')) return rehireShaped ? 'probable' : 'possible'
  // ⚠️ A shared company handset is ordinary. On its own this is the weakest
  // finding the module can make, and it stays 'possible' even when the rehire
  // shape fits — because the rehire shape fits two colleagues sharing a phone too.
  if (kinds.has('shared_phone')) return 'possible'
  return 'possible'
}

// ── The detector ─────────────────────────────────────────────────────────────

export interface IdentityScanResult {
  /** Pairs with real evidence. Warnings — never actions. */
  findings: DuplicateWorkerFinding[]
  /**
   * Pairs sharing only a NAME. ⛔ NOT duplicates and never described as such —
   * they are the roster telling the owner it lacks the identifier that would
   * settle the question.
   */
  uncheckable: UncheckablePair[]
}

const NAME_KEY = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Scan a roster for identity collisions.
 *
 * ⛔ Every pair is same-tenant by construction: rows are bucketed by `user_id`
 * before any comparison happens, so a cross-tenant pair is not filtered out
 * late — it is never formed.
 *
 * O(n²) within a tenant, which is correct for a roster (tens of people, not
 * thousands) and keeps the rule readable. If a roster ever grows past that, the
 * fix is to bucket by evidence key — NOT to relax the rule.
 */
export function scanWorkerIdentities(workers: readonly WorkerIdentityLike[]): IdentityScanResult {
  const byTenant = new Map<string, WorkerIdentityLike[]>()
  for (const w of workers ?? []) {
    if (!w?.id || !w.user_id) continue
    const list = byTenant.get(w.user_id) ?? []
    list.push(w)
    byTenant.set(w.user_id, list)
  }

  const findings: DuplicateWorkerFinding[] = []
  const uncheckable: UncheckablePair[] = []

  for (const list of byTenant.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        const evidence = identityEvidence(a, b)
        const rehireShaped = isRehireShaped(a, b)
        const confidence = confidenceFor(evidence, rehireShaped)

        if (confidence) {
          const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
          findings.push({
            aId, bId, confidence, evidence, rehireShaped,
            reasons: [
              ...evidence.map(e => e.detail),
              ...(rehireShaped
                ? ['One record is archived and the other is active, and their employment dates do not overlap — consistent with a rehire.']
                : []),
            ],
          })
          continue
        }

        // ⛔ NO EVIDENCE. A shared name lands here and nowhere else. This is not
        // a duplicate finding and the type system keeps it from becoming one.
        if (NAME_KEY(a.name) && NAME_KEY(a.name) === NAME_KEY(b.name)) {
          const missing: UncheckablePair['missing'] = []
          if (!norm(a.auth_user_id) || !norm(b.auth_user_id)) missing.push('account')
          if (!normalizeEmail(a.email) || !normalizeEmail(b.email)) missing.push('email')
          if (!normalizePhone(a.phone) || !normalizePhone(b.phone)) missing.push('phone')
          const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
          uncheckable.push({ aId, bId, sharedName: a.name.trim(), missing })
        }
      }
    }
  }

  // Strongest first, so the one that might really matter is not below six maybes.
  const rank: Record<IdentityConfidence, number> = { confirmed: 0, probable: 1, possible: 2 }
  findings.sort((x, y) => rank[x.confidence] - rank[y.confidence])
  return { findings, uncheckable }
}

// ── History — what is at stake, never what to do about it ────────────────────

/**
 * Rows that point at one technician. ⭐ The surface shows these so the owner can
 * see what a merge WOULD have touched — which is precisely why this phase offers
 * no merge. `payRunLines` and `wageHistory` are what somebody was paid; a tool
 * that moved them would be rewriting a financial record.
 */
export interface WorkerHistoryCounts {
  timeEntries: number
  payRunLines: number
  wageHistory: number
  ptoEntries: number
  jobs: number
  crewHistory: number
}

export const EMPTY_HISTORY: WorkerHistoryCounts = {
  timeEntries: 0, payRunLines: 0, wageHistory: 0, ptoEntries: 0, jobs: 0, crewHistory: 0,
}

/** ⭐ The subset that is a STATUTORY record. Named separately because "has any
 *  history" and "has money history" are different questions and the second one
 *  is the one that must never be automated over. */
export function hasPayrollHistory(c: WorkerHistoryCounts | null | undefined): boolean {
  if (!c) return false
  return c.payRunLines > 0 || c.wageHistory > 0 || c.timeEntries > 0
}

export function totalHistoryRows(c: WorkerHistoryCounts | null | undefined): number {
  if (!c) return 0
  return c.timeEntries + c.payRunLines + c.wageHistory + c.ptoEntries + c.jobs + c.crewHistory
}

/**
 * ⛔⛔ THE TRIPWIRE. Always returns a reason — there is no argument for which it
 * returns null — because THIS PHASE HAS NO MERGE. It exists so that a future
 * phase which adds one has to delete this function deliberately rather than
 * discover the rule was never written down.
 *
 * Both sides carrying payroll history is the case that must stay manual even
 * then: merging would move somebody's paid hours onto another row, and the
 * ledger it came from has already been filed.
 */
export function mergeBlockedReason(
  a: WorkerHistoryCounts | null | undefined,
  b: WorkerHistoryCounts | null | undefined,
): string {
  if (hasPayrollHistory(a) && hasPayrollHistory(b)) {
    return 'Both records carry paid time or wage history. Combining them would move a statutory payroll record from one person to another — that has to be done by a person who can check it.'
  }
  return 'Combining worker records is not available. Review them and decide what should happen; nothing here changes a record on its own.'
}

// ── Words, kept beside the rules they describe ───────────────────────────────

export const CONFIDENCE_LABEL: Record<IdentityConfidence, string> = {
  confirmed: 'Same sign-in account',
  probable: 'Likely the same person',
  possible: 'Might be the same person',
}

/** ⭐ Says what the confidence MEANS and, for the weak rungs, what would settle
 *  it — so the owner reads an action, not an accusation. */
export const CONFIDENCE_MEANING: Record<IdentityConfidence, string> = {
  confirmed: 'These two records are linked to the same login, so they are the same person.',
  probable: 'Two separate details match. Worth checking.',
  possible: 'One detail matches, and it is one that colleagues sometimes share — a company phone, for example.',
}

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  auth_account: 'Same sign-in account',
  shared_invite: 'Same invitation',
  shared_email: 'Same email',
  shared_phone: 'Same phone',
}

/** What the owner would have to fill in for us to answer at all. */
export function missingIdentifierSentence(missing: UncheckablePair['missing']): string {
  if (!missing.length) return 'These records share a name but nothing else to compare.'
  const words = missing.map(m => (m === 'account' ? 'a linked sign-in' : m === 'email' ? 'an email address' : 'a phone number'))
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
  return `These records share a name, which is not enough to tell whether they are one person. Adding ${list} to both would answer it.`
}
