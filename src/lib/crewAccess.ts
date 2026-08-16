// ── Crew Mode: THE access seam ───────────────────────────────────────────────
// One question — "who is this signed-in person, and which half of the app are
// they allowed in?" — with exactly one answer, and that answer comes from the
// DATABASE, never from a prop, a cookie or a client-side flag.
//
// `current_app_role()` is a STABLE SECURITY DEFINER function in Postgres
// (RUN-2026-08-07-crew-mode.sql). It reports:
//   'owner' — this auth user has a business_settings row (the same signal the
//             dashboard layout already uses to recognise a set-up account)
//   'crew'  — this auth user is linked to a technician who is ACTIVE and NOT
//             ARCHIVED on somebody's roster
//   'none'  — signed out, or signed in with neither
// Owner wins when an account is somehow both, so an owner can never be demoted
// into Crew Mode by a stray link.
//
// ⚠️ THIS IS NOT THE SECURITY BOUNDARY. Route gating is UX and defence in depth;
// the boundary is the RPC surface. A crew session has NO table grants at all —
// a crew RLS policy on `jobs` was written, tested over real HTTP, and REMOVED,
// because RLS is row-level: granting the row granted `price` with it. Everything
// a worker reads arrives through crew_day/crew_upcoming (column-limited DEFINER
// RPCs) and everything they write goes through crew_set_visit_status (typed
// parameters). Deleting this file would leak navigation, not data.

import type { SupabaseClient } from '@supabase/supabase-js'

export type AppRole = 'owner' | 'crew' | 'none'

/** Ask the database. Any failure resolves to 'none' — the least-privileged
 *  answer — so a transient error can never hand somebody the wrong half of the
 *  app. Callers treat 'none' as "send them somewhere safe", never as an error
 *  to swallow silently. */
export async function resolveAppRole(supabase: SupabaseClient): Promise<AppRole> {
  const { data, error } = await supabase.rpc('current_app_role')
  if (error) return 'none'
  return data === 'owner' || data === 'crew' ? data : 'none'
}

// ── Route ownership ──────────────────────────────────────────────────────────
// Crew Mode lives entirely under /crew. Everything under /dashboard is the
// owner's CRM — quoting, invoicing, payments, accounting, settings, every
// customer — and a crew member has no business on any of it.
export const CREW_ROOT = '/crew'
export const OWNER_ROOT = '/dashboard'
/** Where an employee redeems a join code. Deliberately OUTSIDE the crew gate:
 *  the whole point is that the person is signed in but not yet linked. */
export const CREW_JOIN = '/crew/join'
/** Where an owner-provisioned employee sets their first password. Reached from a
 *  one-time token in the query string, BEFORE any session exists — so it has to
 *  be reachable signed-out, and the gate must not bounce it to /login. Holding
 *  no valid token, the page does nothing except say the link has expired. */
export const CREW_WELCOME = '/crew/welcome'

/**
 * THE landing destination for a role, as data.
 *
 * Three surfaces used to hardcode `/dashboard` after a successful sign-in — the
 * login form, the root page, and the end of a password reset — and leaned on the
 * middleware to bounce a worker from there to /crew. It does bounce them, so
 * nobody was stranded; what they got was a round trip through the owner's URL,
 * which on a slow phone is a flash of the wrong product before the right one.
 * The brief asks for a worker to land in worker mode, not to arrive there second.
 *
 * `none` still resolves to the owner root: an account with no role may be a
 * brand-new OWNER mid-signup, and /dashboard is what runs the first-run /setup
 * flow. Sending them to /crew instead would strand a real owner. A worker in
 * that state is redirected on to /crew/join by routeFor, which is the pre-existing
 * behaviour and the one place that decision belongs.
 */
export function landingFor(role: AppRole): string {
  return role === 'crew' ? CREW_ROOT : OWNER_ROOT
}

export function isOwnerPath(pathname: string): boolean {
  return pathname === OWNER_ROOT || pathname.startsWith(OWNER_ROOT + '/')
}
export function isCrewPath(pathname: string): boolean {
  return pathname === CREW_ROOT || pathname.startsWith(CREW_ROOT + '/')
}
export function isJoinPath(pathname: string): boolean {
  return pathname === CREW_JOIN || pathname.startsWith(CREW_JOIN + '/')
}
export function isWelcomePath(pathname: string): boolean {
  return pathname === CREW_WELCOME || pathname.startsWith(CREW_WELCOME + '/')
}

