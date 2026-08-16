'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { Skeleton } from '@/components/ui/Skeleton'
import {
  readResetToken, readResetPathToken, readRecoveryFragment, classifyResetToken,
  passwordProblem, MIN_PASSWORD, RESET_SIGNOUT_SCOPE, RESET_DESTINATION, FORGOT_PATH,
  type ResetTokenOutcome,
} from '@/lib/passwordRecovery'
import { resolveAppRole, landingFor } from '@/lib/crewAccess'
import { KeyRound, ShieldCheck, LinkIcon, RefreshCw } from 'lucide-react'

export function ResetPasswordForm() {
  return <Suspense fallback={<Skeleton className="h-72 rounded-card" />}><Form /></Suspense>
}

function Form() {
  const router = useRouter()
  const params = useSearchParams()
  const routeParams = useParams()
  // Read to a STRING before it becomes an effect dependency. Both params objects
  // are new instances on every render, and an effect keyed on one re-runs forever
  // — the failure that made global search unusable until a real browser caught it.
  //
  // Path segment FIRST: that is the shape we email, and the shape that survives
  // quoted-printable. The query forms are still read so a link from an older
  // build, or from Supabase's own template, still opens.
  const raw = routeParams?.link
  const token = readResetPathToken(Array.isArray(raw) ? raw : raw ? [raw] : undefined)
    ?? readResetToken(k => params.get(k))
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
      // No token in the query string — so this is the stock template's link,
      // which arrives with the session in the fragment. supabase-js will not
      // touch it (see readRecoveryFragment for the measurement), so it is read
      // and installed here. Only `type=recovery` counts: a session that merely
      // happens to exist is not proof that this person can read the account's
      // email, and this page is the recovery door, not a settings one.
      const frag = readRecoveryFragment(window.location.hash)

      // Take the credential out of the address bar before anything else can see
      // it — history, a referrer header, a screenshot over somebody's shoulder.
      if (frag.kind !== 'none') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      }

      if (frag.kind === 'error') {
        setOutcome({ kind: 'dead' })
      } else if (frag.kind === 'none') {
        setOutcome({ kind: 'dead' })
      } else {
        supabase.auth.setSession({ access_token: frag.accessToken, refresh_token: frag.refreshToken })
          .then(({ data, error }) => {
            if (!alive) return
            const result = classifyResetToken(error, !!data?.user)
            setOutcome(result.kind === 'ready' ? { kind: 'ready', email: data.user?.email ?? null } : result)
          })
          .catch(() => { if (alive) setOutcome({ kind: 'unavailable' }) })
      }
    }

    return () => { alive = false }
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

    // Land where this account actually belongs. Recovery is the same door for an
    // owner and for a worker — the route never knew or cared which it was
    // serving — so a worker who resets their password should arrive in the crew
    // app, not take a lap through the owner's dashboard. The role is read from
    // the database and fails closed to 'none', which lands on RESET_DESTINATION:
    // exactly the previous behaviour whenever the answer is unavailable.
    //
    // ⚠️ A reset does NOT change what somebody is. Nothing here grants a role;
    // it only reads the one they already had.
    const role = await resolveAppRole(supabase)
    router.replace(role === 'crew' ? landingFor(role) : RESET_DESTINATION)
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
