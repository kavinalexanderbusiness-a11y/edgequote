import 'server-only'

// ── AI Vision — satellite imagery (server-only) ───────────────────────────────
// Fetches the SAME Google satellite imagery the app already uses for measuring,
// as a flat top-down still, and returns it base64-encoded so it can be handed to
// the vision model WITHOUT the API key ever leaving the server. Uses the
// server-side GOOGLE_MAPS_API_KEY (the same key the geocode/distance routes use),
// never the public browser key.

export const SATELLITE_ZOOM = 20 // property-level detail (driveway / beds / edges visible)

export interface FetchedImage {
  mediaType: 'image/jpeg'
  dataBase64: string
}

// Returns the property's satellite still, or null if maps aren't configured / the
// fetch fails — callers degrade to analysing photos only. Never throws.
export async function fetchSatelliteImage(
  lat: number,
  lng: number,
  zoom: number = SATELLITE_ZOOM,
): Promise<FetchedImage | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  // scale=2 → effectively 1280×1280, comfortably under the model's image limits
  // while keeping edges/beds legible. format=jpg keeps the payload small.
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap')
  url.searchParams.set('center', `${lat},${lng}`)
  url.searchParams.set('zoom', String(zoom))
  url.searchParams.set('size', '640x640')
  url.searchParams.set('scale', '2')
  url.searchParams.set('maptype', 'satellite')
  url.searchParams.set('format', 'jpg')
  url.searchParams.set('key', key)
  try {
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    return { mediaType: 'image/jpeg', dataBase64: buf.toString('base64') }
  } catch {
    return null
  }
}
