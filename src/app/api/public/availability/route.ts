import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Retired: this route used a bare business token and exposed dates before a
// customer had accepted a written quote or paid its configured deposit. Portal
// scheduling now uses /api/portal/quote-schedule with a customer-scoped token.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    error: 'Direct public availability is retired. Accept the written quote in the customer portal first.',
    state: 'quote_required',
  }, { status: 410, headers: { ...CORS, 'Cache-Control': 'no-store' } })
}
