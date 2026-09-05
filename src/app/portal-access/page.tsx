import type { Metadata } from 'next'
import { PortalAccessForm } from './PortalAccessForm'

export const metadata: Metadata = {
  title: 'Access your customer portal',
  description: 'Enter the email associated with your account and we’ll send you a secure portal link.',
  // A recovery page has nothing to index and shouldn't rank against the business's
  // own site — and keeping it out of search removes it as a target to sweep.
  robots: { index: false, follow: false },
}

// ── /portal-access — the public way back into a portal ──────────────────────
// A customer's portal has no password by design: the link IS the credential. The
// gap that leaves is the one everybody eventually hits — the text is gone, the
// email is buried, and there was no way to ask for it again without phoning the
// owner. This page is that way, and nothing more: no signup, no account, no
// password, and no new idea of who a customer is.
//
// Deliberately its own tiny route rather than part of /portal/[token]: it is the
// page for someone who has no token.
export default function PortalAccessPage() {
  return (
    <main className="min-h-screen bg-bg flex flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-bold tracking-tight text-ink">Access your customer portal</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Enter the email associated with your account and we’ll send you a secure portal link.
        </p>
        <PortalAccessForm />
        <p className="mt-8 text-center text-[11px] text-ink-faint">Powered by EdgeHQ</p>
      </div>
    </main>
  )
}
