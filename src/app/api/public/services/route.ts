import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { formatServicePrice } from '@/lib/servicePricing'
import type { PricingDisplayType } from '@/types'

export const dynamic = 'force-dynamic' // token-keyed; we set our own Cache-Control

// GET /api/public/services?token=<booking_token>
// The website's service list + pricing, straight from EdgeQuote Service Templates — so
// the site never duplicates services or prices. Cached at the edge (5 min) so it stays
// fast and SEO-friendly. Open CORS so a browser on the marketing site can read it.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

interface ServiceRow {
  id: string; name: string; category: string; description: string | null
  default_rate: number; pricing_display_type: PricingDisplayType
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = new URL(req.url).searchParams.get('token') || ''
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400, headers: CORS })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('public_services', { p_token: token })
  if (error) return NextResponse.json({ error: 'unavailable' }, { status: 502, headers: CORS })
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404, headers: CORS })

  const d = data as { business: unknown; services: ServiceRow[] }
  // Format each price through THE canonical formatter so labels match EdgeQuote exactly.
  const services = (d.services || []).map(s => ({
    ...s,
    priceLabel: formatServicePrice({ pricing_display_type: s.pricing_display_type, default_rate: Number(s.default_rate) }),
  }))
  return NextResponse.json({ business: d.business, services }, {
    headers: { ...CORS, 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  })
}