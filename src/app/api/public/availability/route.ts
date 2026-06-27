import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// GET /api/public/availability?token=<booking_token>&days=14
// The next bookable days, derived from the owner's preferred work days + daily capacity
// minus jobs already on the EdgeQuote calendar — so the website never guesses or stores
// its own availability. Short edge cache (60s) keeps it fast without going stale.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url)
  const token = url.searchParams.get('token') || ''
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 14))
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400, headers: CORS })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('public_availability', { p_token: token, p_days: days })
  if (error) return NextResponse.json({ error: 'unavailable' }, { status: 502, headers: CORS })
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404, headers: CORS })

  return NextResponse.json({ days: data }, {
    headers: { ...CORS, 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  })
}