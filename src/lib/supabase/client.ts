import { createBrowserClient } from '@supabase/ssr'
import { sessionCookieOptions } from './cookieSecurity'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // ⭐ The Secure flag, which @supabase/ssr does not set for us. Derived from
    // the configured origin rather than from the page — see cookieSecurity. The
    // window.location fallback is for local dev, where NEXT_PUBLIC_APP_URL is
    // unset and the answer MUST be false: a Secure cookie is dropped over http://,
    // so getting this wrong means nobody can sign in on localhost at all.
    { cookieOptions: sessionCookieOptions(typeof window === 'undefined' ? null : window.location.origin) },
  )
}
