'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { MailX, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BetaClaimStatus } from '@/lib/betaInvite'
import { REGISTRATION_CLOSED, SETUP_REGISTER_PATH, parseProvisioningStatus, registrationNextStep } from '@/lib/registration'

// ── /signup/confirm — where the emailed link lands ───────────────────────────
// verifyOtp with the token_hash proves the email and mints the session (the
// crew-welcome pattern: no Redirect-URL allow-list, no URL fragment, works in
// whatever browser the email opened in). Then claim_beta_invite() redeems the
// invite — the step that licenses business_settings creation — and we hand off
// to /setup.
//
// A PUBLIC sign-up lands here too (GoTrue's own confirmation email). It holds
// no invite, so the claim answers 'no-invite' — which is not a verdict any
// more: provisioning_status() is, and it says setup / closed / crew. A GoTrue
// default-template link arrives as ?code= instead of a token hash; that is
// exchanged in place (same browser only — the path-form template is the one
// that works from any device, see the runtime prerequisites).
//
// The canonical link shape is PATH segments — /signup/confirm/<type>/<hash> —
// because an emailed query string is at the mercy of every quoted-printable
// decoder in transit: `=73` is a valid QP escape, and a `?token_hash=73…`
// link measurably lost bytes on the way to a real inbox (2026-08-13). The
// optional catch-all also still honours the old ?token_hash=&type= form.
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

type Phase = 'working' | 'dead' | 'revoked' | 'closed' | 'crew' | 'error'

function ConfirmFlow() {
  const router = useRouter()
  const params = useParams<{ link?: string[] }>()
  const search = useSearchParams()

  // Path form first (the emailed shape), query form as the fallback. Segment
  // values can arrive percent-encoded; decoding is a no-op for hex/pkce hashes.
  const seg = Array.isArray(params.link) ? params.link.map(s => decodeURIComponent(s)) : []
  const tokenHash = seg.length >= 2 ? seg[1] : search.get('token_hash')
  const rawType = (seg.length >= 2 ? seg[0] : search.get('type')) ?? 'signup'
  const type: OtpType = (OTP_TYPES as readonly string[]).includes(rawType) ? (rawType as OtpType) : 'signup'
  const pkceCode = search.get('code')

  const [phase, setPhase] = useState<Phase>('working')

  const run = useCallback(async () => {
    setPhase('working')
    const supabase = createClient()

    // A session may already exist: verified in this tab a moment ago, or in a
    // reload after the one-time token was consumed. That session is exactly as
    // good as a fresh verification — proceed to the claim.
    let { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      if (!tokenHash && pkceCode) {
        // GoTrue's default confirmation template redirects with a PKCE code.
        const { data, error } = await supabase.auth.exchangeCodeForSession(pkceCode)
        if (error || !data.user) { setPhase('dead'); return }
        user = data.user
      } else {
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
    if (s === 'no-invite') {
      // No invite is the ORDINARY case for a public sign-up. Ask the database
      // what this verified account may do — the same function the INSERT
      // policy derives from, so the screen and the write cannot disagree.
      const { data: st, error: stErr } = await supabase.rpc('provisioning_status')
      if (stErr) { setPhase('error'); return }
      const step = registrationNextStep(parseProvisioningStatus(st))
      if (step === 'setup') { router.replace(SETUP_REGISTER_PATH); router.refresh(); return }
      if (step === 'crew') { setPhase('crew'); return }
      if (step === 'closed') { setPhase('closed'); return }
      setPhase('error')
      return
    }
    // 'email-unverified' / 'not-signed-in' right after a successful verify means
    // something transient went wrong between the two calls — offer a retry.
    setPhase('error')
  }, [tokenHash, type, pkceCode, router])

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
          <p className="text-sm text-ink-muted">Your email is confirmed, but the invite behind it is no longer active. Contact EdgeHQ if that’s unexpected.</p>
        </Card>
      )}

      {phase === 'closed' && (
        <Card icon={<ShieldCheck className="w-6 h-6 text-amber-300" aria-hidden />} title={REGISTRATION_CLOSED.title}>
          <p className="text-sm text-ink-muted">Your email is confirmed. {REGISTRATION_CLOSED.body}</p>
          <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">{REGISTRATION_CLOSED.signIn}</a>
        </Card>
      )}

      {phase === 'crew' && (
        <Card icon={<ShieldCheck className="w-6 h-6 text-amber-300" aria-hidden />} title="This email belongs to a crew account">
          <p className="text-sm text-ink-muted">
            Your email is confirmed, and this account is linked to an employer’s crew — it can’t also own a business.
            Sign in to reach your crew tools, or use a different email to start a business.
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
