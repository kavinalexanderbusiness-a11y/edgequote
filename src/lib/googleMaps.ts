declare global {
  interface Window {
    google?: any
  }
}

let loadPromise: Promise<void> | null = null

/**
 * Loads the Google Maps JS API (Places library) once, using the
 * browser-side key. Safe to call many times — only injects the script once.
 */
export function loadGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.google?.maps?.importLibrary) return Promise.resolve()
  if (loadPromise) return loadPromise

  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
  loadPromise = new Promise<void>((resolve, reject) => {
    if (!key) { reject(new Error('Missing NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY')); return }
    const existing = document.getElementById('gmaps-js') as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Maps')))
      return
    }
    const script = document.createElement('script')
    script.id = 'gmaps-js'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&libraries=places&loading=async`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Maps'))
    document.head.appendChild(script)
  })
  return loadPromise
}

export {}