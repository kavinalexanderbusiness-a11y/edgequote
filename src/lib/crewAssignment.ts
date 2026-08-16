// ── THE assignment engine ────────────────────────────────────────────────────
// One question, one home: "who is coming to this visit, and are they real?"
//
// THE MODEL (jobs_one_assignee enforces it in the database, not here):
//   crew_id set        → a crew runs it; its CURRENT members resolve at read time
//   technician_id set  → exactly this person runs it
//   both null          → unassigned
//   both set           → impossible
// Two columns, one meaning. There is no join table, no second assignment path,
// and no "assigned_to" free-text anywhere — a visit that could answer "who" in
// two ways is a visit whose crew and whose office disagree.
//
// ⭐⭐ THE LINE THIS FILE EXISTS TO HOLD — three different things, never merged:
//   PLANNED     jobs.crew_size — how many bodies the work needs (a number)
//   ASSIGNED    this file — who is expected to turn up (a crew, or a person)
//   ACTUAL      job_work_sessions.workers / time_entries — who really worked
// Crew membership is not attendance, and an assignment is not a timesheet.
// `expectedWorkers` answers a question about the FUTURE and must never be used
// to describe a visit that already happened — `crewIdAsOf` is that door.
//
// ⛔ NO INDUSTRY KNOWLEDGE LIVES HERE. A crew is a set of people with a name;
// whether they mow, install furnaces, clean, paint or wire a panel changes
// nothing in this file. There is no service-name branch, keyword table or
// trade-specific default anywhere in it, and verify:crews fails the build if one
// appears.

import type { Crew, Technician, Job, CrewMembershipChange } from '@/types'

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type AssigneeKind = 'crew' | 'person' | 'unassigned'

export type Assignee =
  | { kind: 'crew'; crewId: string }
  | { kind: 'person'; technicianId: string }
  | { kind: 'unassigned' }

export const UNASSIGNED: Assignee = { kind: 'unassigned' }

/** The two columns that carry assignment. Anything less than both is a partial
 *  read: a row with crew_id null is only unassigned if technician_id is too. */
export type AssignableVisit = Pick<Job, 'crew_id' | 'technician_id'>

export function assigneeOf(visit: AssignableVisit | null | undefined): Assignee {
  if (visit?.crew_id) return { kind: 'crew', crewId: visit.crew_id }
  if (visit?.technician_id) return { kind: 'person', technicianId: visit.technician_id }
  return UNASSIGNED
}

export function sameAssignee(a: Assignee, b: Assignee): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'crew' && b.kind === 'crew') return a.crewId === b.crewId
  if (a.kind === 'person' && b.kind === 'person') return a.technicianId === b.technicianId
  return true
}

/**
 * THE write shape. Every writer sends BOTH columns, always — that is what makes
 * "assign to Jane" clear the crew rather than leave a stale second answer behind
 * (the database would refuse it, and a refusal at save time is a bug the owner
 * has to decode).
 */
export function assigneeColumns(a: Assignee): { crew_id: string | null; technician_id: string | null } {
  return {
    crew_id: a.kind === 'crew' ? a.crewId : null,
    technician_id: a.kind === 'person' ? a.technicianId : null,
  }
}

// ── The chooser ──────────────────────────────────────────────────────────────
// "Assigned to: Unassigned · Crew A · Jane · Peter". Jane appearing under People
// while also being ON Crew A is not a duplicate — they are different answers,
// and the hint says which is which. What WOULD be a duplicate is listing her
// twice in one group, or letting a crew and a person both be picked at once.

export type AssignmentGroup = 'none' | 'crews' | 'people'

export interface AssignmentOption {
  /** Stable string for a <select> / radio value. Parse with parseAssigneeValue. */
  value: string
  assignee: Assignee
  label: string
  group: AssignmentGroup
  /** One line explaining what picking this MEANS. Null when nothing needs saying. */
  hint: string | null
  /** Deactivated crews and off-roster people can hold history but take no NEW work. */
  disabled: boolean
}

export function assigneeValue(a: Assignee): string {
  if (a.kind === 'crew') return `crew:${a.crewId}`
  if (a.kind === 'person') return `person:${a.technicianId}`
  return 'unassigned'
}

export function parseAssigneeValue(value: string): Assignee {
  if (value.startsWith('crew:')) return { kind: 'crew', crewId: value.slice(5) }
  if (value.startsWith('person:')) return { kind: 'person', technicianId: value.slice(7) }
  return UNASSIGNED
}

export interface ChooserContext {
  crews: Crew[]
  technicians: Technician[]
  /** The visit's current assignee, so a historical one still renders as chosen
   *  even when the crew was since deactivated or the person left. */
  current?: Assignee
}

