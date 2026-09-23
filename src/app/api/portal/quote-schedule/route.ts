import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { parsePortalScheduleQuery } from '@/lib/publicBookingContract'
import { logSafeServerError } from '@/lib/serverError'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const HEADERS = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || Array.isArray(body)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers: HEADERS })
  }
  if (body.action !== 'availability' && body.action !== 'schedule') {
    return NextResponse.json({ error: 'invalid action' }, { status: 400, headers: HEADERS })
  }
  const parsed = parsePortalScheduleQuery({ token: body.token, quoteId: body.quoteId, date: body.date, days: body.days })
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: HEADERS })
  }
  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'scheduling unavailable' }, { status: 503, headers: HEADERS })

  // Keep the portal capability out of query strings, access logs and referrer
  // histories. Availability is a read, but it still travels in a JSON POST body.
  if (body.action === 'availability') {
    const { data, error } = await admin.rpc('public_quote_schedule_availability', {
      p_token: parsed.token,
      p_quote_id: parsed.quoteId,
      p_days: parsed.days,
    })
    if (error || !data) {
      logSafeServerError('portal.quote_schedule.availability', error)
      return NextResponse.json({ error: 'scheduling unavailable' }, { status: 502, headers: HEADERS })
    }
    return NextResponse.json(data, { status: 200, headers: HEADERS })
  }

  if (!parsed.date) {
    return NextResponse.json({ error: 'invalid date' }, { status: 400, headers: HEADERS })
  }

  const { data, error } = await admin.rpc('portal_schedule_accepted_quote', {
    p_token: parsed.token,
    p_quote_id: parsed.quoteId,
    p_date: parsed.date,
  })
  if (error || !data) {
    logSafeServerError('portal.quote_schedule.create', error)
    return NextResponse.json({ error: 'scheduling unavailable' }, { status: 502, headers: HEADERS })
  }
  const state = String((data as { state?: unknown }).state || '')
  const ok = state === 'scheduled' || state === 'already_scheduled'
  return NextResponse.json(data, { status: ok ? 200 : 409, headers: HEADERS })
}
