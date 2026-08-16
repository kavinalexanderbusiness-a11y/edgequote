import { CrewWelcomeForm } from '@/components/crew/CrewWelcomeForm'

export const metadata = {
  title: 'Set up your login — EdgeHQ',
  // The token is in the URL. Nothing about this page should ever be indexed or
  // followed by a crawler that finds a forwarded invitation.
  robots: { index: false, follow: false },
}

// ── Accepting an owner-provisioned invite ────────────────────────────────────
// The worker's first contact with EdgeHQ. They arrive from a one-time link,
// holding a token and NO session — which is exactly why this page sits outside
// every gate (see routeFor: /crew/welcome is allowed to everyone). It is inert
// without a valid token: all it can do is set a password for whoever that token
// already identifies.
//
// ⭐ OPTIONAL CATCH-ALL, because the link is EMAILED. The canonical shape is
// /crew/welcome/<hash> — path segments carry no '=' and no '?', so a
// quoted-printable decoder between us and the inbox cannot eat part of the
// token (beta signup measured exactly that: `=73` decoded to 's'). The bare
// /crew/welcome?token=… form still resolves here, so a link an owner copied out
// of the old UI keeps working.
export default async function CrewWelcomePage({ params }: { params: Promise<{ link?: string[] }> }) {
  const { link } = await params
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
      </div>
      <main className="w-full max-w-sm relative">
        <CrewWelcomeForm pathSegments={link} />
      </main>
    </div>
  )
}
