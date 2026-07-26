'use client'

import { useEffect, useState, useCallback } from 'react'
import { useOnline } from '@/hooks/useOnline'
import { count, flush, subscribe } from '@/lib/offline/outbox'
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

  const refresh = useCallback(() => { count().then(setQueued).catch(() => {}) }, [])
  useEffect(() => { refresh(); return subscribe(refresh) }, [refresh])

  // Drain the outbox. No-ops when offline or empty; flush() itself is single-flight +
  // cross-tab locked, so overlapping triggers are safe.
  //
  // The replay handlers — and the engines they pull in (invoicing, comms
  // idempotency, parts, price audit: ~46 kB minified) — load HERE, behind the
  // empty-outbox early exit, registered before flush() exactly as the mount
  // effect used to guarantee. In the overwhelmingly common session (nothing
  // queued) that graph is never downloaded at all; it used to ship in every
  // dashboard route's layout bundle just in case. Registration is idempotent
  // (module-guarded), and a failed chunk fetch strands nothing: ops stay
  // queued and the 30s interval / next wake retries — the same net the outbox
  // already gives ops with no registered handler.
  const syncNow = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (!(await count())) return
    setSyncing(true)
    try {
      const { registerOfflineHandlers } = await import('@/lib/offline/handlers')
      registerOfflineHandlers()
      const res = await flush()
      if (res.done > 0) { setJustSynced(res.done); setTimeout(() => { setJustSynced(0) }, 4000) }
    } catch { /* retried by the interval/wake triggers */ } finally {
      setSyncing(false)
    }
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
