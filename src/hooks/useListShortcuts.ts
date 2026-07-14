'use client'

import { useEffect, useRef, type RefObject } from 'react'

// ── List-page keyboard idiom, implemented ONCE ────────────────────────────────
// '/'  → focus the page's search box
// 'n'  → fire the page's primary "New" action
// Ignored while typing (input/textarea/select/contenteditable), while a modifier
// is held, or when a dialog is open (the dialog owns the keyboard then).
export function useListShortcuts(opts: { search?: RefObject<HTMLInputElement | null>; onNew?: () => void }) {
  const latest = useRef(opts)
  latest.current = opts

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"]')) return
      const { search, onNew } = latest.current
      if (e.key === '/' && search?.current) {
        e.preventDefault()
        search.current.focus()
      } else if ((e.key === 'n' || e.key === 'N') && onNew) {
        e.preventDefault()
        onNew()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
