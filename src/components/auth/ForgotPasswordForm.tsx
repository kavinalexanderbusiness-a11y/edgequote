'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import {
  classifyRecoverySend, acceptedMessage, UNAVAILABLE_MESSAGE, RESET_PATH,
  type RecoveryRequestOutcome,
} from '@/lib/passwordRecovery'
// The same permissive check the invite flow uses. One regex for "did they
// fat-finger this", not two that disagree.
import { isPlausibleEmail, normalizeInviteEmail } from '@/lib/crewInvite'
import { KeyRound, MailCheck, ArrowLeft } from 'lucide-react'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [outcome, setOutcome] = useState<RecoveryRequestOutcome | null>(null)
  // The address the outcome refers to, frozen at submit — so editing the field
  // afterwards cannot make an old confirmation appear to be about a new address.
  const [sentTo, setSentTo] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setFieldError('')
    setOutcome(null)

    const address = normalizeInviteEmail(email)
    // Caught here rather than by the server, because the server's answer to a
    // malformed address is one of the signals we have decided not to show.
    if (!isPlausibleEmail(address)) { setFieldError('That doesn’t look like an email address.'); return }

    setBusy(true)
    const supabase = createClient()
    // `redirectTo` is what Supabase's own {{ .ConfirmationURL }} would use. We
    // send the reset page's own URL so that the default template still lands
    // somewhere real if this project is ever switched to it — but the link we
    // actually want carries {{ .TokenHash }} to this same path, which needs no
    // allow-list entry at all. See lib/passwordRecovery for why.
    const { error } = await supabase.auth.resetPasswordForEmail(address, {
      redirectTo: `${window.location.origin}${RESET_PATH}`,
    })
    const result = classifyRecoverySend(error)
    setSentTo(address)
    setOutcome(result)
    setBusy(false)
  }

  return (
    <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl">
      <div className="flex flex-col items-center mb-6 text-center">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mb-4 shadow-lg shadow-accent/20">
          <KeyRound className="w-6 h-6 text-black" aria-hidden />
        </div>
        <h1 className="text-lg font-bold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Enter the email you sign in with and we’ll send you a link to choose a new one.
        </p>
      </div>

      {/* The accepted answer replaces the form: re-submitting the same address
          inside a minute is refused by Supabase anyway, and a form still sitting
          there invites exactly that. */}
      {outcome?.kind === 'accepted' ? (
        <div>
          <Banner tone="success" icon={MailCheck}>{acceptedMessage(sentTo)}</Banner>
          <p className="mt-4 text-sm text-ink-muted leading-relaxed">
            Nothing yet? Check spam, then try again in a minute — links can only be
            requested once every sixty seconds.
          </p>
          <Button
            variant="secondary" className="w-full mt-4 tap-target h-12"
            onClick={() => { setOutcome(null); setEmail(sentTo) }}
          >
            Use a different email
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {/* Only ever the honest failure. The accepted case is handled above and
              the ambiguous ones never get here — classifyRecoverySend folds them. */}
          {outcome?.kind === 'unavailable' && <Banner tone="danger">{UNAVAILABLE_MESSAGE}</Banner>}
          <Input
            label="Email"
            type="email"
            inputMode="email"
            placeholder="you@edgepropertyservices.ca"
            value={email}
            onChange={e => { setEmail(e.target.value); if (fieldError) setFieldError('') }}
            error={fieldError || undefined}
            // 'username', not 'email': it tells a password manager which saved
            // login this page is about, so it offers the right one.
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          <Button type="submit" className="w-full tap-target h-12" loading={busy} disabled={!email.trim()}>
            Send reset link
          </Button>
        </form>
      )}

      <div className="mt-6 pt-5 border-t border-border">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink transition-colors tap-target"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden />
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