/**
 * THE redirect table, as data. Returns the path to send this request to, or
 * null to let it through. Pure — so the same rules can be asserted in a test
 * without a browser, a session or a database.
 *
 *   signed out          → /login for anything private
 *   owner  in /crew     → /dashboard   (their tools are the full ones)
 *   crew   in /dashboard→ /crew        (never the CRM)
 *   none   in /crew     → /crew/join   (signed in, not linked yet: enter a code)
 *   none   in /dashboard→ let through  (a brand-new OWNER: the dashboard layout
 *                                       sends them to /setup, which is the
 *                                       existing first-run path and must not be
 *                                       intercepted here)
 *
 * /crew/join is always allowed to a signed-in user — it is how 'none' stops
 * being 'none', so gating it behind a role would be a deadlock.
 *
 * /crew/welcome is allowed to EVERYONE, signed in or not. An owner-provisioned
 * employee arrives there holding a one-time token and no session at all; a gate
 * that bounced them to /login would make the invite impossible to accept. The
 * page itself is inert without a valid token — it can only set a password for
 * whoever the token already identifies.
 */
export function routeFor(role: AppRole, pathname: string, signedIn: boolean): string | null {
  if (isWelcomePath(pathname)) return null
  const isPrivate = isOwnerPath(pathname) || isCrewPath(pathname)
  if (!signedIn) return isPrivate ? '/login' : null
  if (isJoinPath(pathname)) return role === 'owner' ? OWNER_ROOT : null
  if (isCrewPath(pathname)) {
    if (role === 'crew') return null
    return role === 'owner' ? OWNER_ROOT : CREW_JOIN
  }
  if (isOwnerPath(pathname)) {
    return role === 'crew' ? CREW_ROOT : null
  }
  // Signed in and landing on /login: owners and 'none' go to the dashboard (the
  // pre-existing behaviour, and the /setup path for a new account); crew go to
  // their own home.
  if (pathname === '/login') return role === 'crew' ? CREW_ROOT : OWNER_ROOT
  return null
}

// ── The crew's day, as the RPC returns it ────────────────────────────────────
// A column-limited read (crew_day) rather than table access, because RLS is
// row-level: a crew SELECT policy on `customers` would also hand over consent
// flags, notes and lifetime value, and one on `technicians` would hand over
// teammates' wages. What a worker needs is a name, a phone number and an
// address — so that is exactly what crosses the wire.

export interface CrewStop {
  id: string
  title: string
  service_type: string | null
  scheduled_date: string
  start_time: string | null
  duration_minutes: number | null
  crew_size: number
  // 'cancelled' arrives too (since 2026-08-09): a visit the office cancels
  // mid-morning must MOVE to a visible cancelled line, not silently vanish
  // between refetches. It is display-only — nextCrewStop never picks it and
  // crew_set_visit_status refuses to touch it.
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
  started_at: string | null
  completed_at: string | null
  actual_minutes: number | null
  on_my_way_at: string | null
  route_order: number | null
  updated_at: string
  notes: string | null
  // Proof of work, so the completion sheet opens showing what is already
  // recorded rather than a blank box that would overwrite it (lib/completion).
  /** ⭐ CUSTOMER-VISIBLE — the words the customer reads in their portal. */
  completion_summary: string | null
  /** 🔒 INTERNAL — for the office. Shown to the worker who wrote it; never to a
   *  customer (it is not in get_portal_data's payload at all). */
  completion_issue: string | null
  customer: { name: string; phone: string | null } | null
  property: { address: string | null; lat: number | null; lng: number | null } | null
  /** Counts-only checklist summary (public.job_form_summary's shape): enough
   *  for "3 of 7 · 2 required open" on the card without shipping a single
   *  field. The full form loads only when the worker opens it
   *  (crew_job_forms) — the same load-on-tap contract as reference media.
   *  null = this visit carries no checklist at all. Absent on payloads from
   *  before the forms feature — treat undefined as null. */
  checklist?: {
    forms: number; items: number; done: number
    required: number; required_done: number; waived: boolean
  } | null
}

