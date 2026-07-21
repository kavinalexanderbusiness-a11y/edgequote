'use client'

import { useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TabItem {
  key: string
  label: string
  icon?: LucideIcon
}

interface TabsProps {
  tabs: TabItem[]
  active: string
  onChange: (key: string) => void
  className?: string
}

/**
 * Pill / segmented tab bar matching the app's filter-chip style
 * (rounded-full, accent for active). Stays on ONE line and scrolls horizontally
 * when it overflows — `overflow-x-auto` + `flex-wrap` are mutually exclusive, so
 * wrap is dropped (it would have forced multi-line and disabled scrolling).
 *
 * Implements the full WAI-ARIA tabs KEYBOARD pattern, not just the roles:
 * • Roving tabindex — the tablist is ONE Tab stop (only the active tab is
 *   tabbable), so a keyboard user doesn't have to Tab through every section
 *   switcher to get past it.
 * • Arrow keys move between tabs (Left/Right, wrapping) with Home/End for the
 *   ends; activation follows focus, matching how a mouse click behaves.
 * Previously the roles were present but the keys were dead and every tab was its
 * own Tab stop — a screen reader announced "tab, N of M" promising arrow-key
 * navigation the widget never delivered. The panels are owned by callers, so
 * there's no aria-controls linkage to add here; the tablist itself is now
 * correct and self-consistent.
 */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])
  // If `active` doesn't match any tab (shouldn't happen), keep the tablist
  // reachable by making the first tab the roving stop rather than none.
  const hasActive = tabs.some(t => t.key === active)

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    onChange(tabs[next].key)
    // Move focus with selection (browsers scroll the focused tab into view,
    // which also keeps the active tab visible in the horizontal scroller).
    btnRefs.current[next]?.focus()
  }

  return (
    <div role="tablist" aria-orientation="horizontal" className={cn('flex gap-1.5 overflow-x-auto', className)}>
      {tabs.map((t, i) => {
        const selected = active === t.key
        return (
          <button
            key={t.key}
            ref={el => { btnRefs.current[i] = el }}
            type="button"
            role="tab"
            aria-selected={selected}
            // Roving tabindex: the selected tab (or the first, if none is
            // selected) is the single Tab stop; the rest are arrow-reachable.
            tabIndex={selected || (!hasActive && i === 0) ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={e => onKeyDown(e, i)}
            className={cn(
              'shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3.5 py-2 border transition-all active:scale-[0.97]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              selected
                ? 'bg-accent text-black border-accent pill-glow'
                : 'border-border text-ink-muted hover:text-ink hover:border-border-strong'
            )}
          >
            {t.icon && <t.icon className="w-3.5 h-3.5" />} {t.label}
          </button>
        )
      })}
    </div>
  )
}
