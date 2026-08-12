// ── Where a field's dropdown is allowed to be ────────────────────────────────
// THE one rule every combobox in the app places its list by, so none of them
// can independently decide to cover something.
//
// ⭐⭐ WHY THIS EXISTS — a measured production bug, not a tidy-up.
// The four comboboxes inside the quote builder (customer · service · address ·
// property) each rendered `absolute z-overlay mt-1 … max-h-72`: a 288px list
// that opens DOWNWARD from the field with no idea where the bottom of the
// screen is. The mobile save bar is `position: fixed; bottom: 0` at z-30.
// z-overlay is 50. So on a phone, with the service field in the lower half of
// the form — which is where it sits after you have worked down the page — the
// list ran to y=926 on an 844px viewport and painted straight over the Save
// button. Measured at a true 390px on the deployed build:
//
//   save button   t:786  b:834   (inside the fixed bar, top 775, z-30)
//   open listbox  t:638  b:926   (z-50)
//   elementFromPoint(312, 810) → SPAN "General Landscaping"
//   a real touch tap there → submits attempted = 0, and service_type CHANGED
//
// So "EdgeQuote sometimes won't let me save on my phone" was literal: the tap
// never reached Save, and instead silently re-picked the service. The outside-
// close handlers listen for `mousedown`, and a tap INSIDE the list is not
// outside — so tapping again did the same thing again.
//
// ⛔ The fix is NOT a z-index. Raising the bar above z-overlay would put it over
// modal scrims (Modal and QuoteMeasure are both z-overlay). A list that FITS ON
// SCREEN cannot cover something at the bottom of the screen — that is the
// invariant, and it holds no matter what the layering contract says later.

/** The tallest a dropdown may ever be — the old `max-h-72`, kept so nothing
 *  about a list with room to spare changes. */
export const DROPDOWN_MAX_HEIGHT = 288
/** Below this, a downward list is too short to choose from, so the space above
 *  the field is worth considering instead. Not a floor on the result: fitting
 *  is the hard rule, height is the preference. */
export const DROPDOWN_MIN_HEIGHT = 96
/** The breathing room between field and list — the old `mt-1`, to the pixel, so
 *  a list with room to spare looks exactly as it did. */
export const DROPDOWN_GAP = 4

export type DropdownSide = 'below' | 'above'
export interface DropdownPlacement {
  side: DropdownSide
  /** px. Applied as an inline max-height; the list scrolls inside it. */
  maxHeight: number
}

/** Vertical extent the dropdown may occupy, in viewport coordinates. */
export interface UsableBand { top: number; bottom: number }

/**
 * Where this dropdown goes, given its field and the band it must stay inside.
 *
 * Pure — the DOM reading lives in `usableBand()` / the hook — so the guard can
 * assert the rule against numbers instead of against a browser.
 *
 * Preference order: below (what everyone expects a dropdown to do), then above
 * when below is genuinely too short AND above is roomier. The returned
 * maxHeight NEVER exceeds the space on the chosen side, which is the whole
 * point: the list stops before the save bar rather than painting over it.
 */
export function placeDropdown(
  anchor: { top: number; bottom: number },
  band: UsableBand,
): DropdownPlacement {
  const below = Math.floor(band.bottom - anchor.bottom - DROPDOWN_GAP)
  const above = Math.floor(anchor.top - band.top - DROPDOWN_GAP)
  const fits = (n: number) => Math.max(0, Math.min(DROPDOWN_MAX_HEIGHT, n))
  if (below >= DROPDOWN_MIN_HEIGHT || below >= above) return { side: 'below', maxHeight: fits(below) }
  return { side: 'above', maxHeight: fits(above) }
}

/**
 * The band a dropdown may live in, read from the live page.
 *
 * Two things shrink it, and both are measured rather than assumed:
 *
 * 1. **The software keyboard.** `window.innerHeight` does not change when it
 *    opens (iOS Safari, and Android Chrome's default `resizes-visual`) — only
 *    `visualViewport` does. Using innerHeight alone would place a list under
 *    the keyboard.
 * 2. **Fixed bottom chrome** — the save bar, the bottom nav. Tagged
 *    `data-eq-bottom-chrome` so this reads the REAL rect: the save bar grows
 *    when the $0 note arms, and it is translated up when the keyboard opens.
 *    Measuring it means both of those are handled without being re-derived.
 */
export function usableBand(): UsableBand {
  if (typeof window === 'undefined') return { top: 0, bottom: 0 }
  const layoutH = window.innerHeight
  const vv = window.visualViewport
  const top = 0
  let bottom = vv ? Math.min(layoutH, vv.offsetTop + vv.height) : layoutH
  for (const el of Array.from(document.querySelectorAll('[data-eq-bottom-chrome]'))) {
    const r = (el as HTMLElement).getBoundingClientRect()
    // height 0 ⇒ display:none (the bottom nav yields to a fixed save bar).
    if (r.height > 0 && r.top < bottom) bottom = r.top
  }
  return { top, bottom }
}
