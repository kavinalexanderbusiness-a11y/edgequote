'use client'

import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Tabs ──────────────────────────────────────────────────────────────────────
// One horizontal tab strip used to break long pages (Settings, etc.) into
// scannable sections. Scrolls horizontally on mobile; keeps the same pill look as
// the rest of the app so navigation feels uniform.
export interface TabItem {
  key: string
  label: string
  icon?: LucideIcon
  count?: number
}

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem[]
  active: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex gap-1.5 overflow-x-auto no-scrollbar', className)}>
      {tabs.map((t) => {
        const isActive = t.key === active
        const Icon = t.icon
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium border transition-colors whitespace-nowrap',
              isActive
                ? 'bg-accent text-black border-accent'
                : 'bg-surface text-ink-muted border-border hover:text-ink hover:border-border-strong'
            )}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className={cn('text-[10px]', isActive ? 'text-black/60' : 'text-ink-faint')}>{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
