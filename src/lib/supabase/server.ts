import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sessionCookieOptions } from './cookieSecurity'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // No request origin in hand here (this runs inside Server Components as
      // well as route handlers), so the configured NEXT_PUBLIC_APP_URL answers —
      // which is exactly what production has set. See lib/supabase/cookieSecurity.
      cookieOptions: sessionCookieOptions(),
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component — cookies set in middleware
          }
        },
      },
    }
  )
}