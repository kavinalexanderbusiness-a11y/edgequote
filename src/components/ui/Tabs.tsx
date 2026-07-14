'use client'

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
 * Exposes proper tablist/tab semantics with `aria-selected`.
 */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('flex gap-1.5 overflow-x-auto', className)}>
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3.5 py-2 border transition-all active:scale-[0.97]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            active === t.key
              ? 'bg-accent text-black border-accent pill-glow'
              : 'border-border text-ink-muted hover:text-ink hover:border-border-strong'
          )}
        >
          {t.icon && <t.icon className="w-3.5 h-3.5" />} {t.label}
        </button>
      ))}
    </div>
  )
}
