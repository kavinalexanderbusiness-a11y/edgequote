import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAppRole, CREW_ROOT, OWNER_ROOT } from '@/lib/crewAccess'
import { joinScreenFor } from '@/lib/crewInvite'
import { readCrewSelfStatus } from '@/lib/crewSelfStatus'
import { CrewJoinForm } from '@/components/crew/CrewJoinForm'
import { CrewSignOut } from '@/components/crew/CrewSignOut'
import { readUser } from '@/lib/authState'
import { AuthUnavailable } from '@/components/auth/AuthUnavailable'
import { ShieldOff } from 'lucide-react'

export const metadata = { title: 'Your access — EdgeHQ' }

// ── The one page a signed-in account with NO role may reach ──────────────────
// It sits outside the crew gate deliberately: this is how 'none' stops being
// 'none', so gating it behind a role would be a deadlock. It is also why the
// dashboard's first-run redirect can't hijack a worker — /dashboard sends an
// account with no business_settings row to /setup, which would quietly turn a
// new worker into the owner of an empty business. This page is outside that
// tree entirely.
//
// ⭐ IT ASKS WHICH KIND OF 'none' THIS IS. A worker whose access was turned off
// reaches exactly this page, and used to be told to enter a join code — for a
// code that cannot work, since crew_redeem_invite refuses an inactive roster
// row. The status is resolved server-side (same logic as
// /api/crew/access-status, which is the client-facing door for it) so the
// correct screen is in the first paint: no owner-shell flash, no wrong sentence
// that then swaps.
export default async function CrewJoinPage() {
  const supabase = await createClient()
  // Three answers (lib/authState) — a worker redeeming a code on site, on one bar
  // of signal, must not lose the session that got them here.
  const auth = await readUser(supabase)
  if (auth.kind === 'signed-out') redirect('/login')
  if (auth.kind === 'unavailable') return <AuthUnavailable reason={auth.reason} />
  const user = auth.user

  const role = await resolveAppRole(supabase)
  if (role === 'crew') redirect(CREW_ROOT)
  if (role === 'owner') redirect(OWNER_ROOT)

  // Which kind of 'none'? Derived from the VERIFIED session's uid — there is no
  // parameter here to forge. The read itself lives in lib/crewSelfStatus, which
  // is also what /api/crew/access-status calls: a crew SCREEN may not query an
  // owner table, and the service role may only be reached from app/api/** or
  // lib/**. Failing to ask resolves to 'unknown', which shows the neutral join
  // form rather than asserting anything.
  const status = await readCrewSelfStatus(supabase, user.id)

  if (joinScreenFor(status) === 'turned-off') {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
        <main className="w-full max-w-sm">
          <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mb-4">
              <ShieldOff className="w-6 h-6 text-amber-300" aria-hidden />
            </div>
            <h1 className="text-lg font-bold tracking-tight text-ink">Your access is turned off</h1>
            <p className="mt-2 text-sm text-ink-muted">
              You’re signed in as {user.email}, but this account can’t open the crew app right now.
              Your manager can switch it back on — nothing of yours has been deleted.
            </p>
            {/* ⛔ No join-code form here on purpose. A code cannot fix this: the
                redeem path refuses an inactive roster row, so offering one would
                send somebody after a thing that cannot work. */}
            <div className="mt-6">
              <CrewSignOut />
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <main className="w-full max-w-sm">
        <h1 className="text-xl font-bold tracking-tight text-ink">Join your crew</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Signed in as {user.email}. Enter the code your manager gave you to connect this
          account to your name on the roster.
        </p>
        <CrewJoinForm />
      </main>
    </div>
  )
}
