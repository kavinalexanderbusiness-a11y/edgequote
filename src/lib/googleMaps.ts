declare global {
  interface Window {
    google?: any
  }
}

let loadPromise: Promise<void> | null = null

// After the script tag loads, importLibrary may take a moment to attach.
// Poll until it's actually a function (or time out).
function waitForImportLibrary(resolve: () => void, reject: (e: Error) => void) {
  const start = Date.now()
  const tick = () => {
    if (typeof window.google?.maps?.importLibrary === 'function') { resolve(); return }
    if (Date.now() - start > 10000) {
      reject(new Error('Google Maps loaded but importLibrary never became available'))
      return
    }
    setTimeout(tick, 50)
  }
  tick()
}

export function loadGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (typeof window.google?.maps?.importLibrary === 'function') return Promise.resolve()
  if (loadPromise) return loadPromise

  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
  loadPromise = new Promise<void>((resolve, reject) => {
    if (!key) { reject(new Error('Missing NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY')); return }
    const existing = document.getElementById('gmaps-js') as HTMLScriptElement | null
    if (existing) {
      waitForImportLibrary(resolve, reject)
      return
    }
    const script = document.createElement('script')
    script.id = 'gmaps-js'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&libraries=places,geometry&loading=async`
    script.async = true
    script.onload = () => waitForImportLibrary(resolve, reject)
    script.onerror = () => reject(new Error('Failed to load Google Maps'))
    document.head.appendChild(script)
  })
  return loadPromise
}

// ── Click/pulse ring ─────────────────────────────────────────────────────────
// THE expanding-ring animation used for click feedback and the property-pin
// opening pulse — zoom-independent, purely cosmetic, never clickable.
export function flashRing(map: any, latLng: any, color = '#00C896') {
  const g = window.google
  if (!g?.maps || !map) return
  const pulse = new g.maps.Marker({
    position: latLng, map, clickable: false, zIndex: 3000,
    icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: color, fillOpacity: 0.45, strokeColor: '#FFFFFF', strokeWeight: 2 },
  })
  let frame = 0
  const FRAMES = 18
  const tick = () => {
    frame++
    const t = frame / FRAMES
    pulse.setIcon({
      path: g.maps.SymbolPath.CIRCLE, scale: 7 + t * 18,
      fillColor: color, fillOpacity: 0.4 * (1 - t),
      strokeColor: '#FFFFFF', strokeOpacity: 1 - t, strokeWeight: 2,
    })
    if (frame < FRAMES) requestAnimationFrame(tick)
    else pulse.setMap(null)
  }
  requestAnimationFrame(tick)
}

// ── THE branded property pin ─────────────────────────────────────────────────
// One implementation for every quoting/measuring map (QuoteMeasure modal and
// the Measure & Price page), so the lot being quoted is always unmistakable:
// an EdgeQuote-green teardrop pin (amber when the geocode is approximate) with
// a "Quoting this property" label, drawn above every polygon and vertex marker,
// with an opening pulse that lands the eye on the right lot.

// Teardrop: tip at (0,0), head circle r=9 centred at (0,-21). Scaled 1.5×.
const PIN_PATH = 'M 0,0 C -2,-7 -9,-11 -9,-21 A 9,9 0 1 1 9,-21 C 9,-11 2,-7 0,0 Z'

export interface PropertyPinHandle { pulse: () => void; remove: () => void }

export function addPropertyPin(map: any, position: { lat: number; lng: number }, precise: boolean): PropertyPinHandle | null {
  const g = window.google
  if (!g?.maps || !map) return null
  const color = precise ? '#00C896' : '#F59E0B'
  const text = precise ? 'Quoting this property' : 'Approximate location — verify before quoting'
  const marker = new g.maps.Marker({
    position, map, clickable: false, zIndex: 4000, // above polygons, vertices (1000+), click rings (3000)
    title: text,
    label: { text, color: '#FFFFFF', fontSize: '11px', fontWeight: '700', className: 'eq-map-pin-label' },
    icon: {
      path: PIN_PATH, scale: 1.5,
      fillColor: color, fillOpacity: 1,
      strokeColor: '#FFFFFF', strokeWeight: 2,
      labelOrigin: new g.maps.Point(0, -36),
    },
  })
  let removed = false
  const timers: ReturnType<typeof setTimeout>[] = []
  return {
    // Three beats so the eye finds the lot the moment the map opens.
    pulse() {
      for (const delay of [150, 650, 1150]) {
        timers.push(setTimeout(() => { if (!removed) flashRing(map, position, color) }, delay))
      }
    },
    remove() {
      removed = true
      timers.forEach(clearTimeout)
      marker.setMap(null)
    },
  }
}

export {}