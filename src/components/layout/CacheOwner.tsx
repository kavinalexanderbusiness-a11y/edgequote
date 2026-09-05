'use client'

import { useEffect, useRef } from 'react'
import { adoptCacheOwner, setCacheOwner } from '@/lib/clientCache'

// ── Who the client cache belongs to ──────────────────────────────────────────
// The dashboard layout verifies the user server-side and renders this first,
// before the page. The owner is set DURING RENDER on purpose: pages read the
// cache in useState initializers (`useState(() => readCache('revintel', …))`),
// which run when the page renders — after this component, in tree order, but
// before any effect anywhere. An effect here would be too late for that first
// paint, and the first paint is exactly what the cache exists for. The write is
// idempotent module state, so a double render costs nothing. Adopting compares
// the id with the last account this device rendered for and drops the namespace
// on a change (lib/clientCache explains the offline shell case). On unmount
// (sign-out navigates to /login, which lives outside the layout) the owner is
// cleared, so the next account starts with "no cache" until its own layout says
// who it is.
export function CacheOwner({ id }: { id: string }) {
  const last = useRef<string | null>(null)
  if (last.current !== id) { last.current = id; adoptCacheOwner(id) }
  useEffect(() => () => { setCacheOwner(null) }, [])
  return null
}
