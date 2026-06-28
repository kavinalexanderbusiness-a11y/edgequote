'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { captureStampFor, CaptureStamp } from '@/lib/exif'
import { detectBeforeAfter, DetectConfidence } from '@/lib/beforeafter/autodetect'
import { resolveTargetJob, JobRow } from '@/lib/beforeafter/autopair'
import { enqueueUploads } from '@/lib/uploadQueue'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  UploadCloud, ArrowLeftRight, X, Loader2, Check, ImageIcon, MapPin, AlertTriangle, Sparkles,
} from 'lucide-react'

const LAST_CTX_KEY = 'eq:ba-last-context'

interface Staged {
  id: string
  file: File
  url: string
  kind: 'before' | 'after'
  stamp: CaptureStamp | null
  sig: string                 // dedup signature (name|size|lastModified)
  status: 'staged' | 'uploading' | 'done' | 'error'
}
interface LastCtx { propertyId: string; customerId: string | null; label: string }
interface PropHit { id: string; address: string | null; city: string | null; neighborhood: string | null; customer_id: string | null; customerName: string | null }

// ── Smart Before/After uploader ──────────────────────────────────────────────────
// Drag many photos at once → EdgeQuote figures out the rest:
//  • Auto-detects before vs after from capture time (EXIF) or order; one-click swap.
//  • Auto-attaches to the open/most-relevant job for the property (asks only when
//    genuinely ambiguous).
//  • Remembers the last property/customer so you don't keep selecting them.
//  • Compresses + uploads in PARALLEL with instant local previews — the UI never
//    waits on the network; pairing happens in the background.
//  • Once a before+after exist on a job, records the pair in the SHARED
//    marketing_assets so Marketing Studio, the Studio gallery, property history,
//    timeline and portal all see it — no duplicate storage.
// Reuses lib/photos (job_photos + the job-photos bucket) end to end.
export function BeforeAfterUploader({
  propertyId: fixedPropertyId, customerId: fixedCustomerId, jobId: fixedJobId, propertyLabel,
  onUploaded, onClose, autoFocusDrop,
}: {
  propertyId?: string | null
  customerId?: string | null
  jobId?: string | null
  propertyLabel?: string | null
  onUploaded?: () => void   // fired once the batch is ENQUEUED (uploads run in the background)
  onClose?: () => void
  autoFocusDrop?: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const fixedContext = !!fixedPropertyId
  const fileRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLLabelElement>(null)

  const [staged, setStaged] = useState<Staged[]>([])
  const [confidence, setConfidence] = useState<DetectConfidence>('high')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Resolved context (property/customer + the job the pair attaches to).
  const [propertyId, setPropertyId] = useState<string | null>(fixedPropertyId ?? null)
  const [customerId, setCustomerId] = useState<string | null>(fixedCustomerId ?? null)
  const [ctxLabel, setCtxLabel] = useState<string | null>(propertyLabel ?? null)
  const [jobId, setJobId] = useState<string | null>(fixedJobId ?? null)
  const [job, setJob] = useState<JobRow | null>(null)
  const [jobChoices, setJobChoices] = useState<JobRow[]>([])
  const [needsJobAsk, setNeedsJobAsk] = useState(false)

  // Property search (only in non-fixed mode).
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PropHit[]>([])
  const [searching, setSearching] = useState(false)

  // Prefill the last-used property so the owner doesn't reselect it.
  useEffect(() => {
    if (fixedContext) return
    try {
      const raw = localStorage.getItem(LAST_CTX_KEY)
      if (raw) { const c = JSON.parse(raw) as LastCtx; setPropertyId(c.propertyId); setCustomerId(c.customerId); setCtxLabel(c.label) }
    } catch { /* ignore */ }
  }, [fixedContext])

  // Resolve the target job whenever the property (or explicit job) changes.
  useEffect(() => {
    if (!propertyId && !fixedJobId) { setJob(null); setJobChoices([]); setNeedsJobAsk(false); return }
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !alive) return
      const r = await resolveTargetJob(supabase, user.id, propertyId, fixedJobId, Date.now())
      if (!alive) return
      setJobId(r.jobId); setJob(r.job); setJobChoices(r.candidates); setNeedsJobAsk(r.needsAsk)
      if (r.job?.customer_id && !customerId) setCustomerId(r.job.customer_id)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, fixedJobId])

  // Debounced property search.
  useEffect(() => {
    if (fixedContext) return
    const q = query.trim()
    if (q.length < 2) { setHits([]); return }
    let alive = true
    setSearching(true)
    const t = setTimeout(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !alive) return
      const { data } = await supabase.from('properties')
        .select('id,address,city,neighborhood,customer_id,customers(name)')
        .eq('user_id', user.id).ilike('address', `%${q}%`).limit(8)
      if (!alive) return
      type Row = { id: string; address: string | null; city: string | null; neighborhood: string | null; customer_id: string | null; customers: { name: string | null }[] | { name: string | null } | null }
      const rows = (data as unknown as Row[]) || []
      setHits(rows.map(r => {
        const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers
        return { id: r.id, address: r.address, city: r.city, neighborhood: r.neighborhood, customer_id: r.customer_id, customerName: cust?.name ?? null }
      }))
      setSearching(false)
    }, 250)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, fixedContext])

  // Clean up object URLs on unmount.
  useEffect(() => () => { staged.forEach(s => URL.revokeObjectURL(s.url)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const runDetect = useCallback(async (list: Staged[]) => {
    // Read capture stamps in parallel, then assign before/after + confidence.
    const stamps = await Promise.all(list.map(s => s.stamp ? Promise.resolve(s.stamp) : captureStampFor(s.file)))
    const det = detectBeforeAfter(stamps)
    setConfidence(det.confidence)
    setStaged(prev => prev.map((s, i) => {
      const idx = list.findIndex(l => l.id === s.id)
      if (idx === -1) return s
      return { ...s, stamp: stamps[idx], kind: det.items[idx]?.kind ?? s.kind }
    }))
  }, [])

  const addFiles = useCallback((files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'))
    if (!images.length) return
    setStaged(prev => {
      const have = new Set(prev.map(s => s.sig))
      const next = [...prev]
      for (const file of images) {
        const sig = `${file.name}|${file.size}|${file.lastModified}`
        if (have.has(sig)) continue // avoid duplicate processing of the same file
        have.add(sig)
        next.push({ id: `${sig}-${Math.random().toString(36).slice(2, 7)}`, file, url: URL.createObjectURL(file), kind: 'after', stamp: null, sig, status: 'staged' })
      }
      // Kick off detection on the full set (background; previews already shown).
      void runDetect(next)
      return next
    })
  }, [runDetect])

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    addFiles(Array.from(e.dataTransfer.files || []))
  }
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files || []))
    e.target.value = ''
  }
  function flip(id: string) {
    setStaged(prev => prev.map(s => s.id === id ? { ...s, kind: s.kind === 'before' ? 'after' : 'before' } : s))
  }
  function removeStaged(id: string) {
    setStaged(prev => { const hit = prev.find(s => s.id === id); if (hit) URL.revokeObjectURL(hit.url); return prev.filter(s => s.id !== id) })
  }
  function pickProperty(h: PropHit) {
    setPropertyId(h.id); setCustomerId(h.customer_id); setCtxLabel(h.address || 'Property'); setQuery(''); setHits([])
    try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify({ propertyId: h.id, customerId: h.customer_id, label: h.address || 'Property' } satisfies LastCtx)) } catch { /* ignore */ }
  }

  const befores = staged.filter(s => s.kind === 'before')
  const afters = staged.filter(s => s.kind === 'after')
  const canUpload = staged.length > 0 && !!propertyId && !uploading && !(needsJobAsk && !jobId)

  async function doUpload() {
    if (!propertyId) { toast('Pick a property first', { tone: 'error' }); return }
    setUploading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setUploading(false); toast('Not signed in', { tone: 'error' }); return }

    // Remember the context for next time.
    if (!fixedContext && ctxLabel) {
      try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify({ propertyId, customerId, label: ctxLabel } satisfies LastCtx)) } catch { /* ignore */ }
    }

    // Hand off to the background queue — it compresses + uploads (parallel, retrying),
    // auto-pairs into marketing_assets, and reports progress in the global tray. The
    // owner keeps working immediately; the queue owns the previews from here.
    enqueueUploads({
      ctx: { userId: user.id, propertyId, jobId: jobId ?? null, customerId },
      pairJob: job,
      label: ctxLabel || undefined,
      items: staged.map(s => ({
        file: s.file,
        kind: s.kind,
        takenAt: s.stamp?.exact ? new Date(s.stamp.ms).toISOString() : null,
      })),
    })

    toast('Uploading in the background — keep working', { tone: 'success' })
    staged.forEach(s => URL.revokeObjectURL(s.url))
    setStaged([])
    setUploading(false)
    onUploaded?.()
    onClose?.()
  }

  return (
    <div className="space-y-3">
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPick} />

      {/* ── Context: where do these photos belong ── */}
      {fixedContext ? (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <MapPin className="w-3.5 h-3.5 text-accent" />
          <span className="font-medium text-ink">{ctxLabel || 'This property'}</span>
          {job && <span className="text-ink-faint">· {job.title || job.service_type || 'job'}</span>}
        </div>
      ) : (
        <div className="relative">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-ink-faint shrink-0" />
            {propertyId ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-sm font-medium text-ink truncate">{ctxLabel}</span>
                <button type="button" onClick={() => { setPropertyId(null); setCtxLabel(null); setJobId(null); setJob(null) }} className="text-[11px] text-accent hover:underline shrink-0">Change</button>
              </div>
            ) : (
              <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search property by address…"
                className="flex-1 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
            )}
          </div>
          {!propertyId && (query.trim().length >= 2) && (
            <div className="absolute z-20 mt-1 w-full bg-bg-secondary border border-border rounded-lg shadow-lg overflow-hidden">
              {searching && <p className="px-3 py-2 text-xs text-ink-faint">Searching…</p>}
              {!searching && hits.length === 0 && <p className="px-3 py-2 text-xs text-ink-faint">No matches</p>}
              {hits.map(h => (
                <button key={h.id} type="button" onClick={() => pickProperty(h)}
                  className="w-full text-left px-3 py-2 hover:bg-bg-tertiary border-b border-border last:border-0">
                  <p className="text-sm text-ink truncate">{h.address || 'Property'}</p>
                  <p className="text-[11px] text-ink-faint truncate">{[h.customerName, h.neighborhood || h.city].filter(Boolean).join(' · ')}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Ambiguous job → ask which one (don't guess). */}
      {needsJobAsk && jobChoices.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5 space-y-1.5">
          <p className="text-[11px] font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Which job are these for?</p>
          <div className="flex flex-wrap gap-1.5">
            {jobChoices.map(c => (
              <button key={c.id} type="button" onClick={() => { setJobId(c.id); setJob(c); setNeedsJobAsk(false) }}
                className={cn('text-[11px] rounded-lg px-2 py-1 border', jobId === c.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-muted hover:text-ink')}>
                {c.title || c.service_type || 'Job'} · {c.completed_at ? new Date(c.completed_at).toLocaleDateString() : c.scheduled_date}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Drop zone ── */}
      <label ref={dropRef}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={cn('flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors',
          dragOver ? 'border-accent bg-accent/10' : 'border-border hover:border-border-strong bg-bg-tertiary')}>
        <UploadCloud className={cn('w-6 h-6', dragOver ? 'text-accent' : 'text-ink-faint')} />
        <p className="text-sm font-medium text-ink">Drag photos here, or click to choose</p>
        <p className="text-[11px] text-ink-faint">Drop the before &amp; after together — EdgeQuote sorts them automatically</p>
      </label>

      {/* ── Staged previews ── */}
      {staged.length > 0 && (
        <div className="space-y-2">
          {confidence === 'low' && (
            <p className="text-[11px] text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Couldn&apos;t tell before from after — check the tags below and tap to swap.</p>
          )}
          {confidence !== 'low' && befores.length > 0 && afters.length > 0 && (
            <p className="text-[11px] text-emerald-300 flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Auto-sorted by capture time — tap any photo to swap before/after.</p>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {staged.map(s => (
              <div key={s.id} className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt="" className="w-full h-full object-cover" />
                <button type="button" onClick={() => flip(s.id)} disabled={uploading}
                  className={cn('absolute top-1 left-1 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 border',
                    s.kind === 'before' ? 'bg-amber-500/80 text-white border-amber-300' : 'bg-emerald-500/80 text-white border-emerald-300')}>
                  <ArrowLeftRight className="w-2.5 h-2.5" /> {s.kind}
                </button>
                {s.status === 'uploading' && <span className="absolute inset-0 bg-black/40 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-white" /></span>}
                {s.status === 'done' && <span className="absolute inset-0 bg-emerald-500/30 flex items-center justify-center"><Check className="w-5 h-5 text-white" /></span>}
                {!uploading && (
                  <button type="button" onClick={() => removeStaged(s.id)} className="absolute top-1 right-1 h-4 w-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100"><X className="w-2.5 h-2.5" /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[11px] text-ink-faint flex items-center gap-1">
          <ImageIcon className="w-3.5 h-3.5" /> {befores.length} before · {afters.length} after
        </span>
        <div className="flex items-center gap-2">
          {onClose && <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>}
          <Button type="button" size="sm" onClick={doUpload} disabled={!canUpload} loading={uploading}>
            <UploadCloud className="w-3.5 h-3.5" /> Upload{staged.length ? ` ${staged.length}` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}
