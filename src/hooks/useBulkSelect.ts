'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ── Shared multi-select engine ───────────────────────────────────────────────
// ONE selection model every list adopts (customers, quotes, jobs, properties,
// invoices, leads…) so selection behaves identically everywhere: click to toggle,
// shift-click for a range, select-all over the current filtered view, Esc to clear,
// and selection auto-prunes when rows disappear. Pairs with <BulkActionBar>.

export interface UseBulkSelectResult<T> {
  selected: Set<string>
  selectedItems: T[]
  count: number
  allSelected: boolean
  someSelected: boolean
  isSelected: (id: string) => boolean
  toggle: (id: string, shiftKey?: boolean) => void
  toggleAll: () => void
  clear: () => void
}

// `items` is the CURRENT (filtered) list, in display order — drives select-all + range.
export function useBulkSelect<T extends { id: string }>(items: T[]): UseBulkSelectResult<T> {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastIndex = useRef<number | null>(null)

  const ids = useMemo(() => items.map(i => i.id), [items])
  const idsKey = ids.join(',')

  // Drop ids that have left the list (deleted/filtered) so the count never lies.
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev
      const valid = new Set(ids)
      const next = new Set([...prev].filter(id => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const clear = useCallback(() => { setSelected(new Set()); lastIndex.current = null }, [])

  // Esc clears the selection — same everywhere.
  useEffect(() => {
    if (selected.size === 0) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const el = document.activeElement
        const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing) clear()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.size, clear])

  const toggle = useCallback((id: string, shiftKey = false) => {
    const idx = ids.indexOf(id)
    setSelected(prev => {
      const n = new Set(prev)
      // Shift-click selects the contiguous range from the last clicked row.
      if (shiftKey && lastIndex.current !== null && idx >= 0) {
        const [a, b] = [lastIndex.current, idx].sort((x, y) => x - y)
        for (let i = a; i <= b; i++) n.add(ids[i])
      } else if (n.has(id)) {
        n.delete(id)
      } else {
        n.add(id)
      }
      return n
    })
    if (idx >= 0) lastIndex.current = idx
  }, [ids])

  const allSelected = ids.length > 0 && ids.every(id => selected.has(id))
  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(ids))
  }, [allSelected, ids])

  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected])

  return {
    selected,
    selectedItems,
    count: selected.size,
    allSelected,
    someSelected: selected.size > 0,
    isSelected: (id: string) => selected.has(id),
    toggle,
    toggleAll,
    clear,
  }
}