export interface CrewDay {
  date: string
  me: { id: string; name: string; role: string | null; status: string } | null
  crew: { id: string; name: string; color: string; day_start: string | null } | null
  business: { name: string | null; phone: string | null; work_start_time: string | null } | null
  teammates: { id: string; name: string; role: string | null }[]
  /** The manager's day-wide note from the dispatch board (gate codes, weather
   *  calls) and this crew's own note — the written instructions that used to
   *  render only on the one screen a worker cannot open. */
  day_note: string | null
  crew_note: string | null
  stops: CrewStop[]
}

export interface CrewDayCount { date: string; stops: number; done: number; minutes: number }

// ── Read results ─────────────────────────────────────────────────────────────
// THREE outcomes, and they must never be collapsed. supabase-js RESOLVES with
// { error } on a dead connection — it does not throw — so "the request failed"
// and "the RPC answered null" arrive on different fields of the same shape:
//   · error set   → we couldn't ASK. The only honest render is "couldn't load,
//                   retry" while keeping whatever was already on screen.
//   · data null   → the database ANSWERED: this auth user is not an active crew
//                   member. That is revocation, and it is the only time the
//                   "your access has been turned off" message may appear.
//   · data set    → the day, as truth.
// Folding error into null is how a worker in a dead zone gets told they were
// fired: the RPC never ran, null came back, and the revoked branch rendered.
// (The same class of bug as the portal's "flaky refetch = revoked token".)
export type CrewDayResult =
  | { kind: 'ok'; day: CrewDay }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string }

export async function loadCrewDay(supabase: SupabaseClient, dateISO: string): Promise<CrewDayResult> {
  const { data, error } = await supabase.rpc('crew_day', { p_date: dateISO })
  if (error) return { kind: 'error', message: error.message }
  if (!data) return { kind: 'revoked' }
  return { kind: 'ok', day: data as CrewDay }
}

export type CrewUpcomingResult =
  | { kind: 'ok'; days: CrewDayCount[] }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string }

export async function loadCrewUpcoming(
  supabase: SupabaseClient, fromISO: string, days = 7,
): Promise<CrewUpcomingResult> {
  const { data, error } = await supabase.rpc('crew_upcoming', { p_from: fromISO, p_days: days })
  if (error) return { kind: 'error', message: error.message }
  if (!data) return { kind: 'revoked' }
  return { kind: 'ok', days: data as CrewDayCount[] }
}

// ── The next stop ────────────────────────────────────────────────────────────
// Whatever is on the clock now, else the first one still to do — in the order
// crew_day already returned them (the owner's manual route_order first, then
// committed time, then creation: the SAME precedence lib/crews.laneSequence
// uses for the dispatch lane). The RPC does the ordering so the worker's list
// and the dispatcher's lane can never disagree about what is next.
export function nextCrewStop(stops: CrewStop[]): ActiveCrewStop | undefined {
  const open = stops.filter((s): s is ActiveCrewStop => s.status === 'scheduled' || s.status === 'in_progress')
  return open.find(s => s.status === 'in_progress') ?? open[0]
}

/** A stop a worker may act on — the type itself proves 'cancelled' can't reach
 *  a Start/Finish handler or the photo capture. */
export type ActiveCrewStop = CrewStop & { status: 'scheduled' | 'in_progress' | 'completed' }

/**
 * The day's stops split for display: real work (in route order, as returned)
 * and what the office CANCELLED. One partition with one definition, so the
 * header count, the card list and the cancelled line can never disagree about
 * which side a stop is on. Cancelled is server truth from the same payload —
 * there is deliberately no client-side "I saw this earlier" memory to drift.
 */
export function partitionCrewStops(stops: CrewStop[]): { active: ActiveCrewStop[]; cancelled: CrewStop[] } {
  const active: ActiveCrewStop[] = []
  const cancelled: CrewStop[] = []
  for (const s of stops) {
    if (s.status === 'cancelled') cancelled.push(s)
    else active.push(s as ActiveCrewStop)   // status checked on the line above
  }
  return { active, cancelled }
}

/** What the one big button does at this stage of a visit. */
export function stopPrimaryAction(stop: CrewStop | undefined): 'start' | 'complete' | null {
  if (!stop) return null
  return stop.status === 'in_progress' ? 'complete' : 'start'
}
