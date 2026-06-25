'use client'

import { useEffect } from 'react'

// Registers the service worker (offline shell + fast launch + push). No UI.
// Runs after load so it never competes with first paint.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ }) }
    if (document.readyState === 'complete') register()
    else { window.addEventListener('load', register); return () => window.removeEventListener('load', register) }
  }, [])
  return null
}
