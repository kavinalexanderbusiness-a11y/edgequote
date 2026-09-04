'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { FORGOT_PATH } from '@/lib/passwordRecovery'
import { resolveAppRole, landingFor } from '@/lib/crewAccess'
import { GoogleButton, AuthDivider } from '@/components/auth/GoogleButton'
import {
  AUTH_ERROR_PARAM, GOOGLE_AUTH_ERROR_TEXT, readGoogleAuthError, safeReturnPath,
  readProviderFragmentError, type GoogleAuthError,
} from '@/lib/googleAuth'
import { Zap } from 'lucide-react'

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return <Suspense fallback={null}><LoginForm /></Suspense>
}

function LoginForm() {
  const router = useRouter()
  // Where the middleware was sending them before it bounced them here. Same-path
  // only — an absolute or protocol-relative value would be an open redirect, and
  // this parameter is attacker-controllable. safeReturnPath is THE gate, shared
  // with the OAuth start route and callback: this was an inline two-clause check
  // until Google sign-in gave the same rule two more callers, and a security
  // predicate living in three places is two places to forget to fix.
  const params = useSearchParams()
  const next = safeReturnPath(params.get('next'))
  // How a failed Google round trip comes home. A short stable code, never a
  // message from the provider — a reflected error string is how a login page
  // becomes a phishing surface.
  const queryAuthError = readGoogleAuthError(params.get(AUTH_ERROR_PARAM))
  // ⭐ The half the SERVER could not see. gotrue reports its OWN failures in the
  // URL fragment, which never reaches a server — so /auth/callback could only
  // read "no code" and fail back with the generic 'exchange'. Read here, the
  // fragment says which failure it actually was. See readProviderFragmentError.
  const [fragmentError, setFragmentError] = useState<GoogleAuthError | null>(null)
  useEffect(() => {
    const found = readProviderFragmentError(window.location.hash)
    if (!found) return
    setFragmentError(found)
    // Drop the fragment once it has been read. It is not ours to keep: it would
    // ride along to every page navigated to next, and re-render this banner over
    // a login that has since succeeded.
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch { /* a failed tidy-up must never block the message */ }
  }, [])
  // The fragment is the more specific of the two — the query only ever carries
  // the generic code in this case — so it wins when both are present.
  const authError = fragmentError ?? queryAuthError
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [brand, setBrand] = useState<{ url: string | null; scale: number }>({ url: null, scale: 100 })

  // Best-effort branding: settings aren't readable pre-auth (RLS), so reuse the
  // logo cached by the sidebar on this device. Falls back to default branding.
  useEffect(() => {
    try {
      const cached = window.localStorage.getItem('eq-logo')
      if (cached) { const c = JSON.parse(cached); if (c?.url) setBrand({ url: c.url, scale: c.scale || 100 }) }
    } catch { /* ignore */ }
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // Ask where this account belongs BEFORE navigating. The middleware would
    // correct a wrong guess, but only after the browser had already asked for
    // the owner's dashboard — which on a phone is a visible flash of the wrong
    // product, and for a worker it is the wrong product every single time.
    // `resolveAppRole` fails closed to 'none', and landingFor sends 'none' to
    // /dashboard, so an unreachable database lands exactly where this used to.
    const role = await resolveAppRole(supabase)
    router.push(next ?? landingFor(role))
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      {/* Background orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
        <div className="absolute w-[400px] h-[400px] rounded-full bg-blue-500 opacity-[0.04] blur-[120px] -top-20 -right-20" />
      </div>

      <main className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          {brand.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.url} alt="Logo" className="object-contain mb-4"
              style={{ height: Math.min(96, Math.round(48 * (brand.scale / 100))), maxWidth: 220 }} />
          ) : (
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mb-4 shadow-lg shadow-accent/20">
              <Zap className="w-6 h-6 text-black fill-black" />
            </div>
          )}
          <h1 className="text-xl font-bold tracking-tight text-ink">EdgeQuote AI</h1>
          <p className="text-sm text-ink-muted mt-1">Your field service workspace</p>
        </div>

        {/* Card */}
        <div className="bg-surface border border-border-strong rounded-card p-8 shadow-2xl">
          <h2 className="text-base font-semibold text-ink mb-6">Sign in to your account</h2>

          {/* A failed Google attempt lands ABOVE the controls, because the next
              thing this person does is choose between trying Google again and
              falling back to their password — and they cannot choose without
              first reading why the last attempt did not work. */}
          {authError && (
            <div className="mb-5">
              <Banner tone="danger">{GOOGLE_AUTH_ERROR_TEXT[authError]}</Banner>
            </div>
          )}

          <GoogleButton label="Sign in with Google" next={next} />
          <AuthDivider />

          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
            {error && <Banner tone="danger">{error}</Banner>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Sign In
            </Button>
          </form>

          {/* Below the button, not beside the password label: somebody reaches
              for this AFTER a sign-in has failed, and that is where their eye
              already is. */}
          <div className="mt-5 pt-5 border-t border-border text-center">
            <Link
              href={FORGOT_PATH}
              className="text-sm font-medium text-ink-muted hover:text-ink transition-colors tap-target inline-flex items-center justify-center"
            >
              Forgot your password?
            </Link>
          </div>
        </div>

        <p className="text-center text-xs text-ink-faint mt-6">
          Internal tool — not publicly accessible
        </p>
      </main>
    </div>
  )
}
