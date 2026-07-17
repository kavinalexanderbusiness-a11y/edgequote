'use client'

import { useLayoutEffect, useRef } from 'react'

// ── FLIP list animation ──────────────────────────────────────────────────────
// When rows in a list swap positions (reorder, optimize, nudge), animate each
// row from where it WAS to where it now IS instead of teleporting. Attach the
// returned ref to the list container and stamp every row with data-flip-id.
//
// Measures offsetTop (layout-relative), not viewport rects, so scrolling between
// renders can't fake a move. Uses the Web Animations API so nothing is left on
// the element afterwards, and sits inside the motion system's reduced-motion
// net: with `prefers-reduced-motion: reduce` rows simply appear in place.
export function useFlipList<T extends HTMLElement = HTMLDivElement>(orderKey: string) {
  const ref = useRef<T | null>(null)
  const prev = useRef<Map<string, number>>(new Map())

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-flip-id]'))
    const next = new Map<string, number>()
    for (const r of rows) next.set(r.dataset.flipId!, r.offsetTop)

    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduce && typeof Element.prototype.animate === 'function') {
      for (const r of rows) {
        const id = r.dataset.flipId!
        const from = prev.current.get(id)
        const to = next.get(id)!
        if (from != null && Math.abs(from - to) > 2) {
          r.animate(
            [{ transform: `translateY(${from - to}px)` }, { transform: 'translateY(0)' }],
            { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
          )
        }
      }
    }
    prev.current = next
  }, [orderKey])

  return ref
}
