'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { Skeleton } from '@/components/ui/Skeleton'
import {
  readResetToken, classifyResetToken, passwordProblem, MIN_PASSWORD,
  RESET_SIGNOUT_SCOPE, RESET_DESTINATION, FORGOT_PATH, UNAVAILABLE_MESSAGE,
  type ResetTokenOutcome,
} from '@/lib/passwordRecovery'
import { KeyRound, ShieldCheck, LinkIcon, RefreshCw } from 'lucide-react'

export function ResetPasswordForm() {
  return <Suspense fallback={<Skeleton className="h-72 rounded-card" />}><Form /></Suspense>
}

function Form() {
  const router = useRouter()
  const params = useSearchParams()
  // Read to a STRING before it becomes an effect dependency. The searchParams
  // object is a new instance on every render, and an effect keyed on it re-runs
  // forever — the failure that made global search unusable until a real browser
  // caught it.
  const token = readResetToken(k => params.get(k))
  const [outcome, setOutcome] = useState<ResetTokenOutcome | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // A token may only be spent once per mount. React 18 runs effects twice in
  // development, and the second run would redeem an already-burned token and
  // render "this link has expired" over a session that is actually fine.
  const spent = useRef(false)

  // ── Redeem the token ───────────────────────────────────────────────────────
  // This is Supabase's own contract, unmodified: the emailed token_hash is
  // exchanged for a session, and holding that session is what authorises the
  // password change. We do not mint, store or validate a token ourselves.
  //
  // The token is spent HERE, on mount, which is also why nothing that merely
  // fetches the URL can burn it — a link scanner gets HTML and no JavaScript.
  useEffect(() => {
    if (spent.current) return
    spent.current = true
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const supabase = createClient()

    if (token) {
      supabase.auth.verifyOtp({ token_hash: token, type: 'recovery' })
        .then(({ data, error }) => {
          if (!alive) return
          const result = classifyResetToken(error, !!data?.user)
          setOutcome(result.kind === 'ready' ? { kind: 'ready', email: data.user?.email ?? null } : result)
        })
        // A promise that rejects outright never reached Supabase, so it is the
        // one thing a dead link is not.
        .catch(() => { if (alive) setOutcome({ kind: 'unavailable' }) })
    } else {
      // No token in the query string. The default Supabase template lands with
      // the session in the URL FRAGMENT instead; supabase-js consumes it on
      // construction and announces it as PASSWORD_RECOVERY. Accepting that too
      // means the flow still works if this project is ever switched to the stock
      // template — but ONLY that event, never a session that merely happens to
      // exist. Someone already signed in has not proved they can read the
      // account's email, and this page is the recovery door, not a settings one.
      const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
        if (!alive || event !== 'PASSWORD_RECOVERY') return
        setOutcome({ kind: 'ready', email: session?.user?.email ?? null })
      })
      unsubscribe = () => sub.subscription.unsubscribe()
      // supabase-js has to be given a turn to parse the fragment before we can
      // call it a dead link. If the event has not arrived by then, it is not
      // coming — there is nothing to wait for and nothing to retry.
      timer = setTimeout(() => { if (alive) setOutcome(o => o ?? { kind: 'dead' }) }, 1500)
    }

    return () => { alive = false; if (timer) clearTimeout(timer); unsubscribe?.() }
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const problem = passwordProblem(pw, pw2)
    if (problem) { setError(problem); return }

    setBusy(true)
    const supabase = createClient()
    const { error: updateErr } = await supabase.auth.updateUser({ password: pw })
    if (updateErr) {
      // Supabase's own refusals are worth repeating verbatim here: at this point
      // the person has already proved they hold the account's email, so "that is
      // too short" or "that is the password you already had" tells an attacker
      // nothing they could not learn by trying.
      setError(updateErr.message)
      setBusy(false)
      return
    }

    // ── Cut every other session ───────────────────────────────────────────────
    // Scope is named explicitly — a bare signOut() would be GLOBAL and would end
    // the session we just created, dropping the owner back at the login screen
    // holding a password they typed once. 'others' keeps this device and revokes
    // the rest, which is the point of resetting a password you may not have been
    // the only one holding.
    //
    // A failure here is NOT a failed reset: the password is already changed and
    // the old one no longer works. Reporting it as one would be worse than
    // useless — it would send the owner round the loop again for nothing.
    await supabase.auth.signOut({ scope: RESET_SIGNOUT_SCOPE }).catch(() => {})

    router.replace(RESET_DESTINATION)
    router.refresh()
  }

  if (!outcome) return <Skeleton className="h-72 rounded-card" />

  // Deliberately NOT "this link has expired". We could not reach the server, so
  // we do not know what this link is — and telling somebody their good link is
  // dead sends them back for another one that will fail in exactly the same way.
  if (outcome.kind === 'unavailable') {
    return (
      <Shell icon={RefreshCw} title="We couldn’t check that link">
        <p className="mt-2 text-sm text-ink-muted leading-relaxed">
          Your connection dropped before we got an answer. The link is probably
          still fine — try again in a moment.
        </p>
        <Button className="w-full mt-5 tap-target h-12" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </Shell>
    )
  }

  if (outcome.kind === 'dead') {
    return (
      <Shell icon={LinkIcon} title="This link has expired">
        <p className="mt-2 text-sm text-ink-muted leading-relaxed">
          Reset links last an hour and can only be used once. Ask for a new one and
          it’ll be in your inbox in a moment.
        </p>
        <Link href={FORGOT_PATH} className="block mt-5">
          <Button className="w-full tap-target h-12">Send a new link</Button>
        </Link>
        <Link href="/login" className="mt-4 inline-block text-sm font-medium text-accent-text hover:underline tap-target">
          Back to sign in
        </Link>
      </Shell>
    )
  }

  return (
    <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl">
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mb-4 shadow-lg shadow-accent/20">
          <KeyRound className="w-6 h-6 text-black" aria-hidden />
        </div>
        <h1 className="text-lg font-bold tracking-tight text-ink">Choose a new password</h1>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}

        {/* Visible, read-only, and a real form field. It tells the owner which
            account they are about to change, and it gives a password manager the
            username it needs to update the right saved login instead of creating
            a second one. A hidden input would do the second job and not the
            first. */}
        {outcome.email && (
          <Input
            label="Account" type="email" value={outcome.email} readOnly
            autoComplete="username" tabIndex={-1}
            className="text-ink-muted cursor-default"
          />
        )}

        <Input
          label="New password" type="password" value={pw}
          onChange={e => { setPw(e.target.value); if (error) setError('') }}
          autoComplete="new-password" minLength={MIN_PASSWORD} required autoFocus
          hint={`At least ${MIN_PASSWORD} characters. Longer beats complicated.`}
        />
        <Input
          label="Type it again" type="password" value={pw2}
          onChange={e => { setPw2(e.target.value); if (error) setError('') }}
          autoComplete="new-password" required
        />
        <Button type="submit" className="w-full tap-target h-12" loading={busy} disabled={!pw || !pw2}>
          Save and sign in
        </Button>
      </form>

      <p className="mt-5 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
        Saving this signs you out everywhere else. Anyone still holding the old
        password — or an open session on another device — loses access.
      </p>
    </div>
  )
}

/** Both non-ready states wear the same amber card: something is wrong with the
 *  link, and the words below the title are what differ. */
function Shell({ icon: Icon, title, children }: {
  icon: typeof KeyRound; title: string; children: React.ReactNode
}) {
  return (
    <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl text-center">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-amber-300" aria-hidden />
      </div>
      <h1 className="text-lg font-bold tracking-tight text-ink">{title}</h1>
      {children}
    </div>
  )
}
