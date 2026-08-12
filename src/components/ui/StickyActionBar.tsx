'use client'

import { ReactNode, useEffect, useRef } from 'react'
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
  const ref = useRef<HTMLDivElement>(null)

  // ⭐ Ride the VISUAL viewport, so the software keyboard cannot bury the
  // primary action.
  //
  // `position: fixed; bottom: 0` pins to the LAYOUT viewport, and opening the
  // keyboard does not shrink that — on iOS Safari, and on Android Chrome's
  // default `resizes-visual`, only `visualViewport` changes. Measured on the
  // deployed build at 390px with the visual viewport at 508px (an iPhone
  // keyboard): the Save button stayed at y 786–834, i.e. 326px BELOW the
  // keyboard line, completely unreachable while any field was focused.
  //
  // The inset is what the keyboard hides; translating up by exactly that puts
  // the bar on top of it. No visualViewport (older browsers) ⇒ no transform,
  // and the old behaviour stands.
  useEffect(() => {
    if (!fixed) return
    const vv = window.visualViewport
    if (!vv) return
    // Captured for the cleanup: by the time it runs, ref.current may already be
    // null (React clears it before effect teardown on unmount).
    const el = ref.current
    let raf = 0
    const apply = () => {
      if (!el) return
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      // 1px of slack: sub-pixel viewport maths must not leave a permanent
      // transform on a page with no keyboard.
      el.style.transform = inset > 1 ? `translateY(${-Math.round(inset)}px)` : ''
    }
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply) }
    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (el) el.style.transform = ''
    }
  }, [fixed])

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
      ref={ref}
      // ⭐ THE marker every dropdown measures its floor against
      // (lib/dropdownPlacement). Only a FIXED bar is chrome over the page — a
      // sticky one flows in the document and a list simply pushes past it.
      // Reading the live rect is deliberate: it already accounts for the bar
      // growing (the $0 "Save anyway" note) and for the keyboard transform
      // above, neither of which a hard-coded height would.
      {...(fixed ? { 'data-eq-bottom-chrome': '' } : {})}
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
