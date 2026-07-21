'use client'

import { useEffect, useState, useCallback } from 'react'
import { useOnline } from '@/hooks/useOnline'
import { count, flush, subscribe } from '@/lib/offline/outbox'
import { registerOfflineHandlers } from '@/lib/offline/handlers'
import { cn } from '@/lib/utils'
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react'

// The single offline surface: shows when the app is offline (with any queued-write
// count) and auto-flushes the outbox the moment connectivity returns — reporting
// "Synced N". Reads the ONE outbox; it is not tied to any feature. Bottom-left so it
// never collides with the bottom-center Toaster.
export function OfflineStatus() {
  const online = useOnline()
  const [queued, setQueued] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [justSynced, setJustSynced] = useState(0)

  // Register replay handlers before the first flush can run (on reconnect / mount).
  useEffect(() => { registerOfflineHandlers() }, [])

  const refresh = useCallback(() => { count().then(setQueued).catch(() => {}) }, [])
  useEffect(() => { refresh(); return subscribe(refresh) }, [refresh])

  // Drain the outbox. No-ops when offline or empty; flush() itself is single-flight +
  // cross-tab locked, so overlapping triggers are safe.
  const syncNow = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (!(await count())) return
    setSyncing(true)
    const res = await flush()
    setSyncing(false)
    if (res.done > 0) { setJustSynced(res.done); setTimeout(() => { setJustSynced(0) }, 4000) }
  }, [])

  // Flush on mount, on reconnect, AND on wake/focus/interval — an op can be queued
  // while navigator.onLine is still true (a transient server blip), and without these
  // wake triggers it would otherwise strand in IndexedDB until a full page reload.
  useEffect(() => {
    syncNow()
    const onVisible = () => { if (document.visibilityState === 'visible') syncNow() }
    window.addEventListener('online', syncNow)
    window.addEventListener('focus', syncNow)
    document.addEventListener('visibilitychange', onVisible)
    const id = setInterval(syncNow, 30_000)   // syncNow no-ops when nothing is queued
    return () => {
      window.removeEventListener('online', syncNow)
      window.removeEventListener('focus', syncNow)
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(id)
    }
  }, [syncNow])

  if (online && queued === 0 && !syncing && justSynced === 0) return null

  const { cls, icon: Icon, spin, text } = !online
    ? { cls: 'border-amber-500/30 bg-amber-500/10 text-amber-200', icon: WifiOff, spin: false,
        text: queued > 0 ? `Offline — ${queued} change${queued !== 1 ? 's' : ''} will sync when you're back` : 'Offline — you can keep working' }
    : syncing
    ? { cls: 'border-border-strong bg-surface text-ink', icon: RefreshCw, spin: true, text: 'Syncing…' }
    : { cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200', icon: CheckCircle2, spin: false,
        text: `Synced ${justSynced} change${justSynced !== 1 ? 's' : ''}` }

  return (
    <div className="fixed above-bottom-nav left-4 z-notice pointer-events-none animate-toast">
      <div className={cn('flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium shadow-lg', cls)}>
        <Icon className={cn('w-4 h-4 shrink-0', spin && 'animate-spin')} />
        <span>{text}</span>
      </div>
    </div>
  )
}
