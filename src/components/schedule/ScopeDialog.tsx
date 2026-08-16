'use client'

import { useEffect } from 'react'
import { RecurrenceScope } from '@/types'
import { Repeat, AlertTriangle } from 'lucide-react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import type { ScopeImpact } from '@/lib/recurrence'

interface ScopeDialogProps {
  title: string
  verb: string // e.g. "Save changes to" / "Move" / "Delete"
  destructive?: boolean
  /** Per-scope reach from lib/recurrence.scopeImpacts — the same predicate the
   *  mutation runs. Omitted (older call sites) falls back to the bare labels. */
  impacts?: ScopeImpact[]
  onChoose: (scope: RecurrenceScope) => void
  onCancel: () => void
}

const OPTIONS: { scope: RecurrenceScope; label: string }[] = [
  { scope: 'this', label: 'This visit only' },
  { scope: 'future', label: 'This and future visits' },
  { scope: 'all', label: 'All visits' },
]

// Apple Calendar-style scope chooser for editing/moving/deleting a recurring job.
export function ScopeDialog({ title, verb, destructive, impacts, onChoose, onCancel }: ScopeDialogProps) {
  // Dialog hygiene: trap + restore focus + Escape (shared hook), background scroll lock.
  const panelRef = useFocusTrap<HTMLDivElement>(true, onCancel)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  return (
    <div className="fixed inset-0 z-overlay flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${verb} recurring job`}
        className="w-full max-w-sm bg-surface border border-border-strong rounded-2xl overflow-hidden shadow-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 flex items-center gap-2 border-b border-border">
          <Repeat className="w-4 h-4 text-accent-text" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-ink">{verb} recurring job</p>
            <p className="text-xs text-ink-muted mt-0.5 truncate">{title}</p>
          </div>
        </div>
        <div className="p-2">
          {OPTIONS.map(o => {
            const impact = impacts?.find(i => i.scope === o.scope)
            // Counted history is the loud part: it is the only thing in this
            // dialog that cannot be undone by scheduling the work again.
            const touchesHistory = !!impact?.historyNote && destructive
            return (
              <button
                key={o.scope}
                onClick={() => onChoose(o.scope)}
                className={`w-full text-left px-4 py-3 rounded-xl transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  destructive && o.scope !== 'this' ? 'text-red-400' : 'text-ink'
                }`}
              >
                <span className="block text-sm font-medium">{impact?.label ?? o.label}</span>
                {impact?.historyNote && (
                  <span className={`mt-0.5 flex items-center gap-1 text-xs font-medium ${touchesHistory ? 'text-amber-400' : 'text-ink-muted'}`}>
                    {touchesHistory && <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />}
                    {impact.historyNote}
                  </span>
                )}
              </button>
            )
          })}
          <button
            onClick={onCancel}
            className="w-full text-center px-4 py-3 mt-1 rounded-xl text-sm font-medium text-ink-muted hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
