'use client'

import { useState } from 'react'
import { DispatchConflict, ConflictSeverity } from '@/lib/dispatchOps'
import { cn } from '@/lib/utils'
import { AlertTriangle, ChevronDown, ShieldCheck } from 'lucide-react'

// ── Conflict panel ───────────────────────────────────────────────────────────
// The day's problems in one card, worst first, each row a jump to the lane (or
// stop) it names. Every fact here came from lib/dispatchOps.detectDayConflicts —
// this component only lists; it detects nothing. Renders nothing when the day
// is clean: silence is the calm state, not a green trophy.

const SEV_DOT: Record<ConflictSeverity, string> = {
  error: 'bg-red-400',
  warn: 'bg-amber-400',
  info: 'bg-sky-400',
}

export function ConflictPanel({ conflicts, onJump }: {
  conflicts: DispatchConflict[]
  onJump: (laneId: string, jobId?: string) => void
}) {
  const [open, setOpen] = useState(true)
  if (conflicts.length === 0) return null

  const errors = conflicts.filter(c => c.severity === 'error').length
  const warns = conflicts.filter(c => c.severity === 'warn').length
  const infos = conflicts.length - errors - warns
  const summary = [
    errors > 0 && `${errors} to fix`,
    warns > 0 && `${warns} to watch`,
    infos > 0 && `${infos} FYI`,
  ].filter(Boolean).join(' · ')

  return (
    <section
      aria-label="Dispatch conflicts"
      className={cn(
        'rounded-card border bg-bg-secondary animate-rise',
        errors > 0 ? 'border-red-500/40' : 'border-amber-500/30',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-card"
      >
        {errors > 0
          ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" aria-hidden />
          : <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" aria-hidden />}
        <span className="text-sm font-semibold text-ink">
          {conflicts.length} thing{conflicts.length !== 1 ? 's' : ''} in the way of this day
        </span>
        <span className="text-[11px] text-ink-faint tabular-nums">{summary}</span>
        <ChevronDown className={cn('w-4 h-4 text-ink-faint ml-auto shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <ul className="px-3 pb-3 space-y-1">
          {conflicts.map((c, i) => (
            <li key={`${c.kind}-${c.laneId}-${c.jobId ?? i}`}>
              <button
                type="button"
                onClick={() => onJump(c.laneId, c.jobId)}
                title="Jump to it on the board"
                className="w-full flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-xs text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', SEV_DOT[c.severity])} aria-hidden />
                <span className="min-w-0">{c.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
