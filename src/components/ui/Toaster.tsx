'use client'

import { useSyncExternalStore, useCallback } from 'react'
import { subscribeToasts, getToasts, dismissToast, type ToastItem } from '@/lib/toast'
import { CheckCircle2, AlertTriangle, Info, X, Undo2, Loader2 } from 'lucide-react'

// Renders the shared toast stack. Mounted once (dashboard layout). Bottom-center,
// non-blocking, auto-dismissing, with an optional Undo action per toast. One
// system for every feedback kind: info / success / warning / error / loading
// (sticky spinner, for progress + promise flows).

const TONE: Record<ToastItem['tone'], { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: 'border-border-strong bg-surface text-ink' },
  success: { icon: CheckCircle2, cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' },
  warning: { icon: AlertTriangle, cls: 'border-amber-500/30 bg-amber-500/10 text-amber-200' },
  error: { icon: AlertTriangle, cls: 'border-red-500/30 bg-red-500/10 text-red-200' },
  loading: { icon: Loader2, cls: 'border-border-strong bg-surface text-ink' },
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm pointer-events-none">
      {toasts.map(t => <ToastRow key={t.id} t={t} />)}
    </div>
  )
}

function ToastRow({ t }: { t: ToastItem }) {
  const meta = TONE[t.tone]
  const Icon = meta.icon
  const onUndo = useCallback(async () => {
    dismissToast(t.id)
    try { await t.undo?.() } catch { /* swallow — best-effort undo */ }
  }, [t])
  return (
    <div className={`pointer-events-auto flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg text-sm ${meta.cls}`}>
      <Icon className={`w-4 h-4 shrink-0 ${t.tone === 'loading' ? 'animate-spin' : ''}`} />
      <span className="flex-1 min-w-0">{t.message}</span>
      {t.undo && (
        <button onClick={onUndo} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2 py-1 border border-current/30 hover:bg-current/10 transition-colors">
          <Undo2 className="w-3.5 h-3.5" /> Undo
        </button>
      )}
      {t.action && (
        <button
          onClick={async () => { const run = t.action?.run; dismissToast(t.id); try { await run?.() } catch { /* best-effort follow-up */ } }}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2 py-1 border border-current/30 hover:bg-current/10 transition-colors">
          {t.action.label}
        </button>
      )}
      <button onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="shrink-0 text-ink-faint hover:text-ink">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
