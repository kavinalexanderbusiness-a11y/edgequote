import { NextRequest, NextResponse } from 'next/server'
import { submitLead } from '@/lib/intake'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Generic external-lead intake — ONE endpoint for the website contact form,
// quote request, booking form, and any future integration. POST JSON:
//   { token, source?, name|firstName|lastName, phone, email, address, ...leadFields }
// `token` is the owner's booking_token; `source` labels the lead (defaults
// 'Website'). Everything routes through the shared submit_website_lead pipeline —
// the customer/property/lead/notification all appear instantly in EdgeQuote.
// CORS-open so a browser form on the marketing site can post directly.

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
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: CORS })
  }
  const b = body as Record<string, unknown>

  // Token may also come from the query (?token=) for hosted/no-code forms.
  const token = String(b.token || b.booking_token || new URL(req.url).searchParams.get('token') || '')
  const source = typeof b.source === 'string' && b.source.trim() ? b.source.trim() : 'Website'

  const payload = { ...b }
  delete payload.token; delete payload.booking_token; delete payload.source

  const r = await submitLead({ token, source, payload })
  return NextResponse.json(r.body, { status: r.status, headers: CORS })
}
