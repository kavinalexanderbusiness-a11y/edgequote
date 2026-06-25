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
 * (rounded-full, accent for active). Wraps and scrolls on small screens.
 */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex gap-1.5 overflow-x-auto flex-wrap', className)}>
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            'shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3.5 py-2 border transition-colors',
            active === t.key
              ? 'bg-accent text-black border-accent'
              : 'border-border text-ink-muted hover:text-ink'
          )}
        >
          {t.icon && <t.icon className="w-3.5 h-3.5" />} {t.label}
        </button>
      ))}
    </div>
  )
}
