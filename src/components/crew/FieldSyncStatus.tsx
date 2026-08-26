'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOnline } from '@/hooks/useOnline'
import { count, flush, subscribe } from '@/lib/offline/outbox'
import { cn } from '@/lib/utils'
import { WifiOff, RefreshCw, CheckCircle2 } from 'lucide-react'

// ── The one connectivity surface a worker gets ───────────────────────────────
// ⭐ SMALL, AND ONLY WHEN IT HAS SOMETHING TO SAY. A field app that paints a
// giant red banner across every screen the moment a phone drops a bar trains
// people to ignore it — and bad signal is the NORMAL condition of this job, not
// an emergency. So: one pill, bottom-left, and it renders nothing at all when
// the phone is online with an empty queue (the overwhelmingly common case).
//
// What it may say, exhaustively:
//   Offline               · no signal, nothing waiting
//   Offline · 2 to sync   · no signal, work held on this phone
//   Saving…               · draining the queue right now
//   Synced 2              · it just landed (brief, then gone)
//   2 to sync — Retry     · online, still holding work; the tap is theirs
//
// ⛔ It never says "Saved". Per-action confirmations belong to the action that
// was taken, and a global widget claiming success for work it did not watch is
// exactly the false reassurance this whole layer exists to remove.
//
// ⭐ This is the CREW twin of components/pwa/OfflineStatus, and it deliberately
// does not reuse it: that one lazy-imports the OWNER's replay handlers, which
// pull the invoicing, comms and pricing engines (~46 kB) that a crew session has
// no grants to run. Same outbox ENGINE underneath — the shared queue, the shared
// flush, the shared lock — different handler registration. One queue, two doors.

export function FieldSyncStatus() {
  const online = useOnline()
  const [queued, setQueued] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [justSynced, setJustSynced] = useState(0)

  const refresh = useCallback(() => { count().then(setQueued).catch(() => {}) }, [])
  useEffect(() => { refresh(); return subscribe(refresh) }, [refresh])

  // Drain the queue. The handlers — and lib/field's reconciliation engine with
  // them — load HERE, behind the empty-queue exit, so a worker whose day never
  // hits a dead zone never downloads them. Registration is module-guarded, and a
  // failed chunk fetch strands nothing: ops stay on disk and the next wake
  // retries.
  const syncNow = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (!(await count())) return
    setSyncing(true)
    try {
      const { registerFieldHandlers } = await import('@/lib/field/handlers')
      registerFieldHandlers()
      const { done } = await flush()
      if (done > 0) {
        setJustSynced(done)
        window.setTimeout(() => setJustSynced(0), 4000)
      }
    } catch { /* stays queued; the next wake tries again */ }
    finally { setSyncing(false); refresh() }
  }, [refresh])

  // The same liveness contract the rest of Crew Mode runs on: reconnect, return
  // to the foreground, and a slow tick. A phone rides in a truck with the screen
  // off, so "on reconnect" alone would miss the case where signal returns while
  // the app is backgrounded and the worker opens it minutes later.
  useEffect(() => {
    const wake = () => { if (document.visibilityState === 'visible') void syncNow() }
    void syncNow()
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    const t = window.setInterval(wake, 30_000)
    return () => {
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
      window.clearInterval(t)
    }
  }, [syncNow])

  // Nothing to report → render nothing. ⛔ Not a hidden element, not a zero-count
  // badge: no pixels.
  if (online && queued === 0 && justSynced === 0) return null

  const label = !online
    ? (queued > 0 ? `Offline · ${queued} to sync` : 'Offline')
    : syncing ? 'Saving…'
    : justSynced > 0 ? `Synced ${justSynced}`
    : `${queued} to sync`

  const tone = !online ? 'amber' : justSynced > 0 && queued === 0 ? 'emerald' : 'amber'

  return (
    <div
      className={cn(
        'fixed left-3 z-40 flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-sm backdrop-blur',
        // Clear of the fixed crew nav AND the home-indicator inset, so it never
        // sits under the thumb bar it would otherwise cover.
        'bottom-[calc(4.5rem+env(safe-area-inset-bottom))]',
        tone === 'emerald'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-200',
      )}
      role="status"
      aria-live="polite"
    >
      {!online ? <WifiOff className="w-3.5 h-3.5" aria-hidden />
        : syncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden />
        : justSynced > 0 && queued === 0 ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
        : <RefreshCw className="w-3.5 h-3.5" aria-hidden />}
      <span>{label}</span>
      {/* Online with work still held: offer the tap rather than hammering the
          network on a timer. ⛔ "Do not silently resend forever." */}
      {online && !syncing && queued > 0 && (
        <button type="button" onClick={() => void syncNow()} className="underline underline-offset-2">
          Retry
        </button>
      )}
    </div>
  )
}
