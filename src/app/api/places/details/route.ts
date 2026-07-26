import { NextRequest, NextResponse } from 'next/server'
import { authorizePlaces, fetchPlaceDetails } from '@/lib/places'

export const dynamic = 'force-dynamic'

// POST { placeId, sessionToken?, bookingToken? } → { place: ParsedPlace }
// The second half of a session: resolving a chosen prediction to a full,
// component-shaped address. Closes the autocomplete billing session.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const placeId = String(body.placeId || '').trim()
  const sessionToken = body.sessionToken ? String(body.sessionToken) : undefined
  const bookingToken = body.bookingToken ? String(body.bookingToken) : undefined

  if (!(await authorizePlaces(bookingToken))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!placeId) return NextResponse.json({ error: 'missing placeId' }, { status: 422 })

  try {
    const place = await fetchPlaceDetails(placeId, sessionToken)
    return NextResponse.json({ place })
  } catch (e) {
    const status = e instanceof Error && e.message === 'missing-maps-key' ? 500 : 502
    return NextResponse.json({ error: 'lookup failed' }, { status })
  }
}
