import { CrewWelcomeForm } from '@/components/crew/CrewWelcomeForm'

export const metadata = { title: 'Set your password — EdgeQuote' }

// ── Accepting an owner-provisioned invite ────────────────────────────────────
// The employee's first contact with EdgeQuote. They arrive from a one-time link
// the owner handed them, holding a token and NO session — which is exactly why
// this page sits outside every gate (see routeFor: /crew/welcome is allowed to
// everyone). It is inert without a valid token: all it can do is set a password
// for whoever that token already identifies.
export default function CrewWelcomePage() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
      </div>
      <main className="w-full max-w-sm relative">
        <CrewWelcomeForm />
      </main>
    </div>
  )
}
