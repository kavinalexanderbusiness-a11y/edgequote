import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import {
  normalizeInviteEmail, isPlausibleEmail, buildSetupUrl,
  type CrewInviteResponse, type CrewInviteFailure,
} from '@/lib/crewInvite'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

// ── Provisioning an employee login ───────────────────────────────────────────
// THE owner-authenticated server boundary. This is the only place in EdgeQuote
// that creates an auth account, and the only crew-related code that touches the
// service role.
//
// WHY IT HAS TO EXIST. Crew Mode could already BIND an existing account to a
// technician (the one-time join code). It could not give somebody an account:
// this project has signups enabled but `mailer_autoconfirm: false`, and the
// built-in Supabase mailer is rate-limited — a probe signup came back "email
// rate limit exceeded". So the confirmation email is not a path an owner can
// depend on, and "go make yourself an account" is not a workflow. The Admin API
// creates the account already confirmed, so no email has to be delivered at all.
//
// SECURITY SHAPE, in the order the checks run:
//   1. There must be a session.                                (401)
//   2. current_app_role() must say 'owner' — asked of the DATABASE, never of a
//      cookie or a body field.                                 (403)
//   3. The technician must be readable BY THE CALLER'S OWN RLS-scoped client.
//      That is the ownership proof: RLS returns nothing for somebody else's
//      roster, so business isolation is enforced by the same policy that
//      protects every other read, not by an `if` written here.  (403/404)
//   4. Only then is the admin client constructed, and it is used for exactly
//      three things: find/create the auth user, link the row, mint the token.
//
// The service key is read from the environment inside `createAdminClient()` and
// never crosses into a response, a log line, or a client bundle. The one-time
// setup URL is returned to the OWNER (who chooses how to hand it over) and is
// deliberately not logged either — it is a credential for the few minutes it
// lives.

function fail(reason: CrewInviteFailure['reason'], message: string, status: number) {
  return NextResponse.json<CrewInviteResponse>({ ok: false, reason, message }, { status })
}

/** The origin to build the setup link on. NEXT_PUBLIC_APP_URL is the deploy's
 *  own answer (already used for portal + booking links); the request origin is
 *  the fallback so this works on a preview deploy and in local dev. */
