'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

// ── Route-change focus management ────────────────────────────────────────────
// On a client-side navigation, move keyboard/screen-reader focus to the main
// content region so people land on the NEW page — not stranded on the nav link
// they just tapped.
//
// Without this, a screen-reader user hears nothing announced when the page
// changes (focus stays on the old link), and a keyboard user resumes Tab from
// the nav bar and has to re-traverse the whole navigation on every move. The
// dashboard layout already ships the correct target — <main id="main-content"
// tabIndex={-1}> plus a "Skip to content" link that points at it — but nothing
// ever moved focus there. This wires up the focus move that infrastructure was
// built for; it renders nothing.
//
// Notes:
// • The FIRST run (initial load / hydration) is skipped — stealing focus to the
//   region on first paint would fight the browser's own initial focus and read
//   as a jump. Only real navigations move focus.
// • preventScroll, because Next's App Router already scrolls to top on
//   navigation; focusing without it would risk a second scroll jump.
// • Keyed on pathname only: a query-string change (a filter on the same page)
//   leaves pathname unchanged, so it does NOT steal focus mid-task — exactly the
//   desired behaviour.
export function RouteFocusManager() {
  const pathname = usePathname()
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    // Effects run after the new page's DOM is committed, so <main> now holds the
    // new content. focus:outline-none on the element keeps this programmatic
    // focus from drawing a ring (it's a landmark, not a tab stop).
    document.getElementById('main-content')?.focus({ preventScroll: true })
  }, [pathname])

  return null
}
