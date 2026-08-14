'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { MailX, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BetaClaimStatus } from '@/lib/betaInvite'

// ── /signup/confirm — where the emailed link lands ───────────────────────────
// verifyOtp with the token_hash proves the email and mints the session (the
// crew-welcome pattern: no Redirect-URL allow-list, no URL fragment, works in
// whatever browser the email opened in). Then claim_beta_invite() redeems the
// invite — the step that licenses business_settings creation — and we hand off
// to /setup.
//
// Every branch here assumes it may run twice: a reload after verification
// finds the token consumed but the SESSION present, so it skips straight to
// the claim, which is itself idempotent. Only "no token, no session" is dead.

export default function SignupConfirmPage() {
  return <Suspense fallback={null}><ConfirmFlow /></Suspense>
}

// GoTrue's verification_type vocabulary; anything unexpected falls back to
// 'signup', which is what our routes mint.
const OTP_TYPES = ['signup', 'magiclink', 'recovery', 'invite', 'email'] as const
type OtpType = (typeof OTP_TYPES)[number]

type Phase = 'working' | 'dead' | 'revoked' | 'no-invite' | 'error'

function ConfirmFlow() {
  const router = useRouter()
  const params = useSearchParams()
  const tokenHash = params.get('token_hash')
  const rawType = params.get('type') ?? 'signup'
  const type: OtpType = (OTP_TYPES as readonly string[]).includes(rawType) ? (rawType as OtpType) : 'signup'

  const [phase, setPhase] = useState<Phase>('working')

  const run = useCallback(async () => {
    setPhase('working')
    const supabase = createClient()

    // A session may already exist: verified in this tab a moment ago, or in a
    // reload after the one-time token was consumed. That session is exactly as
    // good as a fresh verification — proceed to the claim.
    let { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      if (!tokenHash) { setPhase('dead'); return }
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      if (error || !data.user) {
        // The token may have been consumed by another tab that DID get a
        // session cookie set meanwhile — check once more before calling it dead.
        const again = await supabase.auth.getUser()
        if (!again.data.user) { setPhase('dead'); return }
        user = again.data.user
      } else {
        user = data.user
      }
    }

    // Redeem. Calm statuses all continue; only genuinely wrong states stop.
    const { data: status, error: claimErr } = await supabase.rpc('claim_beta_invite')
    if (claimErr) { setPhase('error'); return }
    const s = status as BetaClaimStatus
    if (s === 'claimed' || s === 'already-claimed' || s === 'already-owner') {
      // Hard navigation: middleware and the dashboard layout re-read the role
      // from the database, and this account only became usable a moment ago.
      router.replace('/setup')
      router.refresh()
      return
    }
    if (s === 'revoked') { setPhase('revoked'); return }
    if (s === 'no-invite') { setPhase('no-invite'); return }
    // 'email-unverified' / 'not-signed-in' right after a successful verify means
    // something transient went wrong between the two calls — offer a retry.
    setPhase('error')
  }, [tokenHash, type, router])

  useEffect(() => { void run() }, [run])

  return (
    <Shell>
      {phase === 'working' && (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-card" />
          <p className="text-center text-sm text-ink-muted">Confirming your email…</p>
        </div>
      )}

      {phase === 'dead' && (
        <Card icon={<MailX className="w-6 h-6 text-amber-300" aria-hidden />} title="This link has been used or replaced">
          <p className="text-sm text-ink-muted">
            Confirmation links are single-use, and requesting a new one replaces the old.
            If you already confirmed, just sign in. Otherwise open your invite link again and resend the email.
          </p>
          <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">Sign in</a>
        </Card>
      )}

      {phase === 'revoked' && (
        <Card icon={<TriangleAlert className="w-6 h-6 text-amber-300" aria-hidden />} title="This invite was revoked">
          <p className="text-sm text-ink-muted">Your email is confirmed, but the invite behind it is no longer active. Contact EdgeQuote if that’s unexpected.</p>
        </Card>
      )}

      {phase === 'no-invite' && (
        <Card icon={<ShieldCheck className="w-6 h-6 text-amber-300" aria-hidden />} title="No beta invite on this account">
          <p className="text-sm text-ink-muted">
            Your email is confirmed, but this account isn’t attached to a beta invite,
            so it can’t create a business. If you were invited, open the invite link you were sent.
          </p>
          <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">Sign in</a>
        </Card>
      )}

      {phase === 'error' && (
        <Card icon={<TriangleAlert className="w-6 h-6 text-amber-300" aria-hidden />} title="Nearly there — one step didn’t finish">
          <p className="text-sm text-ink-muted">Your email check went through but finishing the invite hit a snag. This is safe to retry.</p>
          <Button className="w-full mt-5" type="button" onClick={() => void run()}>Try again</Button>
        </Card>
      )}
    </Shell>
  )
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl text-center">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-bg-secondary border border-border flex items-center justify-center mb-4">
        {icon}
      </div>
      <h1 className="text-lg font-bold tracking-tight text-ink mb-2">{title}</h1>
      {children}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
        <div className="absolute w-[400px] h-[400px] rounded-full bg-blue-500 opacity-[0.04] blur-[120px] -top-20 -right-20" />
      </div>
      <main className="w-full max-w-sm relative">{children}</main>
    </div>
  )
}
