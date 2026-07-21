'use client'

import { useSyncExternalStore, useCallback, useRef } from 'react'
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
  // The container stays mounted even when empty so it's a PERSISTENT polite live
  // region — screen readers announce each toast as it's added. Errors/warnings
  // escalate to role="alert" (assertive) on the row itself.
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed above-bottom-nav left-1/2 -translate-x-1/2 z-toast flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm pointer-events-none">
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
  // Errors/warnings interrupt (assertive); everything else is polite.
  const alert = t.tone === 'error' || t.tone === 'warning'

  // Flick a toast sideways to dismiss it — the whole row is the target, so you
  // don't have to hit the 3.5×3.5 X one-handed. This ADDS to the X + aria-live,
  // it doesn't replace them, so keyboard and screen-reader users lose nothing.
  //
  // Two swipe surfaces exist now (this + Modal's sheet). That's below the rule of
  // three, so the ~15 lines stay inline rather than becoming a premature shared
  // hook — extract when a third surface wants it, not before. Transform is
  // imperative so a finger-move doesn't re-render the toast stack.
  const rowRef = useRef<HTMLDivElement>(null)
  const startX = useRef<number | null>(null)
  const dx = useRef(0)

  function begin(e: React.TouchEvent) {
    // A touch that starts on a control is a tap for that control, never a drag.
    if (e.touches.length !== 1 || (e.target as HTMLElement).closest('button')) return
    startX.current = e.touches[0].clientX
    dx.current = 0
    if (rowRef.current) rowRef.current.style.transition = 'none'
  }
  function move(e: React.TouchEvent) {
    if (startX.current == null) return
    const d = e.touches[0].clientX - startX.current
    dx.current = d
    const row = rowRef.current
    if (!row) return
    row.style.transform = `translateX(${d}px)`
    // Fade with distance so it reads as "leaving", and previews the dismiss.
    row.style.opacity = String(Math.max(0, 1 - Math.abs(d) / 220))
  }
  function end() {
    if (startX.current == null) return
    const d = dx.current
    startX.current = null
    const row = rowRef.current
    if (!row) return
    if (Math.abs(d) > 80) { dismissToast(t.id); return }
    // Snap back — instant under reduced-motion, which the global net also honours.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    row.style.transition = reduce ? 'none' : 'transform 0.2s ease, opacity 0.2s ease'
    row.style.transform = ''
    row.style.opacity = ''
  }

  return (
    <div
      ref={rowRef}
      role={alert ? 'alert' : 'status'}
      onTouchStart={begin}
      onTouchMove={move}
      onTouchEnd={end}
      // pan-y lets a vertical page scroll pass through; horizontal is the swipe.
      className={`pointer-events-auto touch-pan-y flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg text-sm animate-toast ${meta.cls}`}>
      <Icon aria-hidden="true" className={`w-4 h-4 shrink-0 ${t.tone === 'loading' ? 'animate-spin' : ''}`} />
      <span className="flex-1 min-w-0">{t.message}</span>
      {t.undo && (
        <button type="button" onClick={onUndo} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2 py-1 border border-current/30 hover:bg-current/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Undo2 className="w-3.5 h-3.5" /> Undo
        </button>
      )}
      {t.action && (
        <button
          type="button"
          onClick={async () => { const run = t.action?.run; dismissToast(t.id); try { await run?.() } catch { /* best-effort follow-up */ } }}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2 py-1 border border-current/30 hover:bg-current/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          {t.action.label}
        </button>
      )}
      <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="shrink-0 p-1 -m-1 rounded text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