function appOrigin(req: NextRequest): string {
  return (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/$/, '')
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return fail('not-owner', 'Sign in first.', 401)

  const role = await resolveAppRole(supabase)
  if (role !== 'owner') return fail('not-owner', 'Only the business owner can give someone app access.', 403)

  const body = (await req.json().catch(() => null)) as { technicianId?: unknown; email?: unknown } | null
  const technicianId = typeof body?.technicianId === 'string' ? body.technicianId : ''
  const rawEmail = typeof body?.email === 'string' ? body.email : ''
  if (!technicianId) return fail('error', 'Which employee?', 400)

  const email = normalizeInviteEmail(rawEmail)
  if (!isPlausibleEmail(email)) return fail('bad-email', 'That doesn’t look like an email address.', 400)

  // Ownership, proved by RLS rather than asserted here.
  const { data: tech, error: techErr } = await supabase
    .from('technicians')
    .select('id, name, user_id, auth_user_id, is_active, archived_at')
    .eq('id', technicianId)
    .maybeSingle()
  if (techErr) return fail('error', 'Couldn’t read that employee — try again.', 500)
  if (!tech) return fail('not-your-technician', 'That person isn’t on your roster.', 404)
  if (tech.archived_at) return fail('archived', 'That person has been removed from the roster. Restore them first.', 409)
  if (!tech.is_active) return fail('inactive', 'Switch them back to active before giving them app access.', 409)

  const admin = createAdminClient()
  if (!admin) {
    // Say exactly what is missing and what still works. An owner reading this
    // should know their next move without opening a dashboard to guess.
    return fail(
      'not-configured',
      'Creating logins needs SUPABASE_SERVICE_ROLE_KEY set on the deployment. Until then, use “Join code” — it works for someone who already has an EdgeQuote login.',
      503,
    )
  }

  // ── Find the account, if there is one ──────────────────────────────────────
  // There is no getUserByEmail in the admin API, so the pages are walked. A
  // business's roster is tens of people, not thousands; the cap keeps a
  // pathological project from turning this into an unbounded scan, and hitting
  // it is reported rather than silently treated as "no such user" (which would
  // create a DUPLICATE account for someone who already had one).
  let existingId: string | null = null
  let scanComplete = false
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return fail('error', 'Couldn’t check existing accounts — try again.', 502)
    const hit = data.users.find(u => (u.email || '').toLowerCase() === email)
    if (hit) { existingId = hit.id; scanComplete = true; break }
    if (data.users.length < 200) { scanComplete = true; break }
  }
  if (!scanComplete) return fail('error', 'Couldn’t check existing accounts — try again.', 502)

  // ── Collisions, each refused for its own reason ────────────────────────────
  if (existingId && existingId === user.id) {
    return fail('own-account', 'That’s your own owner account. Use a different email for your employee.', 409)
  }
  if (existingId) {
    // Globally, not just on this roster: auth_user_id is unique across the whole
    // project, so a link elsewhere would fail at the index anyway — better to say
    // why. The admin client is required precisely because another owner's row is
    // invisible to the caller's RLS.
    const { data: bound } = await admin
      .from('technicians').select('id, user_id').eq('auth_user_id', existingId).maybeSingle()
    if (bound && bound.id !== tech.id) {
      return fail('email-taken', 'That email already belongs to someone else’s EdgeQuote login.', 409)
    }
  }
  if (tech.auth_user_id && tech.auth_user_id !== existingId) {
    // Re-pointing an employee at a different account silently would orphan the
    // old one. Make the owner turn access off first — one deliberate tap.
    return fail('already-linked', `${tech.name} already has a login. Turn access off first to move them to a different email.`, 409)
  }

  // ── Create (or reuse) the account ──────────────────────────────────────────
  let authUserId = existingId
  let created = false
  if (!authUserId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      // Confirmed on creation: the owner vouching for their own employee IS the
      // verification, and it removes the dependency on a mailer that is rate
      // limited. No password is set — the setup link is how they choose one.
      email_confirm: true,
      user_metadata: { crew_for: tech.name },
    })
    if (error || !data?.user) {
      const msg = error?.message || 'Could not create that login.'
      // Supabase rejects addresses it cannot deliver to (non-existent domains),
      // which is the commonest real failure here and worth naming plainly.
      return fail(/invalid/i.test(msg) ? 'bad-email' : 'error',
        /invalid/i.test(msg) ? 'Supabase rejected that email address — check the spelling and the domain.' : msg, 400)
    }
    authUserId = data.user.id
    created = true
  }

  // ── Link it to the intended technician ─────────────────────────────────────
  // Scoped by user_id as well as id: the ownership check above already passed,
  // and this makes the admin-privileged write unable to land on a foreign row
  // even if that check were ever refactored away.
  const { error: linkErr } = await admin
    .from('technicians')
    .update({ auth_user_id: authUserId, invite_code: null, invite_expires_at: null, invite_sent_at: new Date().toISOString() })
    .eq('id', tech.id)
    .eq('user_id', user.id)
  if (linkErr) {
    // If we created the account a moment ago and cannot link it, leaving it
    // behind would block the owner from retrying with the same address.
    if (created) await admin.auth.admin.deleteUser(authUserId).catch(() => {})
    return fail('error', 'Couldn’t connect that login to the employee — nothing was changed.', 500)
  }

  // ── Mint the one-time setup token ──────────────────────────────────────────
  // generateLink RETURNS the link; it does not send anything, so no mailer is
  // involved. We use its hashed_token rather than its action_link — see
  // lib/crewInvite for why (no Supabase dashboard configuration required).
  const { data: link, error: linkGenErr } = await admin.auth.admin.generateLink({ type: 'recovery', email })
  const hashed = link?.properties?.hashed_token
  if (linkGenErr || !hashed) {
    return fail('link-failed',
      `${tech.name}’s login is connected, but the setup link couldn’t be created. Tap “New link” to try again.`, 502)
  }

  return NextResponse.json<CrewInviteResponse>({
    ok: true,
    email,
    setupUrl: buildSetupUrl(appOrigin(req), hashed),
    created,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
