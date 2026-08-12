'use client'

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  DROPDOWN_GAP, DROPDOWN_MAX_HEIGHT, placeDropdown, usableBand, type DropdownPlacement,
} from '@/lib/dropdownPlacement'

// The React side of `lib/dropdownPlacement` — see that file for WHY this exists
// (a dropdown covered the mobile Save button and ate the tap). The rule lives
// there as a pure function; this only feeds it live rects and re-runs when
// something that moves the field or the floor happens.

// useLayoutEffect warns during SSR, and this measures — so on the server there
// is nothing to do and the plain effect never runs before hydration anyway.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const OPEN_DEFAULT: DropdownPlacement = { side: 'below', maxHeight: DROPDOWN_MAX_HEIGHT }

/**
 * Where `anchorRef`'s dropdown should render while `open`.
 *
 * Re-measures on scroll (capturing, so a scrollable ANCESTOR counts, not just
 * the window), on resize, and on both visualViewport events — the last pair is
 * what makes the keyboard opening move the list instead of hiding it.
 */
export function useDropdownPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): DropdownPlacement {
  const [placement, setPlacement] = useState<DropdownPlacement>(OPEN_DEFAULT)
  // Read inside the listener rather than closed over, so the rAF callback can
  // bail after unmount without the listener being re-bound on every change.
  const openRef = useRef(open)
  openRef.current = open

  useIsomorphicLayoutEffect(() => {
    if (!open) return
    let raf = 0
    const measure = () => {
      const el = anchorRef.current
      if (!el || !openRef.current) return
      const r = el.getBoundingClientRect()
      const next = placeDropdown({ top: r.top, bottom: r.bottom }, usableBand())
      // Bail on an unchanged answer: this runs from a layout effect, and a
      // fresh object every scroll frame would re-render the whole list.
      setPlacement(prev => (prev.side === next.side && prev.maxHeight === next.maxHeight ? prev : next))
    }
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure) }
    measure()
    // `true` = capture: the builder's fields can sit inside scrollable panels,
    // and a bubbling scroll listener never hears those.
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
    }
  }, [open, anchorRef])

  // A closed dropdown reports the default so the first paint of an opening list
  // is never a stale height from wherever the field used to be.
  return open ? placement : OPEN_DEFAULT
}

/**
 * The whole geometry of a placed dropdown, as an inline style.
 *
 * ⚠️ Inline, NOT Tailwind classes, and that is the point. The first cut of this
 * returned `'bottom-full mb-1'` / `'top-full mt-1'` from this file — and
 * `tailwind.config.ts` scans `src/pages`, `src/components` and `src/app` only.
 * `bottom-full` appears nowhere under those roots, so the class was never
 * generated: the hook chose 'above' correctly, the element carried the class,
 * and it rendered BELOW anyway, straight over the save bar. Zero occurrences of
 * `bottom-full` in the built CSS was the tell. A computed class name in an
 * unscanned file is a class name that does not exist; a style always applies.
 */
export function dropdownStyle(place: DropdownPlacement): CSSProperties {
  const gap = `calc(100% + ${DROPDOWN_GAP}px)`
  return place.side === 'above'
    ? { maxHeight: place.maxHeight, bottom: gap, top: 'auto' }
    : { maxHeight: place.maxHeight, top: gap, bottom: 'auto' }
}
