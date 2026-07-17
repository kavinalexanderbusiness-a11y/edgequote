import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// ── MMS media proxy ─────────────────────────────────────────────────────────────
// Streams a message attachment (stored as a Twilio media URL on messages.meta by
// the inbound webhook) to the signed-in owner. Twilio media requires the account's
// credentials to fetch, so the browser can never load it directly — and we don't
// copy files into our own storage: Twilio stays the system of record, this route
// only relays bytes. RLS scopes the message lookup to the owner's own rows, so a
// message id from another account resolves to nothing.

const TWILIO_HOSTS = new Set(['api.twilio.com'])

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('unauthorized', { status: 401 })

  const id = req.nextUrl.searchParams.get('id') || ''
  const idx = Math.max(0, parseInt(req.nextUrl.searchParams.get('i') || '0', 10) || 0)
  if (!id) return new NextResponse('bad request', { status: 400 })

  const { data: msg } = await supabase.from('messages').select('meta').eq('id', id).maybeSingle()
  const media = ((msg as { meta?: { media?: { url?: string; type?: string }[] } } | null)?.meta?.media) || []
  const item = media[idx]
  if (!item?.url) return new NextResponse('not found', { status: 404 })

  // Only ever fetch Twilio's API host — meta is app-written, but a proxy that
  // fetches arbitrary URLs from stored data is an SSRF the moment anything else
  // writes meta. Fail closed.
  let target: URL
  try { target = new URL(item.url) } catch { return new NextResponse('not found', { status: 404 }) }
  if (target.protocol !== 'https:' || !TWILIO_HOSTS.has(target.hostname)) return new NextResponse('not found', { status: 404 })

  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return new NextResponse('messaging not configured', { status: 404 })

  // Twilio 302s media to short-lived storage; fetch follows it (and drops the
  // Authorization header on the cross-origin hop, which is exactly right).
  const res = await fetch(target.toString(), {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
  })
  if (!res.ok || !res.body) return new NextResponse('unavailable', { status: 502 })

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') || item.type || 'application/octet-stream',
      // Private: this is customer content behind the owner's session.
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
