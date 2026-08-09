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
// the boundary is RLS. A crew session that talked its way past every check here
// still reads exactly the rows the `jobs: crew reads assigned` policy allows —
// zero customers, zero invoices, zero quotes, zero settings — and can still only
// move a visit's status, because a BEFORE UPDATE trigger rejects every other
// column. Deleting this file would leak navigation, not data.

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
  status: 'scheduled' | 'in_progress' | 'completed'
  started_at: string | null
  completed_at: string | null
  actual_minutes: number | null
  on_my_way_at: string | null
  route_order: number | null
  updated_at: string
  notes: string | null
  customer: { name: string; phone: string | null } | null
  property: { address: string | null; lat: number | null; lng: number | null } | null
}

export interface CrewDay {
  date: string
  me: { id: string; name: string; role: string | null; status: string } | null
  crew: { id: string; name: string; color: string; day_start: string | null } | null
  business: { name: string | null; phone: string | null; work_start_time: string | null } | null
  teammates: { id: string; name: string; role: string | null }[]
  stops: CrewStop[]
}

export interface CrewDayCount { date: string; stops: number; done: number; minutes: number }

/** One day's work. `null` means "you are not an active crew member" — which is
 *  what a revoked employee gets, and is deliberately distinct from a day with
 *  no stops. Callers must not collapse the two: "you no longer have access" and
 *  "nothing booked today" are opposite messages. */
export async function loadCrewDay(supabase: SupabaseClient, dateISO: string): Promise<CrewDay | null> {
  const { data, error } = await supabase.rpc('crew_day', { p_date: dateISO })
  if (error || !data) return null
  return data as CrewDay
}

export async function loadCrewUpcoming(
  supabase: SupabaseClient, fromISO: string, days = 7,
): Promise<CrewDayCount[] | null> {
  const { data, error } = await supabase.rpc('crew_upcoming', { p_from: fromISO, p_days: days })
  if (error || !data) return null
  return data as CrewDayCount[]
}

// ── The next stop ────────────────────────────────────────────────────────────
// Whatever is on the clock now, else the first one still to do — in the order
// crew_day already returned them (the owner's manual route_order first, then
// committed time, then creation: the SAME precedence lib/crews.laneSequence
// uses for the dispatch lane). The RPC does the ordering so the worker's list
// and the dispatcher's lane can never disagree about what is next.
export function nextCrewStop(stops: CrewStop[]): CrewStop | undefined {
  const open = stops.filter(s => s.status === 'scheduled' || s.status === 'in_progress')
  return open.find(s => s.status === 'in_progress') ?? open[0]
}

/** What the one big button does at this stage of a visit. */
export function stopPrimaryAction(stop: CrewStop | undefined): 'start' | 'complete' | null {
  if (!stop) return null
  return stop.status === 'in_progress' ? 'complete' : 'start'
}
