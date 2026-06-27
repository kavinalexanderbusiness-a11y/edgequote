import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isChannel } from '@/lib/marketing/channels'

// GET /api/marketing/connect/callback — the OAuth redirect target. Validates the CSRF
// state, then (once a provider's token exchange + app secret are configured) swaps the
// code for tokens and inserts an api-mode social_connection. Token exchange is
// provider-specific and ships with each integration; until then this completes the
// round trip honestly and returns the owner to the Studio.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))

  const params = new URL(req.url).searchParams
  const platform = params.get('platform') || ''
  const code = params.get('code')
  const oauthError = params.get('error')
  const state = params.get('state') || ''

  const back = new URL('/dashboard/grow/studio', req.url)
  back.searchParams.set('platform', platform)

  // Validate the state cookie (CSRF).
  const cookie = req.cookies.get('eq_oauth_state')?.value || ''
  const res = (target: URL) => { const r = NextResponse.redirect(target); r.cookies.delete('eq_oauth_state'); return r }

  if (oauthError) { back.searchParams.set('connect', 'denied'); return res(back) }
  if (!isChannel(platform) || cookie !== `${platform}:${state}` || !code) {
    back.searchParams.set('connect', 'error')
    return res(back)
  }

  // Token exchange + account fetch land here per provider (using <PLATFORM>_CLIENT_SECRET),
  // then: insert into social_connections { mode:'api', provider, account_id, account_name,
  // access_token, token_expires_at, scopes, status:'connected' }. Not yet wired → pending.
  back.searchParams.set('connect', 'pending')
  return res(back)
}