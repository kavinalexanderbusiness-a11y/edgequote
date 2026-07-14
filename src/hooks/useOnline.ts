'use client'

import { useSyncExternalStore } from 'react'

// Live connectivity state. `navigator.onLine` + the online/offline events — one
// source of truth shared by the offline indicator and any mutation UI that wants
// to show "will sync later". SSR-safe (assumes online on the server).
function subscribe(cb: () => void): () => void {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) }
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
    () => true,
  )
}
