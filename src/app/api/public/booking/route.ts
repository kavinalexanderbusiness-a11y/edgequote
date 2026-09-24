import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Retired: the legacy endpoint could turn anonymous browser values directly into
// a scheduled visit. The website lead door creates a review-required draft; the
// customer portal handles written acceptance, deposit and live availability.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({
    error: 'Direct booking is retired. Submit a quote request, then accept the written quote in the customer portal.',
    state: 'quote_required',
  }, { status: 410, headers: { ...CORS, 'Cache-Control': 'no-store' } })
}
