import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  // Authenticated owners only — proxies the server-side Google Maps billing key.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const origin = (body.origin || '').trim()
    const destination = (body.destination || '').trim()

    if (!origin) {
      return NextResponse.json({ error: 'Base address is empty — set it in Settings and Save.' }, { status: 422 })
    }
    if (!destination) {
      return NextResponse.json({ error: 'Service address is empty — enter it on the quote.' }, { status: 422 })
    }

    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Maps API key not found on server. Check .env.local and restart.' }, { status: 500 })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
    url.searchParams.set('origins', origin)
    url.searchParams.set('destinations', destination)
    url.searchParams.set('units', 'metric')
    url.searchParams.set('key', key)

    const res = await fetch(url.toString())
    const data = await res.json()

    // Surface Google's top-level status (e.g. REQUEST_DENIED) directly
    if (data.status && data.status !== 'OK') {
      return NextResponse.json(
        { error: `Google: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}` },
        { status: 422 }
      )
    }

    const element = data?.rows?.[0]?.elements?.[0]
    if (!element || element.status !== 'OK') {
      return NextResponse.json(
        { error: `Address issue: ${element?.status || 'no result'}. Try adding the city, e.g. "..., Calgary, AB".` },
        { status: 422 }
      )
    }

    const km = Math.round((element.distance.value / 1000) * 10) / 10
    const durationText = element.duration?.text || null
    return NextResponse.json({ km, durationText })
  } catch {
    return NextResponse.json({ error: 'Distance lookup failed (server error).' }, { status: 500 })
  }
}