const activeMemberOf = (t: Technician) => t.is_active && !t.archived_at

export function assignmentOptions(ctx: ChooserContext): AssignmentOption[] {
  const current = ctx.current ?? UNASSIGNED
  const roster = ctx.technicians.filter(activeMemberOf)
  const memberCount = (crewId: string) => roster.filter(t => t.crew_id === crewId).length
  const crewName = (crewId: string) => ctx.crews.find(c => c.id === crewId)?.name ?? null

  const out: AssignmentOption[] = [{
    value: 'unassigned',
    assignee: UNASSIGNED,
    label: 'Unassigned',
    group: 'none',
    hint: 'Nobody sees this on their phone until it has a crew or a person.',
    disabled: false,
  }]

  const crews = [...ctx.crews].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  for (const c of crews) {
    const isCurrent = current.kind === 'crew' && current.crewId === c.id
    // A deactivated crew stays listed ONLY while it holds this visit, so the
    // chooser can show the truth rather than a blank where a name should be.
    if (!c.is_active && !isCurrent) continue
    const n = memberCount(c.id)
    out.push({
      value: assigneeValue({ kind: 'crew', crewId: c.id }),
      assignee: { kind: 'crew', crewId: c.id },
      label: c.name,
      group: 'crews',
      hint: !c.is_active ? 'Deactivated — takes no new work'
        : n === 0 ? 'Nobody is on this crew yet'
        : `Everyone on ${c.name} — ${n} ${n === 1 ? 'person' : 'people'}`,
      disabled: !c.is_active,
    })
  }

  const people = [...ctx.technicians].sort((a, b) => a.name.localeCompare(b.name))
  for (const t of people) {
    const isCurrent = current.kind === 'person' && current.technicianId === t.id
    if (!activeMemberOf(t) && !isCurrent) continue
    const theirCrew = t.crew_id ? crewName(t.crew_id) : null
    out.push({
      value: assigneeValue({ kind: 'person', technicianId: t.id }),
      assignee: { kind: 'person', technicianId: t.id },
      label: t.name,
      group: 'people',
      // The sentence that stops "Jane" and "Crew A" reading as the same choice.
      hint: !activeMemberOf(t) ? 'No longer on the roster'
        : theirCrew ? `On ${theirCrew} — assigning here sends it to ${t.name} alone`
        : null,
      disabled: !activeMemberOf(t),
    })
  }
  return out
}

export const ASSIGNMENT_GROUP_LABELS: Record<AssignmentGroup, string> = {
  none: '',
  crews: 'Crews',
  people: 'Individuals',
}

// ── Resolution: who is expected, and is that real? ───────────────────────────

export type AssignmentIssue =
  /** Points at a crew this tenant no longer has (or that was not loaded). */
  | 'crew_unknown'
  /** A deactivated crew still holds upcoming work. */
  | 'crew_inactive'
  /** Assigned to a crew nobody is on — the work reaches no phone. */
  | 'crew_empty'
  /** Assigned to somebody archived or switched off. */
  | 'person_off_roster'

export interface ResolvedAssignment {
  kind: AssigneeKind
  /** What to put on screen. Never a bare id, never an empty string. */
  label: string
  crew: Crew | null
  person: Technician | null
  /** The people expected to turn up: a crew's current members, or the one
   *  person. Empty when unassigned — or when the roster could not be read, in
   *  which case `known` is false and this array claims nothing. */
  expected: Technician[]
  /** How many are expected. ⭐ null = the roster could not be read. NEVER 0. */
  expectedCount: number | null
  known: boolean
  issue: AssignmentIssue | null
}

export interface ResolveContext {
  crews: Crew[]
  technicians: Technician[]
  /** False when the roster/crew read failed. An unreadable roster claims
   *  nothing — the same contract dayFitLoad holds for workersByDate. */
  rosterKnown?: boolean
}

/**
 * Who is expected at a visit that has not happened yet.
 *
 * ⛔ Do NOT use this to describe a visit in the past. A crew's membership is a
 * live fact; asking it about last Tuesday gives today's answer with yesterday's
 * date on it — exactly the falsification `crewIdAsOf` exists to prevent.
 */
