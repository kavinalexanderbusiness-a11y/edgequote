'use client'

import { useState, ReactNode } from 'react'
import { ChevronDown, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// Reusable disclosure section. Closed by default — when collapsed it can show a
// one-line `summary` of what's inside so advanced settings stay out of the way
// without hiding their state. Used to keep the Quote Builder fast path clean.
export function Collapsible({
  title, icon: Icon, summary, badge, defaultOpen = false, open: openProp, onOpenChange, children,
}: {
  title: string
  icon?: LucideIcon
  summary?: ReactNode
  badge?: ReactNode
  defaultOpen?: boolean
  /** Controlled open state. Omit for the normal self-managed disclosure. */
  open?: boolean
  /** Fires on every toggle — in controlled AND uncontrolled use. */
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  // Controlled/uncontrolled hybrid: a caller that needs to OPEN a section from
  // outside (e.g. a blocked submit whose invalid field is hidden in here) passes
  // `open`; everyone else keeps the internal state and notices nothing.
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp ?? internalOpen
  return (
    <div className="border border-border rounded-card bg-bg-secondary overflow-hidden">
      <button
        type="button"
        onClick={() => { setInternalOpen(!open); onOpenChange?.(!open) }}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-3.5 text-left hover:bg-surface-raised/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {Icon && <Icon className="w-4 h-4 text-ink-muted shrink-0" />}
        <span className="text-sm font-semibold text-ink shrink-0">{title}</span>
        {badge}
        {/* ⚠️ `truncate min-w-0` lets this SHRINK but does not stop it setting
            the header row's MIN-CONTENT: Chrome still sums the un-wrapped text
            (measured — neither min-width:0 nor a zero flex-basis changes it). So
            a long summary can only be made safe by the CONTAINER it sits in
            being allowed to go narrower than its content — see the `min-w-0` on
            the quote builder's form column, and keep it on any other narrow
            layout that hosts a Collapsible. */}
        {!open && summary && (
          <span className="text-xs text-ink-faint truncate min-w-0">{summary}</span>
        )}
        <ChevronDown className={cn('w-4 h-4 text-ink-faint ml-auto shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border animate-fade">{children}</div>}
    </div>
  )
}
