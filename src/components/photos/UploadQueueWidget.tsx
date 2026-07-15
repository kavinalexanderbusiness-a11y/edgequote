'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  subscribeUploads, getUploadItems, getUploadServerSnapshot,
  retryUpload, retryAllFailed, dismissUpload, clearDone, type QueueItem,
} from '@/lib/uploadQueue'
import { cn } from '@/lib/utils'
import { UploadCloud, Loader2, Check, AlertTriangle, RotateCw, X, ChevronDown, ChevronUp, WifiOff } from 'lucide-react'

// ── Upload tray — the ONE place upload progress is shown ─────────────────────────
// Mounted once in the dashboard layout (beside <Toaster/>), driven by the global
// uploadQueue store. Stays put while you navigate, so background uploads always have
// a home. Optimistic (thumbnails appear instantly), retryable, offline-aware.
export function UploadQueueWidget() {
  const items = useSyncExternalStore(subscribeUploads, getUploadItems, getUploadServerSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true)
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  if (!items.length) return null
  const done = items.filter(i => i.status === 'done').length
  const failed = items.filter(i => i.status === 'error').length
  const active = items.filter(i => i.status === 'uploading' || i.status === 'queued' || i.status === 'paused').length
  const allDone = active === 0 && failed === 0

  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-[60] w-[300px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-bg-secondary shadow-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        {active > 0 ? <Loader2 className="w-4 h-4 text-accent-text animate-spin" aria-hidden="true" /> : failed > 0 ? <AlertTriangle className="w-4 h-4 text-red-400" aria-hidden="true" /> : <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />}
        <span className="text-xs font-semibold text-ink flex-1 truncate"
          aria-label={`${active > 0 ? `Uploading ${active}` : failed > 0 ? `${failed} failed` : 'Uploads complete'} — ${done} of ${items.length} done`}>
          {active > 0 ? `Uploading ${active}…` : failed > 0 ? `${failed} failed` : 'Uploads complete'}
          <span className="text-ink-faint font-normal" aria-hidden="true"> · {done}/{items.length}</span>
        </span>
        {failed > 0 && <button onClick={retryAllFailed} className="text-[11px] font-semibold text-accent-text hover:underline">Retry all</button>}
        <button onClick={() => setCollapsed(c => !c)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} className="text-ink-faint hover:text-ink">{collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</button>
        {allDone && <button onClick={() => clearDone()} aria-label="Clear finished uploads" title="Clear finished" className="text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>}
      </div>

      {offline && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 text-[11px] text-amber-300 border-b border-amber-500/20">
          <WifiOff className="w-3.5 h-3.5" /> Offline — uploads resume when you reconnect
        </div>
      )}

      {!collapsed && (
        <div className="max-h-[40vh] overflow-auto p-2 grid grid-cols-5 gap-1.5">
          {items.map(it => <Thumb key={it.id} it={it} />)}
        </div>
      )}
    </div>
  )
}

function Thumb({ it }: { it: QueueItem }) {
  return (
    <div className="relative aspect-square rounded-md overflow-hidden border border-border bg-bg-tertiary group">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={it.previewUrl} alt="" className={cn('w-full h-full object-cover', it.status === 'done' ? '' : 'opacity-70')} />
      <span className={cn('absolute top-0.5 left-0.5 text-[7px] font-bold uppercase rounded px-0.5 border',
        it.kind === 'before' ? 'bg-amber-500/80 text-white border-amber-300' : it.kind === 'after' ? 'bg-emerald-500/80 text-white border-emerald-300' : 'bg-black/60 text-white border-white/30')}>
        {it.kind[0]}
      </span>
      <span className="absolute inset-0 flex items-center justify-center">
        {it.status === 'uploading' && <Loader2 className="w-4 h-4 animate-spin text-white drop-shadow" />}
        {it.status === 'queued' && <UploadCloud className="w-3.5 h-3.5 text-white/80" />}
        {it.status === 'paused' && <WifiOff className="w-3.5 h-3.5 text-amber-300" />}
        {it.status === 'done' && <Check className="w-4 h-4 text-emerald-300 drop-shadow" />}
        {it.status === 'error' && (
          <button onClick={() => retryUpload(it.id)} aria-label="Retry upload" title={it.error || 'Retry'} className="h-5 w-5 rounded-full bg-red-500/80 text-white flex items-center justify-center">
            <RotateCw className="w-3 h-3" />
          </button>
        )}
      </span>
      {(it.status === 'error' || it.status === 'done') && (
        <button onClick={() => dismissUpload(it.id)} aria-label="Dismiss upload" className="absolute top-0.5 right-0.5 h-3.5 w-3.5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
          <X className="w-2 h-2" />
        </button>
      )}
    </div>
  )
}
