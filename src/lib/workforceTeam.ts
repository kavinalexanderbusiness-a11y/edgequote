// ── The team, as the owner talks about it ────────────────────────────────────
// EdgeQuote's tables say `technicians`. Owners say "my guys", "the crew",
// "who's on today". The database name is load-bearing (renaming it would touch
// time_entries, wage_history, pay_run_lines, payroll replay and the crew-access
// RPCs, for a word), so the translation happens HERE, once, and every surface
// reads it. Nothing below knows about SQL.
//
// Pure functions only — the grouping and the status derivation are the parts
// worth asserting without a browser.

import type { Technician, Crew } from '@/types'
import { crewAccessState, type CrewAccessRow, type CrewAccessState } from '@/lib/crewInvite'

/** THE word. Changing it here changes it everywhere the team is spoken about. */
export const EMPLOYEE = 'employee'
export const EMPLOYEE_PLURAL = 'employees'

/**
 * What a name becomes when the roster no longer holds the person a record
 * belongs to — a pay line, a shift, a labour cost for somebody who has left and
 * was loaded WITHOUT `includeArchived`.
 *
 * One constant because it was four copies of a string literal (laborCost ×2,
 * payroll, payRun, workforce ×2) plus a fifth in verify-workforce asserting it.
 * Renaming the visible wording broke that guard, which is exactly what a magic
 * string does. Anything that needs to recognise the placeholder imports it.
 *
 * ⚠️ Seeing this on a pay stub is a BUG, not a state: it means the surface
 * loaded the roster without archived people. verify:workforce pins the flag at
 * every money call site for that reason.
 */
export const FORMER_EMPLOYEE_NAME = 'Former employee'

/** Whether somebody is currently on the roster and working for you.
 *  Two switches, two meanings, and the copy has to keep them apart:
 *    is_active  = "not working right now" — a temporary pause, reversible in a tap
 *    archived_at= "no longer employed here" — off the roster, records kept
 */
export type EmployeeStanding = 'working' | 'paused' | 'former'

export function employeeStanding(t: Pick<Technician, 'is_active' | 'archived_at'>): EmployeeStanding {
  if (t.archived_at) return 'former'
  return t.is_active ? 'working' : 'paused'
}

export const STANDING_LABEL: Record<EmployeeStanding, string> = {
  working: 'Active',
  paused: 'Inactive',
  former: 'Removed',
}

// ── One row of the team list ─────────────────────────────────────────────────
export interface TeamMember {
  id: string
  name: string
  /** Their job title, if they have one. Never a permission — access is separate. */
  role: string | null
  phone: string | null
  email: string | null
  crewId: string | null
  crewName: string | null
  standing: EmployeeStanding
  /** No access / Invite pending / Active / Disabled — the SAME state machine the
   *  invite panel uses, so the list badge and the panel can never disagree. */
  access: CrewAccessState
  /** The address their login uses, when they have one. */
  accessEmail: string | null
  hasWage: boolean
  tech: Technician
}

export function toTeamMember(
  t: Technician,
  crews: Crew[],
  accessRow?: CrewAccessRow | null,
): TeamMember {
  const crew = t.crew_id ? crews.find(c => c.id === t.crew_id) ?? null : null
  return {
    id: t.id,
    name: t.name,
    role: t.role?.trim() || null,
    phone: t.phone?.trim() || null,
    email: t.email?.trim() || null,
    crewId: t.crew_id ?? null,
    crewName: crew?.name ?? null,
    standing: employeeStanding(t),
    access: crewAccessState({
      isActive: t.is_active && !t.archived_at,
      linked: !!t.auth_user_id,
      lastSignInAt: accessRow?.last_sign_in_at ?? accessRow?.lastSignInAt ?? null,
      inviteSentAt: accessRow?.invite_sent_at ?? accessRow?.inviteSentAt ?? t.invite_sent_at ?? null,
      hasCode: accessRow?.has_code ?? accessRow?.hasCode
        ?? (!!t.invite_code && (!t.invite_expires_at || new Date(t.invite_expires_at) > new Date())),
    }),
    accessEmail: accessRow?.email ?? null,
    hasWage: t.hourly_wage != null,
    tech: t,
  }
}

// ── Grouping ─────────────────────────────────────────────────────────────────
// Inactive people were mixed in with working ones on every surface, which makes
// "who works here" a question you have to READ rather than see. Working first,
// alphabetically; paused collected underneath; former hidden unless asked for.
export interface TeamGroups {
  working: TeamMember[]
  paused: TeamMember[]
  former: TeamMember[]
}

export function groupTeam(members: TeamMember[]): TeamGroups {
  const byName = (a: TeamMember, b: TeamMember) => a.name.localeCompare(b.name)
  return {
    working: members.filter(m => m.standing === 'working').sort(byName),
    paused: members.filter(m => m.standing === 'paused').sort(byName),
    former: members.filter(m => m.standing === 'former').sort(byName),
  }
}

/** Search across the things an owner would actually type: a name, a crew, a
 *  phone number they're looking at on their own screen. */
export function searchTeam(members: TeamMember[], query: string): TeamMember[] {
  const q = query.trim().toLowerCase()
  if (!q) return members
  // Phone matching compares DIGITS ONLY, so "(587) 555-0134" is found by
  // 5875550134 however either side is punctuated. Guarded on the query actually
  // containing a digit: an empty needle makes String.includes() true for
  // everyone, so a text search would otherwise match every person with a number.
  const digits = q.replace(/\D/g, '')
  return members.filter(m =>
    m.name.toLowerCase().includes(q)
    || (m.role ?? '').toLowerCase().includes(q)
    || (m.crewName ?? '').toLowerCase().includes(q)
    || (m.email ?? '').toLowerCase().includes(q)
    || (m.accessEmail ?? '').toLowerCase().includes(q)
    || (digits !== '' && (m.phone ?? '').replace(/\D/g, '').includes(digits)),
  )
}

// ── What still needs doing ───────────────────────────────────────────────────
// The setup a half-added employee is missing, in the order it matters. This is
// what turns "Add employee → … → active and ready" from a hope into something
// the screen can actually tell you.
export interface TeamGap { kind: 'crew' | 'wage' | 'access'; label: string }

export function memberGaps(m: TeamMember): TeamGap[] {
  if (m.standing !== 'working') return []
  const gaps: TeamGap[] = []
  if (!m.crewId) gaps.push({ kind: 'crew', label: 'No crew' })
  // A wage of null makes their hours cost $0 — the shift records, the money
  // silently doesn't. Worth naming on the row, not just in a banner.
  if (!m.hasWage) gaps.push({ kind: 'wage', label: 'No wage' })
  if (m.access === 'none') gaps.push({ kind: 'access', label: 'No app access' })
  return gaps
}

/** The one-line answer to "is my team set up?" — null when nothing is missing. */
export function teamSetupSummary(groups: TeamGroups): string | null {
  const w = groups.working
  if (w.length === 0) return null
  const noCrew = w.filter(m => !m.crewId).length
  const noWage = w.filter(m => !m.hasWage).length
  const noAccess = w.filter(m => m.access === 'none').length
  const bits: string[] = []
  if (noCrew) bits.push(`${noCrew} not on a crew`)
  if (noWage) bits.push(`${noWage} with no wage`)
  if (noAccess) bits.push(`${noAccess} without app access`)
  return bits.length ? bits.join(' · ') : null
}
