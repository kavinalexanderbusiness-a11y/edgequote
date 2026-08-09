// ── Crew invites: the shared contract ────────────────────────────────────────
// Pure helpers only — the provisioning itself needs the service role and lives
// in the server route (src/app/api/crew/invite/route.ts). Splitting them means
// the shapes and the rules can be asserted without a database, and means NOTHING
// in this file can ever pull an admin credential into a client bundle.

/** The four states the roster shows for one person's app access. Ordered by
 *  precedence: a disabled roster row cuts access no matter what else is true. */
export type CrewAccessState = 'disabled' | 'active' | 'invited' | 'none'

export interface CrewAccessFacts {
  /** technicians.is_active — the roster switch. */
  isActive: boolean
  /** technicians.auth_user_id is set. */
  linked: boolean
  /** auth.users.last_sign_in_at — has this person ever actually arrived? */
  lastSignInAt?: string | null
  /** technicians.invite_sent_at — a setup link was generated. */
  inviteSentAt?: string | null
  /** A one-time join code is outstanding and unexpired. */
  hasCode?: boolean
}

/**
 * THE state machine, in one place, so the roster badge and the guard agree.
 *
 *   disabled — the roster switch is off (or they were archived). Access is cut
 *              on every request regardless of any link, so this wins outright:
 *              showing "Active" for somebody who cannot get in is the one
 *              genuinely misleading answer.
 *   active   — linked AND has signed in at least once.
 *   invited  — linked but never arrived (a setup link is outstanding), or not
 *              linked but holding a live join code.
 *   none     — no login, nothing outstanding.
 */
export function crewAccessState(f: CrewAccessFacts): CrewAccessState {
  if (!f.isActive) return 'disabled'
  if (f.linked) return f.lastSignInAt ? 'active' : 'invited'
  return f.hasCode || f.inviteSentAt ? 'invited' : 'none'
}

/** One entry of `crew_access_states()` — keyed by technician id. The RPC exists
 *  because `last_sign_in_at` lives in auth.users, which no owner client can read
 *  and no RLS policy can expose without handing over the rest of that table. */
export interface CrewAccessRow {
  linked: boolean
  email: string | null
  lastSignInAt?: string | null
  inviteSentAt?: string | null
  hasCode?: boolean
  /** The RPC's snake_case wire names, kept so the map can be consumed raw. */
  last_sign_in_at?: string | null
  invite_sent_at?: string | null
  has_code?: boolean
}

/** Normalise the RPC's snake_case into the facts the state machine reads. */
export function accessFacts(tech: { is_active: boolean; archived_at?: string | null; auth_user_id?: string | null }, row?: CrewAccessRow | null): CrewAccessFacts {
  return {
    isActive: tech.is_active && !tech.archived_at,
    linked: !!tech.auth_user_id,
    lastSignInAt: row?.lastSignInAt ?? row?.last_sign_in_at ?? null,
    inviteSentAt: row?.inviteSentAt ?? row?.invite_sent_at ?? null,
    hasCode: row?.hasCode ?? row?.has_code ?? false,
  }
}

export const CREW_ACCESS_LABEL: Record<CrewAccessState, string> = {
  disabled: 'Disabled',
  active: 'Active',
  invited: 'Invite pending',
  none: 'No access',
}

// ── Email ────────────────────────────────────────────────────────────────────
// Normalised once, here, because it is the key the Admin API looks an account up
// by: "Sam@Example.com " and "sam@example.com" must not be able to create two
// accounts for one person.
export function normalizeInviteEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Deliberately permissive — the authority on whether an address is real is
 *  Supabase (which rejects non-deliverable domains outright). This only catches
 *  the typo that would otherwise cost a round trip. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(email)
}

// ── The setup link ───────────────────────────────────────────────────────────
// We build our OWN url around Supabase's `hashed_token` rather than using the
// `action_link` it also returns. Two reasons, both practical:
//
//  1. action_link's `redirect_to` must be on the project's Redirect URLs
//     allow-list in the Supabase dashboard, or it silently falls back to
//     SITE_URL. The whole point of this feature is that the owner never has to
//     open that dashboard.
//  2. action_link lands with the session in the URL FRAGMENT, which the server
//     cannot see — so middleware would bounce the employee to /login before the
//     page ever ran. A token in the query string is verified by the page itself
//     (supabase.auth.verifyOtp), which works the same on every browser.
export const CREW_WELCOME_PATH = '/crew/welcome'

export function buildSetupUrl(appOrigin: string, hashedToken: string): string {
  const base = appOrigin.replace(/\/$/, '')
  return `${base}${CREW_WELCOME_PATH}?token=${encodeURIComponent(hashedToken)}`
}

// ── The wire contract ────────────────────────────────────────────────────────
export interface CrewInviteRequest {
  technicianId: string
  email: string
}

export interface CrewInviteSuccess {
  ok: true
  email: string
  /** One-time. The owner hands this over; it is never emailed by us and never
   *  logged. Regenerating is one tap, so it is safe to treat as disposable. */
  setupUrl: string
  /** True when this call created the auth account (vs. linking an existing one). */
  created: boolean
}

export interface CrewInviteFailure {
  ok: false
  /** A stable code so the UI can react; `message` is what a human reads. */
  reason:
    | 'not-owner' | 'not-your-technician' | 'archived' | 'inactive'
    | 'bad-email' | 'already-linked' | 'email-taken' | 'own-account'
    | 'not-configured' | 'link-failed' | 'error'
  message: string
}

export type CrewInviteResponse = CrewInviteSuccess | CrewInviteFailure
