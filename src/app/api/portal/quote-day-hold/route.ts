import { NextRequest, NextResponse } from 'next/server'
import { parsePortalScheduleQuery } from '@/lib/publicBookingContract'
import { consumeTokenIntakeLimit } from '@/lib/publicIntakeSecurity'
import { logSafeServerError } from '@/lib/serverError'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEADERS = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || Array.isArray(body)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: HEADERS })
  }
  const parsed = parsePortalScheduleQuery({
    token: body.token,
    quoteId: body.quoteId,
    date: body.date,
  })
  if (!parsed.ok || !parsed.date) {
    return NextResponse.json({ error: parsed.ok ? 'invalid date' : parsed.error }, { status: 400, headers: HEADERS })
  }
  const rate = await consumeTokenIntakeLimit(req, parsed.token, 'automatic-quote-day-hold', 10)
  if (rate === 'limited') {
    return NextResponse.json({ error: 'too many requests' }, { status: 429, headers: HEADERS })
  }
  if (rate === 'unavailable') {
    return NextResponse.json({ error: 'day request unavailable' }, { status: 503, headers: HEADERS })
  }
  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'day request unavailable' }, { status: 503, headers: HEADERS })

  const { error: expiryError } = await admin.rpc('expire_automatic_quote_day_holds', {
    p_token: parsed.token,
  })
  if (expiryError) {
    logSafeServerError('portal.automatic_quote_day_hold.expiry', expiryError)
    return NextResponse.json({ error: 'day request unavailable' }, { status: 502, headers: HEADERS })
  }
  const { data, error } = await admin.rpc('reserve_automatic_quote_day', {
    p_token: parsed.token,
    p_quote_id: parsed.quoteId,
    p_date: parsed.date,
  })
  if (error || !data) {
    logSafeServerError('portal.automatic_quote_day_hold', error)
    return NextResponse.json({ error: 'day request unavailable' }, { status: 502, headers: HEADERS })
  }
  const state = String((data as { state?: unknown }).state || '')
  const ok = state === 'held_for_review' || state === 'confirmed'
  return NextResponse.json(data, { status: ok ? 200 : 409, headers: HEADERS })
}
