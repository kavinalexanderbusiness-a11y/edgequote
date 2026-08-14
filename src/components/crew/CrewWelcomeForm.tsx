'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { Skeleton } from '@/components/ui/Skeleton'
import { HardHat, ShieldCheck } from 'lucide-react'
// ONE password rule for the whole application. This file used to carry its own
// number (8, described as "the shortest Supabase will accept by default", which
// was never true — the project floor is 6). Two numbers in two files is how a
// policy quietly becomes a suggestion, so both doors now read the same one.
import { MIN_PASSWORD, passwordProblem } from '@/lib/passwordRecovery'

export function CrewWelcomeForm() {
  return <Suspense fallback={<Skeleton className="h-64 rounded-card" />}><Form /></Suspense>
}

function Form() {
  const router = useRouter()
  const token = useSearchParams().get('token')
  const [phase, setPhase] = useState<'checking' | 'ready' | 'dead'>('checking')
  const [email, setEmail] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Redeem the one-time token for a session. `verifyOtp` with a token_hash is
  // the query-string equivalent of Supabase's emailed link — it needs no
  // Redirect-URL allow-list entry and no URL fragment, so it survives being
  // texted, pasted, and opened in a different browser than it was made in.
  useEffect(() => {
    let alive = true
    if (!token) { setPhase('dead'); return }
    ;(async () => {
      const supabase = createClient()
      const { data, error: vErr } = await supabase.auth.verifyOtp({ token_hash: token, type: 'recovery' })
      if (!alive) return
      if (vErr || !data.user) { setPhase('dead'); return }
      setEmail(data.user.email ?? null)
      setPhase('ready')
    })()
    return () => { alive = false }
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const problem = passwordProblem(pw, pw2)
    if (problem) { setError(problem); return }
    setBusy(true)
    const supabase = createClient()
    const { error: uErr } = await supabase.auth.updateUser({ password: pw })
    if (uErr) { setError(uErr.message); setBusy(false); return }
    // Hard navigation: the role gates (middleware, the crew layout) both re-read
    // it from the database, and this account only became usable a moment ago.
    router.replace('/crew')
    router.refresh()
  }

  if (phase === 'checking') {
    return <Skeleton className="h-64 rounded-card" />
  }

  if (phase === 'dead') {
    return (
      <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mb-4">
          <HardHat className="w-6 h-6 text-amber-300" aria-hidden />
        </div>
        <h1 className="text-lg font-bold tracking-tight text-ink">This link has expired</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Setup links can only be used once, and not long after they’re made. Ask your manager to send a new one.
        </p>
        <a href="/login" className="mt-5 inline-block text-sm font-medium text-accent-text hover:underline">
          Already set a password? Sign in
        </a>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl">
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mb-4 shadow-lg shadow-accent/20">
          <HardHat className="w-6 h-6 text-black" aria-hidden />
        </div>
        <h1 className="text-lg font-bold tracking-tight text-ink">Set your password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {email ? <>You’re signing in as <span className="text-ink">{email}</span>.</> : 'Choose a password to finish setting up.'}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Input
          label="New password" type="password" value={pw} onChange={e => setPw(e.target.value)}
          autoComplete="new-password" minLength={MIN_PASSWORD} required
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        <Input
          label="Type it again" type="password" value={pw2} onChange={e => setPw2(e.target.value)}
          autoComplete="new-password" required
        />
        <Button type="submit" className="w-full tap-target h-12" loading={busy} disabled={!pw || !pw2}>
          Start working
        </Button>
      </form>

      <p className="mt-5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
        You’ll see the visits assigned to your crew — where to go, what the job is, and how to start and finish it.
        Prices, invoices, customer records and company settings stay with the office.
      </p>
    </div>
  )
}
