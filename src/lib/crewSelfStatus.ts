// ── "Which kind of no is this?" — server only ────────────────────────────────
// NEVER import this from client code: it constructs the admin client. It lives
// in lib/ rather than in the page that needs it because that is this codebase's
// rule — the service role may only be reached from app/api/** or lib/**, and a
// crew SCREEN may never query an owner table at all (verify:crew-access,
// verify:crew-invite both fail the build otherwise). The page and
// /api/crew/access-status call this one function, so there is one answer rather
// than two copies drifting apart.
//
// WHY IT EXISTS. current_app_role() has one word — 'none' — for two very
// different people: somebody never invited, and somebody whose access the owner
// turned off this morning. Both land on the join screen, and the second was
// being told to "enter the code your manager gave you" for a code that cannot
// work, because crew_redeem_invite refuses an inactive roster row. Same family
// as CrewDayResult's dead-signal-is-not-revocation and the day-status contract:
// a question we cannot answer must not be answered confidently and wrongly.
//
// WHY THE SERVICE ROLE. A crew session has no table grants at all, deliberately
// — RLS is row-level, so any policy that let a worker read `technicians` would
// hand over teammates' wages with the row. The alternative was a new SECURITY
// DEFINER function and a new grant; this needs neither. The identity is DERIVED
// from the verified session and there is no parameter to forge.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import type { CrewSelfStatus } from '@/lib/crewInvite'

/**
 * What this signed-in account's own crew standing is.
 *
 * ⚠️ `userId` must come from a VERIFIED session (`auth.getUser()`), never from a
 * body, a query parameter or a header. Every caller passes the session's own id;
 * there is deliberately no way to ask about somebody else.
 *
 * Returns 'unknown' whenever the question could not be answered — no service
 * key, or a failed read. ⛔ Never fold that into 'none': 'none' renders a join
 * form, and 'unknown' must render one that asserts nothing about why.
 */
export async function readCrewSelfStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<CrewSelfStatus> {
  // An account that already has a working role is not asking this question.
  // Answered from the same source the router uses, so the two cannot disagree.
  const role = await resolveAppRole(supabase)
  if (role === 'owner') return 'owner'
  if (role === 'crew') return 'active'

  const admin = createAdminClient()
  if (!admin) return 'unknown'

  // ⭐ SELF ONLY — the filter is the verified session's uid.
  const { data, error } = await admin
    .from('technicians')
    .select('is_active, archived_at')
    .eq('auth_user_id', userId)
    .limit(1)
    .maybeSingle()

  if (error) return 'unknown'
  // No roster row anywhere: never invited, or the link was revoked outright.
  // Both mean a join code genuinely is the next step.
  if (!data) return 'none'
  // Linked to a roster, but the switch is off. THIS is the case that was being
  // sent after a code that cannot work.
  return 'disabled'
}
