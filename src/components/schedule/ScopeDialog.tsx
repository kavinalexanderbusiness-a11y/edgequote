'use client'

import { useEffect } from 'react'
import { RecurrenceScope } from '@/types'
import { Repeat } from 'lucide-react'

interface ScopeDialogProps {
  title: string
  verb: string // e.g. "Save changes to" / "Move" / "Delete"
  destructive?: boolean
  onChoose: (scope: RecurrenceScope) => void
  onCancel: () => void
}

const OPTIONS: { scope: RecurrenceScope; label: string }[] = [
  { scope: 'this', label: 'This Event Only' },
  { scope: 'future', label: 'This and Future Events' },
  { scope: 'all', label: 'All Events' },
]

// Apple Calendar-style scope chooser for editing/moving/deleting a recurring job.
export function ScopeDialog({ title, verb, destructive, onChoose, onCancel }: ScopeDialogProps) {
  // Same dialog hygiene as every other schedule modal: Escape closes,
  // background scroll locks, same scrim.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onCancel])
  return (
    <div role="dialog" aria-modal="true" aria-label={`${verb} recurring job`}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm bg-surface border border-border-strong rounded-2xl overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-3 flex items-center gap-2 border-b border-border">
          <Repeat className="w-4 h-4 text-accent" />
          <div>
            <p className="text-sm font-semibold text-ink">{verb} recurring job</p>
            <p className="text-xs text-ink-muted mt-0.5 truncate">{title}</p>
          </div>
        </div>
        <div className="p-2">
          {OPTIONS.map(o => (
            <button
              key={o.scope}
              onClick={() => onChoose(o.scope)}
              className={`w-full text-left px-4 py-3 rounded-xl text-sm font-medium transition-colors hover:bg-surface-raised ${
                destructive && o.scope !== 'this' ? 'text-red-400' : 'text-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
          <button
            onClick={onCancel}
            className="w-full text-center px-4 py-3 mt-1 rounded-xl text-sm font-medium text-ink-muted hover:bg-surface-raised transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
