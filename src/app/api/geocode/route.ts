import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const address = (body.address || '').trim()

    if (!address) {
      return NextResponse.json({ error: 'Address is empty.' }, { status: 422 })
    }

    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Maps API key not found on server. Check .env.local and restart.' }, { status: 500 })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    url.searchParams.set('address', address)
    url.searchParams.set('key', key)

    const res = await fetch(url.toString())
    const data = await res.json()

    if (data.status && data.status !== 'OK') {
      return NextResponse.json(
        { error: `Google: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}` },
        { status: 422 }
      )
    }

    const result = data?.results?.[0]
    const loc = result?.geometry?.location
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      return NextResponse.json(
        { error: 'Could not geocode that address. Try adding the city, e.g. "..., Calgary, AB".' },
        { status: 422 }
      )
    }

    return NextResponse.json({
      lat: loc.lat,
      lng: loc.lng,
      formatted: result.formatted_address || address,
    })
  } catch {
    return NextResponse.json({ error: 'Geocoding failed (server error).' }, { status: 500 })
  }
}