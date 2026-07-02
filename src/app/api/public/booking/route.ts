import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// POST /api/public/booking?token=<booking_token>   (token may also be in the body)
// The website's primary booking path. EdgeQuote de-dupes the customer (returning
// customers are recognised automatically), creates the property, and EITHER books a job
// (when a real date + service were chosen) OR raises a 'sent' quote — then notifies the
// owner in Messages. If anything here is unavailable, the site should fall back to the
// existing Formspree / /api/website-lead intake. Never cached.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'bad request' }, { status: 400, headers: CORS })

  const token = new URL(req.url).searchParams.get('token') || String(body.token || body.booking_token || '')
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400, headers: CORS })
  const payload = { ...body }
  delete payload.token; delete payload.booking_token

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('book_service', { p_token: token, p_payload: payload })
  if (error) {
    console.error('[public/booking] rpc error:', error.message)
    return NextResponse.json({ error: 'Could not complete your booking. Please try again.' }, { status: 502, headers: CORS })
  }
  if (!data) return NextResponse.json({ error: 'This business is not accepting online bookings.' }, { status: 404, headers: CORS })
  const result = data as { error?: string; mode?: string; returning?: boolean }
  if (result.error === 'rate_limited') return NextResponse.json({ error: 'Too many requests — please try again shortly.' }, { status: 429, headers: CORS })
  if (result.error === 'missing_name') return NextResponse.json({ error: 'Please include your name.' }, { status: 400, headers: CORS })
  return NextResponse.json({ ok: true, ...(result as object) }, { headers: CORS })
}