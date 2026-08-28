'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { Skeleton } from '@/components/ui/Skeleton'
import { Zap, MailCheck, ShieldCheck, KeyRound } from 'lucide-react'
import { BETA_TOKEN_RE, MIN_PASSWORD, type BetaInviteState, type BetaSignupResponse } from '@/lib/betaInvite'
import { GoogleButton, AuthDivider } from '@/components/auth/GoogleButton'

// ── /signup — the invite-only front door ─────────────────────────────────────
// Reached only from an invite URL (/signup?invite=eqb_…) handed out by the
// EdgeHQ operator. Without a valid token this page is a dead end on purpose:
// there is no open registration, and the business_settings INSERT policy would
// refuse a tenant anyway — this page is the honest face of that rule, not the
// enforcement of it.
//
// One screen, three fields, one button. After POST the account exists but is
// UNVERIFIED — the next stop is the confirmation email → /signup/confirm.
// Middleware never gates /signup (it is outside the /dashboard·/crew·/login
// set), so this works signed-out by construction.

export default function SignupPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return <Suspense fallback={null}><SignupFlow /></Suspense>
}

type Phase =
  | 'checking'            // validating the invite with the server
  | 'form'                // invite is good — collect email + password
  | 'sent'                // verification email is out
  | 'signed-in'           // an authenticated session is already on this device
  | BetaInviteState       // every dead/waiting state renders its own card

