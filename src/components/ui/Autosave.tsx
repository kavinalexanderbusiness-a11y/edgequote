'use client'

import { Loader2, Check, RotateCcw, Trash2, FileClock } from 'lucide-react'
import type { AutosaveStatus } from '@/hooks/useAutosave'

// Subtle, non-intrusive "Draft saved" indicator + a one-line restore prompt. Pair
// with useAutosave; drop both into any long-form editor's header.

function ago(ts: number | null): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min${m !== 1 ? 's' : ''} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h !== 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  return `${d} day${d !== 1 ? 's' : ''} ago`
}

export function AutosaveStatus({ status, savedAt, className = '' }: { status: AutosaveStatus; savedAt: number | null; className?: string }) {
  if (status === 'idle' && !savedAt) return null
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] text-ink-faint ${className}`} aria-live="polite">
      {status === 'saving'
        ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
        : <><Check className="w-3 h-3 text-emerald-400" /> Draft saved{savedAt && status !== 'saved' ? ` · ${ago(savedAt)}` : ''}</>}
    </span>
  )
}

// Shown on reopen when a recoverable draft exists. Restore applies it; Discard drops it.
export function DraftRestoreBanner({ savedAt, onRestore, onDiscard, label = 'unsaved draft' }: {
  savedAt: number | null
  onRestore: () => void
  onDiscard: () => void
  label?: string
}) {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.07] px-3.5 py-2.5 flex items-center gap-3">
      <FileClock className="w-4 h-4 text-accent shrink-0" />
      <p className="text-xs text-ink flex-1 min-w-0">
        You have an {label}{savedAt ? <span className="text-ink-muted"> from {ago(savedAt)}</span> : ''}. Restore it?
      </p>
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={onRestore} className="inline-flex items-center gap-1 text-xs font-semibold text-accent rounded-lg px-2.5 py-1.5 border border-accent/30 hover:bg-accent/10 transition-colors">
          <RotateCcw className="w-3.5 h-3.5" /> Restore
        </button>
        <button onClick={onDiscard} aria-label="Discard draft" className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint rounded-lg px-2 py-1.5 hover:text-red-400 transition-colors">
          <Trash2 className="w-3.5 h-3.5" /> Discard
        </button>
      </div>
    </div>
  )
}
