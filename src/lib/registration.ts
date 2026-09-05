import { MIN_PASSWORD } from './passwordRecovery'

// ── Self-service registration — the shared vocabulary ────────────────────────
// Public sign-up is licensed by the DATABASE: provisioning_status() (migration
// 20260905191549) answers one word per signed-in account, and the business_
// settings INSERT policy derives from the same function. Everything here is the
// app-side reading of that word — pure, so the confirm page, /setup and the
// OAuth callback route on one mapping and the guard can execute it.
//
// Nothing in this file creates, deletes or emails an account. Sign-up itself is
// GoTrue's own `auth.signUp` on the anon key (provider-native), which brings its
// server-side, project-wide limits and its enumeration protection with it:
// with email confirmation required, an existing address gets an obfuscated
// user and no email, and the page below shows the same card either way.

/** What provisioning_status() can say. Mirrors the SQL, in its order. */
export type ProvisioningStatus =
  | 'not-signed-in' | 'already-owner' | 'crew-account' | 'invited'
  | 'email-unverified' | 'self-service' | 'closed'

const STATUSES: ReadonlySet<string> = new Set<ProvisioningStatus>([
  'not-signed-in', 'already-owner', 'crew-account', 'invited', 'email-unverified', 'self-service', 'closed',
])

/** Read the RPC's answer without trusting it — anything else is null. */
export function parseProvisioningStatus(v: unknown): ProvisioningStatus | null {
  return typeof v === 'string' && STATUSES.has(v) ? (v as ProvisioningStatus) : null
}

/** Where a signed-in account goes next. Three words are licensed to create the
 *  business and all three go to /setup; the rest each have one honest screen.
 *  An unreadable answer is CLOSED, never setup — fail closed on the way in. */
export type RegistrationStep = 'setup' | 'closed' | 'crew' | 'unverified' | 'signed-out'
export function registrationNextStep(status: ProvisioningStatus | null): RegistrationStep {
  switch (status) {
    case 'already-owner':
    case 'invited':
    case 'self-service': return 'setup'
    case 'crew-account': return 'crew'
    case 'email-unverified': return 'unverified'
    case 'not-signed-in': return 'signed-out'
    case 'closed':
    default: return 'closed'
  }
}

/** The closed state, in the words the platform owner chose. No accusation, no
 *  mention of invites: a public visitor did nothing wrong. */
export const REGISTRATION_CLOSED = {
  title: 'Account creation is temporarily unavailable',
  body: 'Account creation is temporarily unavailable. Please try again later.',
  signIn: 'Already have an account? Sign in',
} as const

/** The one public fact: open or closed. Served by a server route from the
 *  service role; the switch table itself is unreadable to every client role. */
export const REGISTER_STATUS_PATH = '/api/register/status'

/** GoTrue refuses a second confirmation email to the same address inside this
 *  window; the button counts it down so the refusal is never met. */
export const RESEND_COOLDOWN_SECONDS = 60

export type SignUpOutcome =
  | { kind: 'sent' }
  | { kind: 'closed' }
  | { kind: 'error'; reason: 'weak-password' | 'bad-email' | 'rate-limited' | 'error'; message: string }

/** Read `auth.signUp`'s result the way a public page must: an existing address
 *  is INDISTINGUISHABLE from a new one (enumeration protection — GoTrue already
 *  obfuscates it when confirmation is on; this keeps the promise when it is not),
 *  and every other failure is a stable reason with a sentence a person can act
 *  on. Never the provider's message: it may name internals. */
export function signUpOutcome(res: {
  data?: { user?: { identities?: unknown[] | null } | null } | null
  error?: { message?: string; status?: number; code?: string } | null
}): SignUpOutcome {
  const err = res.error
  if (!err) return { kind: 'sent' }
  const code = err.code ?? ''
  if (code === 'user_already_exists' || code === 'email_exists') return { kind: 'sent' }
  if (code === 'signup_disabled' || code === 'email_provider_disabled') return { kind: 'closed' }
  if (code === 'weak_password') {
    return { kind: 'error', reason: 'weak-password', message: `Use at least ${MIN_PASSWORD} characters — a longer, less common password.` }
  }
  if (code === 'email_address_invalid' || code === 'validation_failed') {
    return { kind: 'error', reason: 'bad-email', message: 'That doesn’t look like an email address we can send to.' }
  }
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || err.status === 429) {
    return { kind: 'error', reason: 'rate-limited', message: 'Too many attempts for now — wait a minute and try again.' }
  }
  return { kind: 'error', reason: 'error', message: 'Couldn’t create the account right now — please try again.' }
}
