import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveAppRole, CREW_ROOT, OWNER_ROOT } from '@/lib/crewAccess'
import { CrewJoinForm } from '@/components/crew/CrewJoinForm'

export const metadata = { title: 'Join your crew — EdgeQuote' }

// ── Join ─────────────────────────────────────────────────────────────────────
// The one page a signed-in account with NO role may reach. It sits outside the
// crew gate deliberately: this is how 'none' stops being 'none', so gating it
// behind a role would be a deadlock.
//
// It is also why the dashboard's first-run redirect can't hijack an employee:
// /dashboard sends an account with no business_settings row to /setup, which
// would quietly turn a new worker into the owner of an empty business. This page
// lives outside that tree entirely.
export default async function CrewJoinPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const role = await resolveAppRole(supabase)
  if (role === 'crew') redirect(CREW_ROOT)
  if (role === 'owner') redirect(OWNER_ROOT)

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
