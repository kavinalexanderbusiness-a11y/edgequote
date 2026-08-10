'use client'

import { useState } from 'react'
import { CheckCircle2, Loader2, Mail } from 'lucide-react'
import { NEUTRAL_RESULT, normalizeEmail } from '@/lib/portalAccess'

// Five states, and deliberately NOT a sixth:
//   idle · invalid · sending · sent (neutral) · error (retryable)
//
// There is no "we couldn't find that email". The server answers identically for
// an address it knows and one it doesn't, and the UI has to keep that promise —
// a "not found" message here would hand back exactly the answer the API refuses
// to give, and turn this form into an account-checker for anyone with a list.
type State = 'idle' | 'sending' | 'sent' | 'error'

export function PortalAccessForm() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)

  // Format only — never existence. Checked before sending so an obvious typo
  // doesn't spend one of the address's rate-limit slots.
  const invalid = email.trim() !== '' && normalizeEmail(email) === null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (state === 'sending') return
    if (normalizeEmail(email) === null) { setError('Please enter a valid email address.'); return }
    setState('sending'); setError(null)
    try {
      const res = await fetch('/api/public/portal-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const d = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        // 400 / 429 / 503 — all decided before any lookup, so none of them says
        // anything about whether the address is a customer.
        setState('error')
        setError(d.error || 'Something went wrong. Please try again.')
        return
      }
      setState('sent')
    } catch {
      setState('error')
      setError('We couldn’t reach the server. Please check your connection and try again.')
    }
  }

  if (state === 'sent') {
    return (
      <div className="mt-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-5 text-center">
        <CheckCircle2 aria-hidden className="w-7 h-7 text-emerald-400 mx-auto" />
        <p className="mt-3 text-sm leading-relaxed text-ink">{NEUTRAL_RESULT}</p>
        <button type="button"
          onClick={() => { setState('idle'); setEmail(''); setError(null) }}
          className="mt-4 text-xs font-semibold text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mt-6" noValidate>
      <label htmlFor="pa-email" className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">Email</label>
      <div className="mt-1.5 relative">
        <Mail aria-hidden className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          id="pa-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          value={email}
          onChange={e => { setEmail(e.target.value); if (state === 'error') { setState('idle'); setError(null) } }}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? 'pa-error' : undefined}
          disabled={state === 'sending'}
          // 16px keeps iOS from zooming the viewport on focus; min-h-[48px] is the
          // thumb target this page is almost always tapped with.
          className="w-full min-h-[48px] rounded-xl border border-border bg-bg-secondary pl-9 pr-3 py-3 text-base text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
        />
      </div>
      {invalid && !error && (
        <p className="mt-1.5 text-xs text-amber-400">That doesn’t look like an email address yet.</p>
      )}
      {error && <p id="pa-error" role="alert" className="mt-1.5 text-xs text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={state === 'sending' || email.trim() === '' || invalid}
        className="mt-4 w-full min-h-[48px] rounded-xl bg-accent text-black font-semibold text-sm flex items-center justify-center gap-2 transition-opacity active:scale-[0.99] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {state === 'sending'
          ? <><Loader2 aria-hidden className="w-4 h-4 animate-spin" /> Sending…</>
          : 'Send portal link'}
      </button>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
        No password needed. The link goes to your email and opens your portal directly.
      </p>
    </form>
  )
}
