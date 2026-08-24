import { OAUTH_START_PATH } from '@/lib/googleAuth'

// ── Continue with Google ─────────────────────────────────────────────────────
// An ANCHOR, not a button, and deliberately so on three counts:
//
//  1. It is a navigation — the flow begins on the server, at OAUTH_START_PATH,
//     which writes the PKCE verifier cookie and redirects on to Google. There is
//     no client-side handler to run and nothing to await.
//  2. There is no handler to mis-wire, no loading state to get stuck in, and
//     no way for a failed fetch to leave the button dead. The browser does the
//     one thing it is best at.
//     ⚠️ It does NOT render before the page's JavaScript. Both screens that use
//     this are client components (login sits inside <Suspense fallback={null}>),
//     so nothing here exists until hydration — curl'ing production /login
//     returns no button at all. An earlier version of this comment claimed a
//     no-JS benefit that measuring production disproved. Recorded rather than
//     quietly deleted: a comment that overclaims is how the next person is misled.
//  3. A <button> inside the sign-in <form> would default to type="submit" and
//     fire the password submit instead — the trap this codebase has been caught
//     by before. An anchor cannot submit anything.
//
// ⚠️ GOOGLE BRANDING IS A REQUIREMENT, NOT A STYLE CHOICE. Google's identity
// guidelines govern this control: the four-colour "G" must not be recoloured,
// cropped, rotated or placed on a busy ground, and the label must read "Sign in
// with Google" or "Continue with Google" — not "Google", not "Login". A white
// button carrying the colour mark is Google's own light treatment and is
// unambiguously compliant, which is why this one control does not inherit the
// dark surface everything around it uses.

/** The official four-colour G. Fixed viewBox, untouched fills. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5 shrink-0" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export interface GoogleButtonProps {
  /** 'Continue with Google' when creating an account, 'Sign in with Google'
   *  when returning. Both are permitted labels; using the one that matches the
   *  screen is what stops the button reading as a second, different thing. */
  label: 'Continue with Google' | 'Sign in with Google'
  /** Where to land afterwards. Carried to the start route, validated there and
   *  again in the callback — never trusted at either end. */
  next?: string | null
  /** An in-flight private-beta invite, passed straight through to the start
   *  route, which moves it into an httpOnly cookie. */
  invite?: string | null
}

export function GoogleButton({ label, next, invite }: GoogleButtonProps) {
  const q = new URLSearchParams()
  if (next) q.set('next', next)
  if (invite) q.set('invite', invite)
  const href = q.toString() ? `${OAUTH_START_PATH}?${q}` : OAUTH_START_PATH

  return (
    <a
      href={href}
      data-testid="google-auth"
      className="tap-target flex h-12 w-full items-center justify-center gap-3 rounded-xl
                 bg-white px-4 text-[15px] font-medium text-[#1f1f1f]
                 shadow-sm transition-colors hover:bg-[#f2f2f2] active:bg-[#e8e8e8]
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                 focus-visible:outline-accent"
    >
      <GoogleMark />
      {label}
    </a>
  )
}

/** The "or" rule between Google and the email form. Its own component because
 *  both screens use it and a divider that drifts between them is the kind of
 *  small wrongness that makes a login page feel assembled rather than designed. */
export function AuthDivider() {
  return (
    <div className="my-5 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
