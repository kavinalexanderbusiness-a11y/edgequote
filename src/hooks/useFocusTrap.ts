import { useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Makes a custom overlay behave like a real dialog for keyboard + screen-reader
// users: on open it moves focus into the panel, traps Tab within it, closes on
// Escape, and restores focus to the trigger on close. For overlays that — for
// layout reasons (a side drawer, an image lightbox) — can't adopt the shared
// <Modal>, which already does all of this. Attach the returned ref to the dialog
// panel element (give that element tabIndex={-1} so it can hold focus when it has
// no focusable children).
export function useFocusTrap<T extends HTMLElement>(active: boolean, onClose?: () => void) {
  const ref = useRef<T>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  // Keep the latest onClose without re-running the effect (callers often pass an
  // inline arrow), so focus is captured/moved exactly once per open.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!active) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const panel = ref.current
    const firstFocus = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(firstFocus || panel)?.focus?.()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { closeRef.current?.(); return }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null)
      if (items.length === 0) { e.preventDefault(); panel.focus(); return }
      const first = items[0], last = items[items.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && (activeEl === first || activeEl === panel)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreRef.current?.focus?.()
    }
  }, [active])

  return ref
}
