'use client'

import { ReactNode, useEffect } from 'react'
import { cn } from '@/lib/utils'

// ── StickyActionBar ───────────────────────────────────────────────────────────
// THE bottom save/action bar. The three builder/settings save bars each invented
// their own recipe (fixed vs sticky, bg-bg-secondary/95 vs bg-surface/95,
// border-t vs full card, three paddings). One surface here:
// sticky (or fixed via `fixed`), blurred bg-bg-secondary/95, border-t, py-2.5.
//
// A `fixed` bar also YIELDS THE BOTTOM NAV (standard mobile pattern: when a
// screen has its own primary action at the bottom, the tab bar steps aside —
// stacked bars would bury the save button under navigation, and a nav tap
// mid-form is a misclick hazard anyway). Signalled via a ref-counted body
// attribute that globals.css turns into `display:none` on .eq-bottom-nav; done
// HERE so every present and future fixed bar gets the behaviour without knowing
// the nav exists.
interface StickyActionBarProps {
  children: ReactNode
  /** Use position:fixed to the viewport bottom (mobile-only bars). Default: sticky. */
  fixed?: boolean
  className?: string
}

export function StickyActionBar({ children, fixed, className }: StickyActionBarProps) {
  useEffect(() => {
    if (!fixed) return
    // Ref-counted, not boolean: with two fixed bars mounted at once, the first
    // one's unmount must not un-hide the nav under the second.
    const b = document.body
    b.dataset.eqStickyBars = String(Number(b.dataset.eqStickyBars || '0') + 1)
    return () => {
      const m = Number(b.dataset.eqStickyBars || '1') - 1
      if (m <= 0) delete b.dataset.eqStickyBars
      else b.dataset.eqStickyBars = String(m)
    }
  }, [fixed])

  return (
    <div
      className={cn(
        'bottom-0 z-30 bg-bg-secondary/95 backdrop-blur border-t border-border px-4 py-2.5',
        // A fixed bar is positioned against the VIEWPORT, so it ignores the
        // safe-area padding on <body> and lands under the home indicator. Pay the
        // inset here; sticky bars flow inside body and already clear it.
        fixed ? 'fixed left-0 right-0 pb-[calc(10px+env(safe-area-inset-bottom))]' : 'sticky',
        className
      )}
    >
      {children}
    </div>
  )
}
