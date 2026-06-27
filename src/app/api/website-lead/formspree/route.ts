import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Formspree adapter for the website contact form. Point a Formspree form's webhook (or
// AJAX action) at:  /api/website-lead/formspree?token=<your booking_token>
// Formspree's field names vary (name / email / _replyto / message / phone / address), so
// this normalises them, then forwards to the SAME submit_website_lead RPC the native
// intake uses — which de-dupes the customer and auto-creates customer + property + lead +
// conversation. No manual importing, and zero duplicated logic.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k] ?? o[k.toLowerCase()] ?? o[k.charAt(0).toUpperCase() + k.slice(1)]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url)
  const token = url.searchParams.get('token') || ''

  // Formspree can deliver JSON (webhook) or form-encoded (direct action). Handle both.
  let raw: Record<string, unknown> = {}
  const ct = req.headers.get('content-type') || ''
  try {
    if (ct.includes('application/json')) raw = (await req.json()) as Record<string, unknown>
    else { const fd = await req.formData(); fd.forEach((v, k) => { raw[k] = typeof v === 'string' ? v : '' }) }
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: CORS })
  }
  // Some Formspree payloads nest the fields under `data` / `submission`.
  const flat: Record<string, unknown> = { ...raw, ...((raw.data as object) || {}), ...((raw.submission as object) || {}) }
  const tok = token || (typeof flat.token === 'string' ? flat.token : '') || (typeof flat.booking_token === 'string' ? flat.booking_token : '')
  if (!tok) return NextResponse.json({ error: 'missing token' }, { status: 400, headers: CORS })

  // Map Formspree's common field names onto the RPC's expected keys.
  const payload: Record<string, string> = {}
  const set = (k: string, v?: string) => { if (v) payload[k] = v }
  set('name', pick(flat, ['name', 'fullName', 'full_name']))
  set('firstName', pick(flat, ['firstName', 'first_name', 'first']))
  set('lastName', pick(flat, ['lastName', 'last_name', 'last']))
  set('email', pick(flat, ['email', '_replyto', 'Email', 'e-mail']))
  set('phone', pick(flat, ['phone', 'tel', 'telephone', 'Phone', 'mobile']))
  set('address', pick(flat, ['address', 'serviceAddress', 'service_address', 'street']))
  set('city', pick(flat, ['city']))
  set('postalCode', pick(flat, ['postalCode', 'postal_code', 'zip', 'postal']))
  set('requestedServices', pick(flat, ['requestedServices', 'services', 'service', 'serviceType']))
  set('details', pick(flat, ['message', 'details', 'comments', 'notes', 'Message']))
  payload.source = 'formspree'

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('submit_website_lead', { p_token: tok, p_payload: payload })
  if (error) {
    console.error('[website-lead/formspree] rpc error:', error.message)
    return NextResponse.json({ error: 'Could not submit your request.' }, { status: 502, headers: CORS })
  }
  if (!data) return NextResponse.json({ error: 'This form is not accepting submissions.' }, { status: 404, headers: CORS })
  const result = data as { error?: string; lead_id?: string; customer_id?: string }
  if (result.error === 'rate_limited') return NextResponse.json({ error: 'Too many requests — try again shortly.' }, { status: 429, headers: CORS })
  return NextResponse.json({ ok: true, ...(result as object) }, { headers: CORS })
}
