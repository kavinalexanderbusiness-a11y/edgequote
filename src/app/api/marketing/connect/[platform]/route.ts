import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isChannel } from '@/lib/marketing/channels'
import { provider, canConnectApi } from '@/lib/marketing/providers'

// GET /api/marketing/connect/[platform] — start the OAuth connect flow for a platform.
// Env-gated: when the platform's OAuth app is registered (client id env set) AND the
// provider is live, this redirects to the real consent screen with a CSRF state cookie.
// Until then it bounces back to the Studio with an honest "coming soon" so the owner
// uses the manual (copy & paste) path. The architecture is complete — only the app
// registration + token-exchange remain to flip a platform on.
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }): Promise<NextResponse> {
  const { platform } = await params
  const back = new URL('/dashboard/grow/studio', req.url)

  if (!isChannel(platform)) { back.searchParams.set('connect', 'error'); return NextResponse.redirect(back) }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))

  back.searchParams.set('platform', platform)
  if (!canConnectApi(platform)) {
    back.searchParams.set('connect', 'soon')
    return NextResponse.redirect(back)
  }

  const state = crypto.randomUUID()
  const redirectUri = new URL(`/api/marketing/connect/callback?platform=${platform}`, req.url).toString()
  const url = provider(platform).authorizeUrl(redirectUri, state)
  if (!url) { back.searchParams.set('connect', 'soon'); return NextResponse.redirect(back) }

  const res = NextResponse.redirect(url)
  res.cookies.set('eq_oauth_state', `${platform}:${state}`, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' })
  return res
}
