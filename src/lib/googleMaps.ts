declare global {
  interface Window {
    google?: any
    /** Google calls this when it refuses the key — see AUTH FAILURE below. */
    gm_authFailure?: () => void
  }
}

// ── Why a map can be missing, in the owner's language ────────────────────────
// ⚠️ THE BUG THIS CLOSES (measured on production, 2026-08-23).
// The production domain moved to app.edgehq.ca on 2026-08-15. The browser key's
// HTTP-referrer allowlist was never updated with the new host, so Google answered:
//
//   Google Maps JavaScript API error: RefererNotAllowedMapError
//   Your site URL to be authorized: https://app.edgehq.ca/...
//
// and painted its own grey panel — "Oops! Something went wrong. This page didn't
// load Google Maps correctly." — INSIDE our map div, where it sat forever.
//
// ⭐ THE REASON NOTHING CAUGHT IT. An auth refusal is not a load failure. The
// script tag returns 200, `importLibrary` attaches, `geometry` loads, and the
// Map constructor SUCCEEDS — every signal `loadGoogleMaps()` had said the map was
// fine, and its promise resolved. Google reports the refusal out-of-band, by
// calling `window.gm_authFailure`, and nothing was listening. So a component's
// `loadError` state stayed null while the owner looked at a broken map.
//
// Therefore: the hook is installed BEFORE the script is injected, the refusal is
// remembered even if it arrives long after the promise resolved, and surfaces
// SUBSCRIBE rather than await. `loadGoogleMaps()` alone can never answer "is
// there a map on screen" — only this can.
export type MapsUnavailableReason =
  /** No NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY in this deploy's environment. */
  | 'missing_key'
  /** Google refused the key for this site (referrer, disabled API, or billing). */
  | 'auth_rejected'
  /** The script never arrived — offline, blocked by an extension, DNS. */
  | 'script_blocked'
  /** It arrived but never became usable. */
  | 'sdk_timeout'

export interface MapsUnavailable {
  reason: MapsUnavailableReason
  /**
   * ONE sentence, safe for ANY reader. This is what a customer on the public
   * booking funnel sees, so it names no key, no origin and no configuration.
   */
  message: string
  /**
   * The owner/developer half: which origin was refused and what to change.
   * ⛔ NEVER render this on a customer-facing surface — MapUnavailable enforces
   * that with its `audience` prop, and verify:measure-price pins it.
   */
  detail: string
}

/** Where we are, as Google sees us. The one fact an owner needs to fix a referrer. */
function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin
}

/**
 * THE sentence, for every reason and every reader. Deliberately one string: the
 * owner does not need to learn four failure modes to know the map is not coming,
 * and a customer must never be able to tell them apart.
 */
export const MAPS_UNAVAILABLE_MESSAGE = 'Map couldn’t load. Check Maps configuration.'

export function describeMapsUnavailable(reason: MapsUnavailableReason): MapsUnavailable {
  const origin = currentOrigin()
  const here = origin || 'this site'
  switch (reason) {
    case 'missing_key':
      return {
        reason,
        message: MAPS_UNAVAILABLE_MESSAGE,
        detail: 'NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is not set in this deployment. Add it to the Vercel project (Production and Preview) and redeploy — it is inlined at build time, so a running deploy cannot pick it up.',
      }
    case 'auth_rejected':
      return {
        reason,
        message: MAPS_UNAVAILABLE_MESSAGE,
        // gm_authFailure does not say WHICH of the three it is, so this lists all
        // three rather than guessing. The ORIGIN is the part that is certain, and
        // it is the part the owner has to paste into the Cloud Console.
        detail: `Google refused the Maps key for ${here}. In Google Cloud Console → APIs & Services → Credentials → the browser key, check: (1) ${origin || 'this origin'}/* is in the HTTP referrer allowlist, (2) "Maps JavaScript API" is among the key's allowed APIs and is enabled on the project, (3) the project has billing enabled.`,
      }
    case 'script_blocked':
      return {
        reason,
        message: MAPS_UNAVAILABLE_MESSAGE,
        detail: 'The Google Maps script never loaded. Usually no network, or a browser extension / content blocker refusing maps.googleapis.com.',
      }
    case 'sdk_timeout':
      return {
        reason,
        message: MAPS_UNAVAILABLE_MESSAGE,
        detail: 'The Google Maps script loaded but never finished initialising (importLibrary never appeared). Usually a partial or cached script — a hard reload normally clears it.',
      }
  }
}

