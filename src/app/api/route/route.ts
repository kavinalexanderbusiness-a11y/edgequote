import { NextRequest, NextResponse } from 'next/server'

interface LatLng { lat: number; lng: number }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const base: LatLng | null = body.base || null
    const stops: LatLng[] = Array.isArray(body.stops) ? body.stops : []

    if (!base || typeof base.lat !== 'number' || typeof base.lng !== 'number') {
      return NextResponse.json({ error: 'Missing base coordinate.' }, { status: 422 })
    }
    if (stops.length === 0) {
      return NextResponse.json({ error: 'No stops to optimize.' }, { status: 422 })
    }

    const key = process.env.GOOGLE_MAPS_API_KEY
    if (!key) {
      return NextResponse.json({ error: 'Maps API key not found on server.' }, { status: 500 })
    }

    const baseStr = `${base.lat},${base.lng}`
    const waypointStr = 'optimize:true|' + stops.map(s => `${s.lat},${s.lng}`).join('|')

    const url = new URL('https://maps.googleapis.com/maps/api/directions/json')
    url.searchParams.set('origin', baseStr)
    url.searchParams.set('destination', baseStr) // round trip back to base
    url.searchParams.set('waypoints', waypointStr)
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

    const route = data?.routes?.[0]
    if (!route) {
      return NextResponse.json({ error: 'No route returned.' }, { status: 422 })
    }

    const order: number[] = route.waypoint_order || stops.map((_, i) => i)

    const legs = route.legs || []
    const legKm: number[] = legs.map((l: { distance?: { value?: number } }) =>
      Math.round(((l.distance?.value || 0) / 1000) * 10) / 10
    )
    const totalMeters = legs.reduce(
      (sum: number, l: { distance?: { value?: number } }) => sum + (l.distance?.value || 0), 0
    )
    const totalKm = Math.round((totalMeters / 1000) * 10) / 10

    return NextResponse.json({ order, legKm, totalKm })
  } catch {
    return NextResponse.json({ error: 'Route optimization failed (server error).' }, { status: 500 })
  }
}