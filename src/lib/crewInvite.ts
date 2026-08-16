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
//     page ever ran. A token verified by the page itself (verifyOtp) works the
//     same on every browser.
//  3. ⭐ PATH SEGMENTS, because `=` belongs to quoted-printable. This link is now
//     EMAILED (2026-08-15), and beta signup measured a query-form link losing
//     bytes on the way to a real inbox: `=73` is a valid QP escape, so a
//     transport that re-encodes the body can eat part of `?token=…` and deliver
//     a mangled token. A path-segment URL carries no `=` and no `?`, so there is
//     nothing for a QP decoder to misread. Same shape as buildResetUrl and
//     buildBetaConfirmUrl. ⛔ Never put '=' in an emailed URL.
export const CREW_WELCOME_PATH = '/crew/welcome'

export function buildSetupUrl(appOrigin: string, hashedToken: string): string {
  const base = appOrigin.replace(/\/$/, '')
  return `${base}${CREW_WELCOME_PATH}/${encodeURIComponent(hashedToken)}`
}

/** Query spellings still accepted on the way IN, though nothing we send uses
 *  them any more: `token` is the shape this feature shipped with, `token_hash`
 *  is what Supabase's own template snippet emits. Reading both costs nothing and
 *  means a link an owner copied out of the old UI still opens. */
export const SETUP_TOKEN_PARAMS = ['token', 'token_hash'] as const

export function readSetupToken(get: (k: string) => string | null): string | null {
  for (const k of SETUP_TOKEN_PARAMS) {
    const v = get(k)
    if (v && v.trim()) return v.trim()
  }
  return null
}

/** THE canonical read: the token as a path segment, from Next's optional
 *  catch-all. Exactly one segment is accepted — a deeper path is not a link we
 *  built, and quietly picking one segment out of several would make the route
 *  guess. Mirrors readResetPathToken. */
export function readSetupPathToken(segments: string[] | undefined): string | null {
  if (!segments || segments.length !== 1) return null
  const v = segments[0]?.trim()
  return v ? v : null
}

// ── What a signed-in account is told about its OWN access ────────────────────
// The router has one word for "not in the crew app": 'none'. Two very different
// people land on it — somebody who was never invited, and somebody whose access
// the owner turned off this morning — and telling the second one to "enter the
// code your manager gave you" sends them after a code that cannot work
// (crew_redeem_invite refuses an inactive roster row).
//
// `unknown` is the honest fourth answer, and it must never be collapsed into
// 'none': it means we could not ask (no service key, or the read failed), and
// the screen it renders asserts nothing about why the person is there. Same
// three-outcome discipline as CrewDayResult and classifyAuthError.
export type CrewSelfStatus = 'signed-out' | 'owner' | 'active' | 'disabled' | 'none' | 'unknown'

/** What the join screen shows for each answer. Pure, so the guard drives it
 *  without a browser. `disabled` is the only one that must NOT offer a code. */
export function joinScreenFor(status: CrewSelfStatus): 'code-form' | 'turned-off' {
  return status === 'disabled' ? 'turned-off' : 'code-form'
}

// ── The wire contract ────────────────────────────────────────────────────────
export interface CrewInviteRequest {
  technicianId: string
  email: string
}

export interface CrewInviteSuccess {
  ok: true
  email: string
  /** One-time, and never logged. Since 2026-08-15 this is ALSO emailed to the
   *  worker; it is still returned so the owner can hand it over directly when
   *  the send fails, or when they are standing next to the person. Regenerating
   *  is one tap, so it is safe to treat as disposable. */
  setupUrl: string
  /** True when this call created the auth account (vs. linking an existing one). */
  created: boolean
  /** Did the invitation email actually go out? ⚠️ NEVER defaulted to true: an
   *  owner who is told "we emailed them" when nothing was sent will wait instead
   *  of handing over the link. `false` makes the UI show the copy-this-link
   *  fallback, which is what the owner can act on. */
  emailed: boolean
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