// ── The refusal, remembered and broadcast ────────────────────────────────────
let unavailable: MapsUnavailable | null = null
const listeners = new Set<(u: MapsUnavailable) => void>()

function markUnavailable(reason: MapsUnavailableReason) {
  // First answer wins: a referrer refusal followed by a timeout is still a
  // referrer refusal, and the owner should be told the actionable one.
  if (unavailable) return
  unavailable = describeMapsUnavailable(reason)
  for (const cb of listeners) {
    try { cb(unavailable) } catch { /* one bad listener must not silence the rest */ }
  }
}

/** What is wrong right now, or null while nothing is known to be wrong. */
export function mapsUnavailable(): MapsUnavailable | null { return unavailable }

/**
 * Be told when Google refuses the key — INCLUDING when the refusal already
 * happened before this component mounted (the callback fires immediately in that
 * case, so a map opened second is just as honest as the one opened first).
 */
export function onMapsUnavailable(cb: (u: MapsUnavailable) => void): () => void {
  listeners.add(cb)
  if (unavailable) { try { cb(unavailable) } catch { /* as above */ } }
  return () => { listeners.delete(cb) }
}

/**
 * Turn a rejected `loadGoogleMaps()` into the same shape as an auth refusal, so
 * every surface renders ONE component for "there is no map" and none of them
 * invents its own wording. Prefers whatever is already known — a refusal that
 * arrived first is more specific than the generic reject that follows it.
 */
export function describeMapsError(_e?: unknown): MapsUnavailable {
  return unavailable ?? describeMapsUnavailable('script_blocked')
}

let hookInstalled = false
function installAuthFailureHook() {
  if (hookInstalled || typeof window === 'undefined') return
  hookInstalled = true
  const prior = window.gm_authFailure
  window.gm_authFailure = () => {
    markUnavailable('auth_rejected')
    // Chain rather than replace: another integration may have its own hook, and
    // silently dropping theirs would be the same class of bug this file fixes.
    try { prior?.() } catch { /* theirs, not ours */ }
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
      markUnavailable('sdk_timeout')
      reject(new Error('Google Maps loaded but importLibrary never became available'))
      return
    }
    setTimeout(tick, 50)
  }
  tick()
}

export function loadGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  // BEFORE the script: Google can call gm_authFailure the moment it evaluates,
  // and a hook installed afterwards would miss the only notice we ever get.
  installAuthFailureHook()
  if (typeof window.google?.maps?.importLibrary === 'function') return Promise.resolve()
  if (loadPromise) return loadPromise

  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
  loadPromise = new Promise<void>((resolve, reject) => {
    if (!key) { markUnavailable('missing_key'); reject(new Error('Missing NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY')); return }
    const existing = document.getElementById('gmaps-js') as HTMLScriptElement | null
    if (existing) {
      waitForImportLibrary(resolve, reject)
      return
    }
    const script = document.createElement('script')
    script.id = 'gmaps-js'
    // ⭐ `geometry` is load-bearing: spherical.computeArea IS the area engine
    // behind every measurement (lib/measure/geometry). `places` is deliberately
    // NOT requested — address autocomplete goes through /api/places/* on the
    // SERVER key (see lib/places.ts), so asking for it here only widened what
    // this browser key had to be allowed to do. One library, one API to enable:
    // Maps JavaScript API. Pinned by verify:measure-price.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&libraries=geometry&loading=async`
    script.async = true
    script.onload = () => waitForImportLibrary(resolve, reject)
    script.onerror = () => { markUnavailable('script_blocked'); reject(new Error('Failed to load Google Maps')) }
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
