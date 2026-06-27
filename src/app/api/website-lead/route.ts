import { NextRequest, NextResponse } from 'next/server'
import { submitLead } from '@/lib/intake'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public intake for the website QUOTE form (kept for backward compatibility). The
// site POSTs its full submission as JSON plus the owner's booking_token; it routes
// through the SAME shared intake pipeline as every other source (see lib/intake +
// /api/intake). CORS-open so a browser form on the marketing site can post directly.
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

  const b = body as Record<string, unknown>
  const token = String(b.token || b.booking_token || '')

  const payload = { ...b }
  delete payload.token; delete payload.booking_token; delete payload.source

  const r = await submitLead({ token, source: 'Website', payload })
  return NextResponse.json(r.body, { status: r.status, headers: CORS })
}
