import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Pull the best human area name from Google address components.
// Priority: community/neighborhood → sublocality (district) → null.
// (City-level fallback is handled by the shared neighborhoodKey engine.)
function extractNeighborhood(results: Array<{ address_components?: Array<{ long_name: string; types: string[] }> }>): string | null {
  for (const wanted of ['neighborhood', 'sublocality_level_1', 'sublocality']) {
    for (const r of results || []) {
      const hit = r.address_components?.find(c => c.types.includes(wanted))
      if (hit?.long_name) return hit.long_name
    }
  }
  return null
}

export async function POST(req: NextRequest) {
  // Authenticated owners only — this proxies the server-side Google Maps billing key,
  // so an open endpoint would let anyone run up the owner's Maps bill / quota.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const address = (body.address || '').trim()
    const lat = typeof body.lat === 'number' ? body.lat : null
    const lng = typeof body.lng === 'number' ? body.lng : null

    if (!address && (lat == null || lng == null)) {
      return NextResponse.json({ error: 'Provide an address, or lat+lng for reverse lookup.' }, { status: 422 })
    }

    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Maps API key not found on server. Check .env.local and restart.' }, { status: 500 })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    if (address) url.searchParams.set('address', address)
    else url.searchParams.set('latlng', `${lat},${lng}`)
    url.searchParams.set('key', key)

    const res = await fetch(url.toString())
    const data = await res.json()

    if (data.status && data.status !== 'OK') {
      return NextResponse.json(
        { error: `Google: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}` },
        { status: 422 }
      )
    }

    const neighborhood = extractNeighborhood(data?.results || [])

    // Reverse lookup: the caller only wants the area name.
    if (!address) {
      return NextResponse.json({ neighborhood })
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
      neighborhood,
      // Precision signal so the UI can say "approximate" instead of silently
      // dropping a pin on the wrong lot. ROOFTOP/RANGE_INTERPOLATED = lot-accurate.
      precise: (result?.geometry?.location_type === 'ROOFTOP' || result?.geometry?.location_type === 'RANGE_INTERPOLATED') && !result?.partial_match,
    })
  } catch {
    return NextResponse.json({ error: 'Geocoding failed (server error).' }, { status: 500 })
  }
}