function SignupFlow() {
  const router = useRouter()
  const rawToken = useSearchParams().get('invite') ?? ''
  const token = BETA_TOKEN_RE.test(rawToken) ? rawToken : null

  const [phase, setPhase] = useState<Phase>('checking')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState('')
  const [resendNote, setResendNote] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // A session already on this device outranks the invite check: the common
      // way here is reloading after verification, and the right next step is
      // /setup (whose claim self-heal finishes any pending redemption).
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!alive) return
      if (user) { setPhase('signed-in'); return }
      if (!token) { setPhase('invalid'); return }
      const res = await fetch(`/api/beta/signup?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
        .then(r => r.json() as Promise<{ state: BetaInviteState }>)
        .catch(() => ({ state: 'invalid' as BetaInviteState }))
      if (!alive) return
      setPhase(res.state === 'ok' ? 'form' : res.state)
    })()
    return () => { alive = false }
  }, [token])

  useEffect(() => () => { if (cooldownRef.current) clearInterval(cooldownRef.current) }, [])

  function startCooldown(seconds: number) {
    setCooldown(seconds)
    if (cooldownRef.current) clearInterval(cooldownRef.current)
    cooldownRef.current = setInterval(() => {
      setCooldown(s => {
        if (s <= 1 && cooldownRef.current) clearInterval(cooldownRef.current)
        return Math.max(0, s - 1)
      })
    }, 1000)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < MIN_PASSWORD) { setError(`Use at least ${MIN_PASSWORD} characters.`); return }
    if (pw !== pw2) { setError('Those two don’t match.'); return }
    setBusy(true)
    const res = await fetch('/api/beta/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email, password: pw }),
    }).then(r => r.json() as Promise<BetaSignupResponse>)
      .catch(() => ({ ok: false as const, reason: 'error' as const, message: 'Couldn’t reach the server — try again.' }))
    setBusy(false)
    if (!res.ok) {
      // Terminal states swap the whole card; everything else is an inline banner.
      if (res.reason === 'expired' || res.reason === 'revoked' || res.reason === 'used' || res.reason === 'verified') {
        setPhase(res.reason === 'verified' ? 'verified' : res.reason)
        return
      }
      setError(res.message)
      return
    }
    setSentTo(res.email)
    setPhase('sent')
    startCooldown(60)
  }

  async function resend() {
    setResendNote('')
    const res = await fetch('/api/beta/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.json() as Promise<BetaSignupResponse>)
      .catch(() => ({ ok: false as const, reason: 'error' as const, message: 'Couldn’t reach the server — try again.' }))
    if (res.ok) {
      setSentTo(res.email)
      setResendNote('Sent — the new link replaces any earlier one.')
      startCooldown(60)
    } else {
      setResendNote(res.message)
    }
  }

  return (
    <Shell>
      {phase === 'checking' && <Skeleton className="h-64 rounded-card" />}

      {phase === 'signed-in' && (
        <Card icon={<ShieldCheck className="w-6 h-6 text-emerald-400" aria-hidden />} title="You’re already signed in">
          <p className="text-sm text-ink-muted">Pick up where you left off — setup finishes any pending invite automatically.</p>
          <Button className="w-full mt-5" onClick={() => { router.push('/setup'); router.refresh() }}>Continue to setup</Button>
        </Card>
      )}

      {phase === 'form' && (
        <>
          <Brand sub="You’ve been invited to the private beta" />
          <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl">
            <h2 className="text-base font-semibold text-ink mb-6">Create your account</h2>

            {/* Only reachable in the 'form' phase — that is, once the server has
                already said this invite is live. The invite token rides along to
                the start route, which moves it into an httpOnly cookie for the
                Google round trip; it is re-checked against the row, atomically,
                at binding time. Nothing here is the authority on it. */}
            <GoogleButton label="Continue with Google" invite={token} />
            <AuthDivider />

            <form onSubmit={submit} className="space-y-4">
              <Input label="Work email" type="email" placeholder="you@yourbusiness.ca" value={email}
                onChange={e => setEmail(e.target.value)} required autoComplete="email" />
              <Input label="Password" type="password" value={pw} onChange={e => setPw(e.target.value)}
                required autoComplete="new-password" minLength={MIN_PASSWORD} hint={`At least ${MIN_PASSWORD} characters.`} />
              <Input label="Type it again" type="password" value={pw2} onChange={e => setPw2(e.target.value)}
                required autoComplete="new-password" />
              {error && <Banner tone="danger">{error}</Banner>}
              <Button type="submit" className="w-full tap-target h-12" size="lg" loading={busy} disabled={!email || !pw || !pw2}>
                Create account
              </Button>
            </form>
          </div>
          <p className="text-center text-xs text-ink-faint mt-6">
            We’ll email you a confirmation link — your business gets set up right after.
          </p>
        </>
      )}

      {phase === 'sent' && (
        <Card icon={<MailCheck className="w-6 h-6 text-emerald-400" aria-hidden />} title="Check your email">
          <p className="text-sm text-ink-muted">
            We sent a confirmation link to <span className="text-ink font-medium">{sentTo}</span>.
            Open it on any device to finish creating your business.
          </p>
          <p className="mt-3 text-xs text-ink-faint">Nothing arriving? Check spam, then resend.</p>
          {resendNote && <p className="mt-3 text-xs text-ink-muted">{resendNote}</p>}
          <Button variant="secondary" className="w-full mt-5" type="button" onClick={resend} disabled={cooldown > 0}>
            {cooldown > 0 ? `Resend email (${cooldown}s)` : 'Resend email'}
          </Button>
        </Card>
      )}

      {phase === 'reserved' && (
        <Card icon={<MailCheck className="w-6 h-6 text-amber-300" aria-hidden />} title="This signup is already started">
          <p className="text-sm text-ink-muted">
            An account was created with this invite and is waiting on its confirmation email.
            If that was you, check your inbox — or resend the link.
          </p>
          {resendNote && <p className="mt-3 text-xs text-ink-muted">{resendNote}</p>}
          <Button variant="secondary" className="w-full mt-5" type="button" onClick={resend} disabled={cooldown > 0}>
            {cooldown > 0 ? `Resend email (${cooldown}s)` : 'Resend email'}
          </Button>
        </Card>
      )}

      {phase === 'verified' && (
        <Card icon={<KeyRound className="w-6 h-6 text-emerald-400" aria-hidden />} title="You’re already confirmed">
          <p className="text-sm text-ink-muted">This invite’s email is verified — sign in to finish setting up your business.</p>
          <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">Sign in</a>
        </Card>
      )}

      {(phase === 'invalid' || phase === 'expired' || phase === 'revoked' || phase === 'used') && (
        <Card icon={<ShieldCheck className="w-6 h-6 text-amber-300" aria-hidden />} title={DEAD_TITLES[phase]}>
          <p className="text-sm text-ink-muted">{DEAD_BODIES[phase]}</p>
          <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">
            Already have an account? Sign in
          </a>
        </Card>
      )}
    </Shell>
  )
}

const DEAD_TITLES: Record<'invalid' | 'expired' | 'revoked' | 'used', string> = {
  invalid: 'This isn’t a valid invite link',
  expired: 'This invite has expired',
  revoked: 'This invite was revoked',
  used: 'This invite has been used',
}

const DEAD_BODIES: Record<'invalid' | 'expired' | 'revoked' | 'used', string> = {
  invalid: 'EdgeHQ is in private beta — accounts are created by invite. Check the link you were sent, or ask for a fresh one.',
  expired: 'Invites are time-limited. Ask EdgeHQ for a new one — your details aren’t lost, nothing was created yet.',
  revoked: 'This invite is no longer active. Contact EdgeHQ if you think that’s a mistake.',
  used: 'Each invite creates exactly one business. If that was you, sign in below.',
}

function Brand({ sub }: { sub: string }) {
  return (
    <div className="flex flex-col items-center mb-8">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mb-4 shadow-lg shadow-accent/20">
        <Zap className="w-6 h-6 text-black fill-black" />
      </div>
      <h1 className="text-xl font-bold tracking-tight text-ink">EdgeHQ</h1>
      <p className="text-sm text-ink-muted mt-1">{sub}</p>
    </div>
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
