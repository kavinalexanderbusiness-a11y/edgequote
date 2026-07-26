import { NextRequest, NextResponse } from 'next/server'
import { authorizePlaces, fetchPlaceSuggestions } from '@/lib/places'

export const dynamic = 'force-dynamic'

// POST { input, sessionToken?, bookingToken? } → { suggestions: [{ placeId, text }] }
// Server-side so the referrer-restricted browser key never has to reach Google —
// see src/lib/places.ts for why autocomplete lives on the same proxy as geocode.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const input = String(body.input || '').trim()
  const sessionToken = body.sessionToken ? String(body.sessionToken) : undefined
  const bookingToken = body.bookingToken ? String(body.bookingToken) : undefined

  if (!(await authorizePlaces(bookingToken))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Mirror the component's own guard — no point spending a call on 1–2 chars.
  if (input.length < 3) return NextResponse.json({ suggestions: [] })

  try {
    const suggestions = await fetchPlaceSuggestions(input, sessionToken)
    return NextResponse.json({ suggestions })
  } catch (e) {
    // A missing server key is a real misconfiguration the UI should surface; a
    // transient Google/network error should just show no suggestions.
    const status = e instanceof Error && e.message === 'missing-maps-key' ? 500 : 502
    return NextResponse.json({ error: 'autocomplete failed', suggestions: [] }, { status })
  }
}
