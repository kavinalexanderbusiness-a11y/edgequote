'use client'

import { cn } from '@/lib/utils'
import { Loader2, X } from 'lucide-react'

// ── Shared bulk-action UI ────────────────────────────────────────────────────
// One sticky action bar + one selection checkbox, used by every multi-select list
// so the experience is identical: same look, same "N selected", same Clear, same
// destructive styling. Pair with useBulkSelect.

export interface BulkAction {
  key: string
  label: string
  icon: typeof X
  onClick: () => void | Promise<void>
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  hidden?: boolean
}

export function BulkActionBar({ count, actions, onClear, busyKey }: {
  count: number
  actions: BulkAction[]
  onClear: () => void
  busyKey?: string | null     // key of the action currently running (shows a spinner)
}) {
  if (count === 0) return null
  const visible = actions.filter(a => !a.hidden)
  return (
    <div className="sticky top-2 z-20 flex items-center gap-1.5 flex-wrap bg-bg-secondary border border-accent/40 rounded-xl px-3 sm:px-4 py-2.5 shadow-lg">
      <span className="text-sm font-semibold text-ink mr-1">{count} selected</span>
      {visible.map(a => {
        const busy = busyKey === a.key
        return (
          <button key={a.key} onClick={a.onClick} disabled={a.disabled || !!busyKey}
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2.5 py-1.5 border transition-colors disabled:opacity-50 disabled:pointer-events-none',
              a.tone === 'danger' ? 'border-red-500/30 text-red-300 hover:bg-red-500/10'
                : a.tone === 'primary' ? 'border-accent bg-accent text-black hover:bg-accent-hover'
                : 'border-border-strong text-ink-muted hover:text-ink hover:bg-black/10',
            )}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <a.icon className="w-3.5 h-3.5" />} {a.label}
          </button>
        )
      })}
      <button onClick={onClear} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink">
        <X className="w-3.5 h-3.5" /> Clear
      </button>
    </div>
  )
}

// Row selection checkbox — forwards shift-click so lists get range-select for free.
export function SelectCheckbox({ checked, onToggle, className, label = 'Select' }: {
  checked: boolean
  onToggle: (shiftKey: boolean) => void
  className?: string
  label?: string
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      title={label}
      aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle(e.shiftKey) }}
      onChange={() => { /* handled in onClick to capture shiftKey */ }}
      className={cn('w-4 h-4 rounded border-border-strong accent-accent shrink-0 cursor-pointer', className)}
    />
  )
}

// "Select all N" header toggle.
export function SelectAllToggle({ allSelected, onToggle, count, noun = 'item' }: {
  allSelected: boolean
  onToggle: () => void
  count: number
  noun?: string
}) {
  if (count === 0) return null
  return (
    <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
      <input type="checkbox" checked={allSelected} onChange={onToggle} className="w-4 h-4 rounded border-border-strong accent-accent" />
      Select all {count} {noun}{count !== 1 ? 's' : ''}
    </label>
  )
}
