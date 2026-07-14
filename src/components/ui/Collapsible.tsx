'use client'

import { useState, ReactNode } from 'react'
import { ChevronDown, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Reusable disclosure section. Closed by default — when collapsed it can show a
// one-line `summary` of what's inside so advanced settings stay out of the way
// without hiding their state. Used to keep the Quote Builder fast path clean.
export function Collapsible({
  title, icon: Icon, summary, badge, defaultOpen = false, children,
}: {
  title: string
  icon?: LucideIcon
  summary?: ReactNode
  badge?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-border rounded-card bg-bg-secondary overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-3.5 text-left hover:bg-surface/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {Icon && <Icon className="w-4 h-4 text-ink-muted shrink-0" />}
        <span className="text-sm font-semibold text-ink shrink-0">{title}</span>
        {badge}
        {!open && summary && (
          <span className="text-xs text-ink-faint truncate min-w-0">{summary}</span>
        )}
        <ChevronDown className={cn('w-4 h-4 text-ink-faint ml-auto shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border motion-safe:animate-[fadeIn_140ms_ease-out]">{children}</div>}
    </div>
  )
}
