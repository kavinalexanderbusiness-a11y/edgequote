'use client'

import { useEffect, useRef } from 'react'
import { adoptCacheOwner, setCacheOwner } from '@/lib/clientCache'

// ── Who the client cache belongs to ──────────────────────────────────────────
// The dashboard layout verifies the user server-side and renders this first,
// before the page. The owner is adopted DURING RENDER on purpose: pages read the
// cache in useState initializers (`useState(() => readCache('revintel', …))`),
// which run when the page renders — after this component, in tree order, but
// before any effect anywhere. An effect alone would be too late for that first
// paint, and the first paint is exactly what the cache exists for. Adopting is
// idempotent for the current owner, so a double render costs nothing, and it is
// a no-op on the server (lib/clientCache), where this component renders too.
//
// It is adopted AGAIN in the effect: React StrictMode (on by default in Next
// dev) mounts, runs the cleanup, and re-runs the effect on one instance — the
// cleanup below clears the owner, so without a re-adopt here the cache would be
// silently off for everyone developing on it. Production never runs that cycle;
// there the effect's adopt is the idempotent no-op. On unmount (sign-out
// navigates to /login, which lives outside the layout) the owner is cleared, so
// the next account starts with "no cache" until its own layout says who it is.
export function CacheOwner({ id }: { id: string }) {
  const last = useRef<string | null>(null)
  if (last.current !== id) { last.current = id; adoptCacheOwner(id) }
  useEffect(() => { adoptCacheOwner(id); return () => { setCacheOwner(null) } }, [id])
  return null
}
