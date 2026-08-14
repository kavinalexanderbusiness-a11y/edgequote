import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm'

export const metadata = {
  title: 'Choose a new password — EdgeQuote',
  // A reset URL carries a live credential in its query string. Search engines
  // and previews have no business holding one even for the hour it lasts.
  robots: { index: false, follow: false },
}

// ── Choosing a new password ──────────────────────────────────────────────────
// Arrived at from a one-time token in the emailed link, holding no session — so,
// like /crew/welcome, it has to be reachable signed-out and the gate must not
// bounce it to /login. Inert without a valid token: all it can do is set a
// password for whoever that token already identifies.
//
// The canonical link shape is PATH segments — /reset-password/<hash> — because
// an emailed query string is at the mercy of every quoted-printable decoder in
// transit: `=73` is a valid QP escape, and a `?token=73…` link measurably lost
// bytes on the way to a real inbox (beta signup, 2026-08-13). The optional
// catch-all also still honours ?token= / ?token_hash=, and a recovery fragment.
export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
      </div>
      <main className="w-full max-w-sm relative">
        <ResetPasswordForm />
      </main>
    </div>
  )
}
