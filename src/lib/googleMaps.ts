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

export {}