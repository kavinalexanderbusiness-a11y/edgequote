'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { QuickAddContext } from '@/lib/quickAdd'

// ── How the + finds out where it is ──────────────────────────────────────────
// The bottom nav lives in the dashboard LAYOUT, above every page, so it cannot
// read the record a page is showing. Rather than have it sniff the URL — which
// would mean a second, drifting copy of "what does /dashboard/customers/[id]
// mean" living in a nav component — each surface PUBLISHES the record it is
// showing, and the + reads whatever is published.
//
// ⭐ Publishing is the surface's own statement about itself. A page that says
// nothing gets the global sheet, which is correct: an unpublished context is
// "we don't know", never a guess.
//
// The value is compared by CONTENT, not identity: a page re-rendering with an
// equal context must not re-render the nav, or a page that publishes inside a
// render would loop. Serialising is safe here — these objects are half a dozen
// ids and a name.

const Ctx = createContext<QuickAddContext>({ kind: 'none' })
const SetCtx = createContext<(c: QuickAddContext | null) => void>(() => {})

export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [ctx, setCtx] = useState<QuickAddContext>({ kind: 'none' })

  const publish = useCallback((next: QuickAddContext | null) => {
    setCtx(prev => {
      const value = next ?? { kind: 'none' as const }
      return JSON.stringify(prev) === JSON.stringify(value) ? prev : value
    })
  }, [])

  return (
    <SetCtx.Provider value={publish}>
      <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
    </SetCtx.Provider>
  )
}

/** What the + should offer. `{ kind: 'none' }` when nothing has published. */
export function useQuickAddContext(): QuickAddContext {
  return useContext(Ctx)
}

/**
 * Publish the record this surface is showing, for as long as it is mounted.
 *
 * Pass null while the record is still loading — an unpublished context gives
 * the global sheet, which is the honest answer until the row arrives. The
 * context is cleared on unmount, so navigating away can never leave the +
 * prefilled with the customer you just left.
 */
export function usePublishQuickAddContext(ctx: QuickAddContext | null): void {
  const publish = useContext(SetCtx)
  // Content-keyed: the caller builds a fresh object every render and this must
  // not fire on every one of them.
  const key = useMemo(() => (ctx ? JSON.stringify(ctx) : ''), [ctx])
  useEffect(() => {
    publish(key ? (JSON.parse(key) as QuickAddContext) : null)
    return () => publish(null)
  }, [key, publish])
}
