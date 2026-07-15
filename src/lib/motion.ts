// ── Motion preferences ────────────────────────────────────────────────────────
// The global reduced-motion net in globals.css neutralizes CSS animations and
// sets `scroll-behavior: auto`. It CANNOT catch scrolling requested from JS:
// `scrollIntoView({ behavior: 'smooth' })` explicitly asks for smooth and wins
// over the stylesheet. So every JS-initiated scroll must ask for its behavior
// through here instead of hardcoding 'smooth'.

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// 'auto' (instant) when the user asked for reduced motion, else 'smooth'.
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