export function expectedWorkers(visit: AssignableVisit, ctx: ResolveContext): ResolvedAssignment {
  const known = ctx.rosterKnown !== false
  const a = assigneeOf(visit)
  const base = { crew: null, person: null, expected: [] as Technician[], expectedCount: known ? 0 : null, known }

  if (a.kind === 'unassigned') {
    return { ...base, kind: 'unassigned', label: 'Unassigned', issue: null }
  }

  if (a.kind === 'crew') {
    const crew = ctx.crews.find(c => c.id === a.crewId) ?? null
    if (!known) {
      return { ...base, kind: 'crew', label: crew?.name ?? 'Crew', crew, expectedCount: null, issue: null }
    }
    if (!crew) {
      return { ...base, kind: 'crew', label: 'Unknown crew', expectedCount: null, issue: 'crew_unknown' }
    }
    const members = ctx.technicians.filter(t => activeMemberOf(t) && t.crew_id === crew.id)
      .sort((x, y) => x.name.localeCompare(y.name))
    return {
      kind: 'crew', label: crew.name, crew, person: null,
      expected: members, expectedCount: members.length, known: true,
      issue: !crew.is_active ? 'crew_inactive' : members.length === 0 ? 'crew_empty' : null,
    }
  }

  const person = ctx.technicians.find(t => t.id === a.technicianId) ?? null
  if (!known) {
    return { ...base, kind: 'person', label: person?.name ?? 'Assigned person', person, expectedCount: null, issue: null }
  }
  if (!person) {
    return { ...base, kind: 'person', label: 'Unknown person', expectedCount: null, issue: 'person_off_roster' }
  }
  const on = activeMemberOf(person)
  return {
    kind: 'person', label: person.name, crew: null, person,
    expected: on ? [person] : [], expectedCount: on ? 1 : 0, known: true,
    issue: on ? null : 'person_off_roster',
  }
}

export const ASSIGNMENT_ISSUE_TEXT: Record<AssignmentIssue, string> = {
  crew_unknown: 'assigned to a crew that no longer exists',
  crew_inactive: 'assigned to a deactivated crew',
  crew_empty: 'assigned to a crew with nobody on it',
  person_off_roster: 'assigned to someone no longer on the roster',
}

// ⛔ THERE IS NO STAFFING VERDICT HERE, DELIBERATELY.
//
// "Is this day staffed?" has ONE home: lib/dayPlan, which raises
// crew_understaffed / worker_unavailable / availability_assumed from Session
// 67's per-worker availability states, and which Session 65 extended to judge a
// personally-assigned visit against THAT person rather than their crew.
//
// This file briefly grew a rival that answered the same question from a
// different input (crew membership + PTO rows). It was removed rather than
// merged: two engines warning about one day is how a board starts contradicting
// itself, and the surviving one knows about weekly patterns and approval status
// that this one never did (engineering-principles §3 — one engine per
// responsibility).
//
// What stays here is the question dayPlan does NOT answer: given an assignment,
// WHO is expected, and is that assignment still real. dayPlan consumes
// availability; this consumes assignment. Keep it that way.

// ── Membership as of a moment ────────────────────────────────────────────────
// ⭐⭐ THE POINT OF THE WHOLE HISTORY TABLE: someone joining Crew A tomorrow must
// not become, retroactively, a person who worked Crew A's job last Tuesday.
//
// `known: false` is a real and common answer — the log starts when the feature
// shipped, so any moment before that has no recorded membership. A caller that
// needs a number anyway may fall back to today's crew, but it must SAY it is
// doing so; silently treating "unrecorded" as "unchanged" is the falsification.

export interface MembershipAsOf {
  crewId: string | null
  /** True only when a recorded change at or before `whenISO` was found. */
  known: boolean
}

export function crewIdAsOf(
  history: CrewMembershipChange[],
  technicianId: string,
  whenISO: string,
): MembershipAsOf {
  const when = Date.parse(whenISO)
  if (Number.isNaN(when)) return { crewId: null, known: false }
  let best: CrewMembershipChange | null = null
  for (const h of history) {
    if (h.technician_id !== technicianId) continue
    const at = Date.parse(h.changed_at)
    if (Number.isNaN(at) || at > when) continue
    if (!best || at > Date.parse(best.changed_at)) best = h
  }
  return best ? { crewId: best.crew_id, known: true } : { crewId: null, known: false }
}

/** Everyone recorded as being on a crew at a moment. Same honesty: people with
 *  no recorded membership by then are absent, not assumed present. */
export function crewMembersAsOf(
  history: CrewMembershipChange[],
  crewId: string,
  whenISO: string,
): string[] {
  const ids = new Set(history.map(h => h.technician_id))
  const out: string[] = []
  for (const id of ids) {
    const m = crewIdAsOf(history, id, whenISO)
    if (m.known && m.crewId === crewId) out.push(id)
  }
  return out.sort()
}

/** How the membership answer was reached — for surfaces that must disclose it. */
export type MembershipBasis = 'recorded' | 'current_roster'

export function describeMembershipBasis(basis: MembershipBasis): string {
  return basis === 'recorded'
    ? 'crew membership as recorded at the time'
    : 'today’s crew membership — no record exists for that date'
}
