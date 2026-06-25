import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public intake for the website quote form. The site POSTs its full submission as
// JSON plus the owner's booking_token; everything is forwarded verbatim to the
// SECURITY DEFINER submit_website_lead RPC, which resolves the owner, de-dupes the
// customer, persists the property/lead, and threads it into Messages. CORS-open so a
// browser form on the marketing site can post directly.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'bad request' }, { status: 400, headers: CORS })

  const token = String((body as Record<string, unknown>).token || (body as Record<string, unknown>).booking_token || '')
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400, headers: CORS })

  // The whole submission (minus the token) is the audit payload + structured source.
  const payload = { ...(body as Record<string, unknown>) }
  delete payload.token; delete payload.booking_token

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('submit_website_lead', { p_token: token, p_payload: payload })
  if (error) {
    console.error('[website-lead] rpc error:', error.message)
    return NextResponse.json({ error: 'Could not submit your request. Please try again.' }, { status: 502, headers: CORS })
  }
  if (!data) return NextResponse.json({ error: 'This form is not currently accepting submissions.' }, { status: 404, headers: CORS })
  return NextResponse.json({ ok: true, ...(data as object) }, { headers: CORS })
}
