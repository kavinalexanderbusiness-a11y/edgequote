import 'server-only'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// ── THE Google Places seam ────────────────────────────────────────────────────
// Address autocomplete is the ONE Maps capability that used to call Google from
// the browser, with the public NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY. That key is
// HTTP-referrer restricted to the production domains, so the call is rejected on
// localhost and on every preview deploy (API_KEY_HTTP_REFERRER_BLOCKED) — and the
// component swallowed the error, so suggestions simply never appeared.
//
// Every other Maps call (geocode, distance, route) already proxies through the
// server with the unrestricted GOOGLE_MAPS_API_KEY, both to dodge the referrer
// wall and to keep the billing key off the client. This brings autocomplete onto
// the same seam so it behaves identically everywhere.

const PLACES = 'https://places.googleapis.com/v1'

// Who may spend the owner's Maps quota through this proxy:
//   • the dashboard — an authenticated owner (cookie session), OR
//   • the public /book/[token] funnel — an unauthenticated visitor carrying the
//     owner's booking_token, the same submit-only credential the rest of the
//     public booking API trusts.
// Anything else is refused, so this never becomes an open proxy onto the key.
export async function authorizePlaces(bookingToken?: string | null): Promise<boolean> {
  try {
    const supabase = await createServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) return true
  } catch {
    // No/expired session — fall through to the booking-token path.
  }

  const token = (bookingToken || '').trim()
  if (!token) return false
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return false

  // Resolve the token via the same SECURITY DEFINER RPC the public funnel uses to
  // load the business — a token that resolves to a real business is a valid caller.
  const anon = createSupabaseClient(url, anonKey)
  const { data } = await anon.rpc('get_booking_business', { p_token: token })
  return Array.isArray(data) ? data.length > 0 : !!data
}

export interface PlaceSuggestion {
  placeId: string
  text: string
}

// Autocomplete predictions from the Places API (New). Canada-scoped and
// session-tokened so a type-then-select round trip is billed as one session.
export async function fetchPlaceSuggestions(input: string, sessionToken?: string): Promise<PlaceSuggestion[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) throw new Error('missing-maps-key')

  const res = await fetch(`${PLACES}/places:autocomplete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({
      input,
      includedRegionCodes: ['ca'],
      ...(sessionToken ? { sessionToken } : {}),
    }),
  })
  if (!res.ok) throw new Error(`places-autocomplete-${res.status}`)
  const data = await res.json()
  const list: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }> = data?.suggestions || []
  return list
    .map(s => ({ placeId: s.placePrediction?.placeId || '', text: s.placePrediction?.text?.text || '' }))
    .filter(s => s.placeId && s.text)
}

export interface ParsedPlace {
  address: string   // street line (number + route), or formatted address as fallback
  city: string
  province: string
  postal: string
  formatted: string
  lat: number | null
  lng: number | null
}

// Full details for a selected prediction, parsed into the shape the address form
// consumes. Same field priorities the component used when it read the JS SDK's
// place object, so the parsed result is byte-for-byte what callers already expect.
export async function fetchPlaceDetails(placeId: string, sessionToken?: string): Promise<ParsedPlace> {
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) throw new Error('missing-maps-key')

  const url = new URL(`${PLACES}/places/${encodeURIComponent(placeId)}`)
  if (sessionToken) url.searchParams.set('sessionToken', sessionToken)
  const res = await fetch(url.toString(), {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'formattedAddress,addressComponents,location' },
  })
  if (!res.ok) throw new Error(`places-details-${res.status}`)
  const p = await res.json()

  const comps: Array<{ longText?: string; shortText?: string; types?: string[] }> = p.addressComponents || []
  const get = (type: string) => comps.find(c => (c.types || []).includes(type)) || null
  const streetNum = get('street_number')?.longText || ''
  const route = get('route')?.longText || ''
  const city = get('locality')?.longText || get('postal_town')?.longText || get('sublocality')?.longText || ''
  const province = get('administrative_area_level_1')?.shortText || ''
  const postal = get('postal_code')?.longText || ''
  const street = [streetNum, route].filter(Boolean).join(' ')
  const formatted = p.formattedAddress || ''
  const lat = typeof p.location?.latitude === 'number' ? p.location.latitude : null
  const lng = typeof p.location?.longitude === 'number' ? p.location.longitude : null

  return { address: street || formatted, city, province, postal, formatted, lat, lng }
}
