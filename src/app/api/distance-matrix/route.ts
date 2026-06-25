import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface LatLng { lat: number; lng: number }

// Real-road pairwise distances via Google Distance Matrix. The client batches and
// caches the results (lib/distance) so this is hit only for stop pairs we've never
// measured. Returns a rows[origin][destination] grid of { km, seconds } (or null
// for unreachable / failed elements). Mirrors /api/route's key + error handling.
export async function POST(req: NextRequest) {
  // Authenticated owners only — proxies the server-side Google Maps billing key.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const origins: LatLng[] = Array.isArray(body.origins) ? body.origins : []
    const destinations: LatLng[] = Array.isArray(body.destinations) ? body.destinations : []

    if (origins.length === 0 || destinations.length === 0) {
      return NextResponse.json({ error: 'origins and destinations are required.' }, { status: 422 })
    }
    // Distance Matrix caps at 100 elements per request — the client batches to stay
    // under this, but guard the route too.
    if (origins.length * destinations.length > 100) {
      return NextResponse.json({ error: 'Too many elements (max 100 per request).' }, { status: 422 })
    }

    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Maps API key not found on server.' }, { status: 500 })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
    url.searchParams.set('origins', origins.map(o => `${o.lat},${o.lng}`).join('|'))
    url.searchParams.set('destinations', destinations.map(d => `${d.lat},${d.lng}`).join('|'))
    url.searchParams.set('units', 'metric')
    url.searchParams.set('key', key)

    const res = await fetch(url.toString())
    const data = await res.json()

    if (data.status && data.status !== 'OK') {
      return NextResponse.json(
        { error: `Google: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}` },
        { status: 422 }
      )
    }

    const rows: ({ km: number; seconds: number | null } | null)[][] = (data.rows || []).map(
      (row: { elements?: { status?: string; distance?: { value?: number }; duration?: { value?: number } }[] }) =>
        (row.elements || []).map(e =>
          e.status === 'OK' && e.distance?.value != null
            ? { km: Math.round((e.distance.value / 1000) * 10) / 10, seconds: e.duration?.value ?? null }
            : null
        )
    )

    return NextResponse.json({ rows })
  } catch {
    return NextResponse.json({ error: 'Distance matrix failed (server error).' }, { status: 500 })
  }
}
