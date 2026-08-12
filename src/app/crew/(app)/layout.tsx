import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAppRole, CREW_JOIN, OWNER_ROOT } from '@/lib/crewAccess'
import { readUser } from '@/lib/authState'
import { AuthUnavailable } from '@/components/auth/AuthUnavailable'
import { CrewNav } from '@/components/crew/CrewNav'
import { Toaster } from '@/components/ui/Toaster'

// ── Crew Mode shell ──────────────────────────────────────────────────────────
// The authoritative route gate. Middleware redirects first (so nobody watches a
// page paint and then vanish), but middleware can be bypassed by a direct RSC
// request — this runs on the server, in the request's own session, and asks the
// database the same question.
//
// Neither check is the security boundary. That is RLS: a crew session sees the
// rows `jobs: crew reads assigned` allows and nothing else, and can only move a
// visit's status because a BEFORE UPDATE trigger rejects every other column.
//
// Deliberately NOT here (this is the whole point of Crew Mode): the sidebar, the
// command palette, the module registry, notifications, the install prompt, the
// upload widget. A worker gets three destinations and one action.
export default async function CrewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  // Three answers (lib/authState). A worker between cell towers must not be told
  // they are signed out — that is the same shape as the "dead signal = you were
  // fired" bug CrewDayResult exists to prevent, one layer up.
  const auth = await readUser(supabase)
  if (auth.kind === 'signed-out') redirect('/login')
  if (auth.kind === 'unavailable') return <AuthUnavailable reason={auth.reason} />

  const role = await resolveAppRole(supabase)
  if (role === 'owner') redirect(OWNER_ROOT)
  if (role !== 'crew') redirect(CREW_JOIN)

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* pb: clearance for the fixed nav (h ~60px + the home-indicator inset). */}
      <main id="main-content" className="flex-1 min-w-0 px-4 pt-4 pb-28">
        <div className="mx-auto w-full max-w-lg">{children}</div>
      </main>
      <CrewNav />
      <Toaster />
    </div>
  )
}
