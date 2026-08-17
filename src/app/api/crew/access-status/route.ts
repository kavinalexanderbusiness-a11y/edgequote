import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readCrewSelfStatus } from '@/lib/crewSelfStatus'
import type { CrewSelfStatus } from '@/lib/crewInvite'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

// ── GET /api/crew/access-status ──────────────────────────────────────────────
// "Why can't I get in?", answered for the CALLER and nobody else.
//
// The decision itself lives in lib/crewSelfStatus, which the join screen also
// calls — one answer, not two copies. This route exists so a client surface can
// ask the same question without a page load (a phone that was disabled while the
// app was open should be able to find out without guessing).
//
// WHAT IT MAY SAY. One word about the caller's own standing. No employer id, no
// technician id, no name, no roster, no teammate — nothing that would tell an
// unlinked account anything it did not already know about a business.
//
// ⭐ There is deliberately NO parameter. The identity is the verified session's,
// so there is nothing here to forge.

const noStore = { 'Cache-Control': 'no-store' } as const
const say = (status: CrewSelfStatus, init?: number) =>
  NextResponse.json<{ status: CrewSelfStatus }>({ status }, { status: init, headers: noStore })

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return say('signed-out', 401)

  return say(await readCrewSelfStatus(supabase, user.id))
}
