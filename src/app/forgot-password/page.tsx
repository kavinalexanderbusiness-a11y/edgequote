import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm'

export const metadata = { title: 'Reset your password — EdgeHQ' }

// ── Asking for a reset link ──────────────────────────────────────────────────
// Outside every gate, by construction rather than by exception: the middleware
// only resolves a role for /dashboard, /crew and /login, so this path and
// /reset-password are already open to a signed-out visitor. verify:account-recovery
// pins that, because moving either page under a gated prefix would lock the
// people it exists for out of it.
export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
      </div>
      <main className="w-full max-w-sm relative">
        <ForgotPasswordForm />
      </main>
    </div>
  )
}
