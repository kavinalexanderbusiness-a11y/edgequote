'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { captureMetaFor, CaptureMeta } from '@/lib/exif'
import { clusterPhotoGroups, DetectConfidence } from '@/lib/beforeafter/autodetect'
import { resolveTargetJob, assignPhotoGroups, GroupAssignment, JobRow } from '@/lib/beforeafter/autopair'
import { enqueueUploads } from '@/lib/uploadQueue'
import { visualHash, findPhotoMatch, fileSignature, PHOTO_MATCH_LABEL, type ExistingPhotoLite, type PhotoMatchReason } from '@/lib/dedup'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  UploadCloud, ArrowLeftRight, X, Loader2, Check, ImageIcon, MapPin, AlertTriangle, Sparkles, CopyX, Layers,
} from 'lucide-react'

const LAST_CTX_KEY = 'eq:ba-last-context'

interface Staged {
  id: string
  file: File
  url: string
  kind: 'before' | 'after'
  meta: CaptureMeta | null
  hash: string | null
  dup: PhotoMatchReason | null   // matched an ALREADY-UPLOADED photo (unified dedup engine)
  groupIdx: number
  sig: string
}
interface LastCtx { propertyId: string; customerId: string | null; label: string }
interface PropHit { id: string; address: string | null; city: string | null; neighborhood: string | null; customer_id: string | null; customerName: string | null }

// ── Smart Before/After uploader ──────────────────────────────────────────────────
// Drag any number of photos — even a whole day across several jobs:
//  • EXIF capture time + GPS cluster the drop into VISITS (clusterPhotoGroups); each
//    visit is auto-assigned to its property (GPS → same-lot matcher) and that day's
//    job (assignPhotoGroups). Before vs after auto-detected inside each visit.
//  • THE unified dedup engine (lib/dedup) checks every photo against what's already
//    uploaded (content hash / capture timestamp) — duplicates are flagged and
//    skipped unless you say otherwise. One question, never silent.
//  • Everything confident happens automatically; only genuinely ambiguous groups
//    ask (one question each). Uploads run in the BACKGROUND queue — close this and
//    keep working; progress lives in the global tray.
export function BeforeAfterUploader({
  propertyId: fixedPropertyId, customerId: fixedCustomerId, jobId: fixedJobId, propertyLabel,
  onUploaded, onClose,
}: {
  propertyId?: string | null
  customerId?: string | null
  jobId?: string | null
  propertyLabel?: string | null
  onUploaded?: () => void   // fired once the batch is ENQUEUED (uploads run in the background)
  onClose?: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const fixedContext = !!fixedPropertyId
  const fileRef = useRef<HTMLInputElement>(null)
  const analyzeSeq = useRef(0)

  const [staged, setStaged] = useState<Staged[]>([])
  const [groups, setGroups] = useState<GroupAssignment[]>([])
  const [confidence, setConfidence] = useState<DetectConfidence>('high')
  const [analyzing, setAnalyzing] = useState(false)
  const [includeDups, setIncludeDups] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Single-visit context (used when the drop is ONE visit; multi-visit groups carry
  // their own property/job from the assigner).
  const [propertyId, setPropertyId] = useState<string | null>(fixedPropertyId ?? null)
  const [customerId, setCustomerId] = useState<string | null>(fixedCustomerId ?? null)
  const [ctxLabel, setCtxLabel] = useState<string | null>(propertyLabel ?? null)
  const [jobId, setJobId] = useState<string | null>(fixedJobId ?? null)
  const [job, setJob] = useState<JobRow | null>(null)
  const [jobChoices, setJobChoices] = useState<JobRow[]>([])
  const [needsJobAsk, setNeedsJobAsk] = useState(false)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PropHit[]>([])
  const [searching, setSearching] = useState(false)

  const multi = groups.length >= 2

  // Prefill the last-used property so the owner doesn't reselect it.
  useEffect(() => {
    if (fixedContext) return
    try {
      const raw = localStorage.getItem(LAST_CTX_KEY)
      if (raw) { const c = JSON.parse(raw) as LastCtx; setPropertyId(c.propertyId); setCustomerId(c.customerId); setCtxLabel(c.label) }
    } catch { /* ignore */ }
  }, [fixedContext])

  // Resolve the single-visit target job whenever the property changes.
  useEffect(() => {
    if (!propertyId && !fixedJobId) { setJob(null); setJobChoices([]); setNeedsJobAsk(false); return }
    let alive = true
    ;(async () => {
      // Local read — getUser() is a network call, and these gate the staging UI, so
      // with no signal they returned early and left Upload disabled with no reason given.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
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
      // Local read — getUser() is a network call, and these gate the staging UI, so
      // with no signal they returned early and left Upload disabled with no reason given.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
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

  // Revoke the previews we actually hold at unmount. This read `staged` with empty
  // deps, so the cleanup closed over the INITIAL EMPTY array and revoked nothing:
  // staging a driveway's photos and then closing without uploading pinned every
  // full-size blob for the life of the tab. On a phone that's the memory pressure
  // that gets the tab killed — which is the thing losing photos in the first place.
  // A ref so the cleanup sees the latest list without re-running per keystroke.
  const stagedRef = useRef<Staged[]>([])
  stagedRef.current = staged
  useEffect(() => () => { stagedRef.current.forEach(s => URL.revokeObjectURL(s.url)) }, [])

  // Fetch a property's existing photos for dedup (tolerates the content_hash column
  // not being migrated yet — falls back to timestamp-only matching).
  const loadExisting = useCallback(async (userId: string, propIds: string[]): Promise<Record<string, ExistingPhotoLite[]>> => {
    type Row = ExistingPhotoLite & { property_id: string | null }
    const out: Record<string, ExistingPhotoLite[]> = {}
    if (!propIds.length) return out
    const fetchCols = async (cols: string) => {
      const res = await supabase.from('job_photos').select(cols).eq('user_id', userId).in('property_id', propIds)
      return { rows: (res.data as unknown as Row[] | null) || [], error: res.error }
    }
    let { rows, error } = await fetchCols('id,taken_at,content_hash,property_id')
    if (error && /content_hash/i.test(error.message || '')) ({ rows } = await fetchCols('id,taken_at,property_id'))
    for (const r of rows) if (r.property_id) (out[r.property_id] ||= []).push(r)
    return out
  }, [supabase])

  // ── The analysis pipeline: cluster → assign → detect before/after → dedup ──────
  // Re-runs over the WHOLE staged set whenever files are added. Previews are already
  // on screen; this only refines tags/groups/dups as results stream in.
  const analyze = useCallback(async (list: Staged[]) => {
    const seq = ++analyzeSeq.current
    if (!list.length) { setGroups([]); return }
    setAnalyzing(true)
    try {
      const metas = await Promise.all(list.map(s => s.meta ? Promise.resolve(s.meta) : captureMetaFor(s.file)))
      if (seq !== analyzeSeq.current) return
      const clustered = clusterPhotoGroups(metas)
      setConfidence(clustered.confidence)

      // Apply per-photo kind + group index from the clusterer.
      const kindByIdx = new Map<number, 'before' | 'after'>()
      const groupByIdx = new Map<number, number>()
      clustered.groups.forEach((g, gi) => g.detect.items.forEach(it => { kindByIdx.set(it.index, it.kind); groupByIdx.set(it.index, gi) }))
      setStaged(prev => prev.map(s => {
        const idx = list.findIndex(l => l.id === s.id)
        if (idx === -1) return s
        return { ...s, meta: metas[idx], kind: kindByIdx.get(idx) ?? s.kind, groupIdx: groupByIdx.get(idx) ?? 0 }
      }))

      // Local read (see above) — a network round-trip here stalled EXIF grouping,
      // and offline it abandoned the analyse pass entirely.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user || seq !== analyzeSeq.current) return

      // Multi-visit drop → assign each cluster to its property + that day's job.
      let assigns: GroupAssignment[] = []
      if (clustered.groups.length >= 2) {
        assigns = await assignPhotoGroups(supabase, user.id, clustered.groups, { propertyId }, Date.now())
        if (seq !== analyzeSeq.current) return
        setGroups(assigns)
      } else {
        setGroups([])
      }

      // Dedup vs already-uploaded photos (per resolved property).
      const propIds = new Set<string>()
      if (clustered.groups.length >= 2) for (const a of assigns) { if (a.property) propIds.add(a.property.id) }
      else if (propertyId) propIds.add(propertyId)
      const existingByProp = await loadExisting(user.id, Array.from(propIds))
      const hashes = await Promise.all(list.map(s => s.hash ? Promise.resolve(s.hash) : visualHash(s.file)))
      if (seq !== analyzeSeq.current) return
      setStaged(prev => prev.map(s => {
        const idx = list.findIndex(l => l.id === s.id)
        if (idx === -1) return s
        const gi = groupByIdx.get(idx) ?? 0
        const pid = clustered.groups.length >= 2 ? assigns[gi]?.property?.id : propertyId
        const existing = pid ? existingByProp[pid] || [] : []
        const m = metas[idx]
        const match = findPhotoMatch(existing, { contentHash: hashes[idx], takenAtMs: m.ms, exactTime: m.exact })
        return { ...s, hash: hashes[idx], dup: match ? match.reason : null }
      }))
    } finally {
      if (seq === analyzeSeq.current) setAnalyzing(false)
    }
  }, [supabase, propertyId, loadExisting])

  // Re-run dedup/assignment when the chosen property changes (single-visit mode).
  useEffect(() => { if (staged.length) void analyze(staged) }, [propertyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = useCallback((files: File[]) => {
    const images = files.filter(f => f.type.startsWith('image/'))
    if (!images.length) return
    setStaged(prev => {
      const have = new Set(prev.map(s => s.sig))
      const next = [...prev]
      for (const file of images) {
        const sig = fileSignature(file)
        if (have.has(sig)) continue // same file dropped twice in this batch
        have.add(sig)
        next.push({
          id: `${sig}-${Math.random().toString(36).slice(2, 7)}`, file, url: URL.createObjectURL(file),
          kind: 'after', meta: null, hash: null, dup: null, groupIdx: 0, sig,
        })
      }
      void analyze(next)
      return next
    })
  }, [analyze])

  function onDrop(e: React.DragEvent) { e.preventDefault(); setDragOver(false); addFiles(Array.from(e.dataTransfer.files || [])) }
  function onPick(e: React.ChangeEvent<HTMLInputElement>) { addFiles(Array.from(e.target.files || [])); e.target.value = '' }
  function flip(id: string) { setStaged(prev => prev.map(s => s.id === id ? { ...s, kind: s.kind === 'before' ? 'after' : 'before' } : s)) }
  function removeStaged(id: string) {
    setStaged(prev => { const hit = prev.find(s => s.id === id); if (hit) URL.revokeObjectURL(hit.url); return prev.filter(s => s.id !== id) })
  }
  function pickProperty(h: PropHit) {
    setPropertyId(h.id); setCustomerId(h.customer_id); setCtxLabel(h.address || 'Property'); setQuery(''); setHits([])
    try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify({ propertyId: h.id, customerId: h.customer_id, label: h.address || 'Property' } satisfies LastCtx)) } catch { /* ignore */ }
  }
  function setGroupProperty(gi: number, p: { id: string; address: string | null; customer_id?: string | null }) {
    setGroups(prev => prev.map((g, i) => i === gi ? { ...g, property: { id: p.id, address: p.address, customer_id: p.customer_id ?? null }, confident: !!g.job } : g))
  }
  function setGroupJob(gi: number, j: JobRow) {
    setGroups(prev => prev.map((g, i) => i === gi ? { ...g, job: j, jobCandidates: [], confident: !!g.property } : g))
  }

  const dups = staged.filter(s => s.dup)
  const uploadable = staged.filter(s => includeDups || !s.dup)
  const unresolvedGroups = multi ? groups.filter(g => !g.property).length : 0
  const canUpload = uploadable.length > 0 && !uploading && !analyzing &&
    (multi ? unresolvedGroups === 0 : (!!propertyId && !(needsJobAsk && !jobId)))

  async function doUpload() {
    setUploading(true)
    // LOCAL session read. This was getUser() — a network call — so with no signal it
    // resolved { user: null } and returned here with "Not signed in": a flat lie to a
    // signed-in contractor, and worse, it returned BEFORE enqueueUploads. The staged
    // photos only ever existed as File refs in React state, so they never reached the
    // durable queue and died with the tab. A whole driveway's before/afters, gone —
    // and a photo is the one thing here that cannot be redone, because the lawn is
    // already mown. JobPhotos has always used getSession() for exactly this reason.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setUploading(false); toast('Session expired — sign in again.', { tone: 'error' }); return }

    if (!fixedContext && ctxLabel && propertyId) {
      try { localStorage.setItem(LAST_CTX_KEY, JSON.stringify({ propertyId, customerId, label: ctxLabel } satisfies LastCtx)) } catch { /* ignore */ }
    }

    const toItems = (list: Staged[]) => list.map(s => ({
      file: s.file, kind: s.kind,
      takenAt: s.meta?.exact ? new Date(s.meta.ms).toISOString() : null,
      contentHash: s.hash,
    }))

    if (multi) {
      // One background group per visit — each pairs into ITS job automatically.
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        const groupItems = uploadable.filter(s => s.groupIdx === gi)
        if (!groupItems.length || !g.property) continue
        enqueueUploads({
          ctx: { userId: user.id, propertyId: g.property.id, jobId: g.job?.id ?? null, customerId: g.property.customer_id ?? null },
          pairJob: g.job,
          label: g.property.address || undefined,
          items: toItems(groupItems),
        })
      }
    } else {
      if (!propertyId) { setUploading(false); toast('Pick a property first', { tone: 'error' }); return }
      enqueueUploads({
        ctx: { userId: user.id, propertyId, jobId: jobId ?? null, customerId },
        pairJob: job,
        label: ctxLabel || undefined,
        items: toItems(uploadable),
      })
    }

    const skipped = includeDups ? 0 : dups.length
    toast(`Uploading in the background — keep working${skipped ? ` · ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped` : ''}`, { tone: 'success' })
    staged.forEach(s => URL.revokeObjectURL(s.url))
    setStaged([]); setGroups([])
    setUploading(false)
    onUploaded?.()
    onClose?.()
  }

  const groupLabel = (g: GroupAssignment, gi: number) => {
    const t = g.group.startMs > 0 ? new Date(g.group.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
    return `Visit ${gi + 1}${t ? ` · ${t}` : ''}`
  }

  return (
    <div className="space-y-3">
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPick} />

      {/* ── Single-visit context (hidden in multi mode — groups own their context) ── */}
      {!multi && (fixedContext ? (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <MapPin className="w-3.5 h-3.5 text-accent-text" />
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
                <button type="button" onClick={() => { setPropertyId(null); setCtxLabel(null); setJobId(null); setJob(null) }} className="text-[11px] text-accent-text hover:underline shrink-0">Change</button>
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
      ))}

      {/* Ambiguous single-visit job → one question. */}
      {!multi && needsJobAsk && jobChoices.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5 space-y-1.5">
          <p className="text-[11px] font-semibold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Which job are these for?</p>
          <div className="flex flex-wrap gap-1.5">
            {jobChoices.map(c => (
              <button key={c.id} type="button" onClick={() => { setJobId(c.id); setJob(c); setNeedsJobAsk(false) }}
                className={cn('text-[11px] rounded-lg px-2 py-1 border', jobId === c.id ? 'border-accent bg-accent/10 text-accent-text' : 'border-border text-ink-muted hover:text-ink')}>
                {c.title || c.service_type || 'Job'} · {c.completed_at ? new Date(c.completed_at).toLocaleDateString() : c.scheduled_date}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Drop zone ── */}
      <label
        role="button"
        tabIndex={0}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click() } }}
        className={cn('flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          dragOver ? 'border-accent bg-accent/10' : 'border-border hover:border-border-strong bg-bg-tertiary')}>
        <UploadCloud className={cn('w-6 h-6', dragOver ? 'text-accent-text' : 'text-ink-faint')} />
        <p className="text-sm font-medium text-ink">Drag photos here, or click to choose</p>
        <p className="text-[11px] text-ink-faint">Drop a whole day at once — EdgeQuote splits it into visits and sorts before/after</p>
      </label>

      {/* ── Duplicate question (one, clear) ── */}
      {dups.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5 flex items-center justify-between gap-2">
          <p className="text-[11px] text-amber-300 flex items-center gap-1.5">
            <CopyX className="w-3.5 h-3.5 shrink-0" />
            Existing match found — {dups.length} photo{dups.length !== 1 ? 's look' : ' looks'} already uploaded.
          </p>
          <button type="button" onClick={() => setIncludeDups(v => !v)} aria-pressed={includeDups}
            className={cn('text-[11px] font-semibold rounded-lg px-2 py-1 border shrink-0', includeDups ? 'border-accent bg-accent/10 text-accent-text' : 'border-border text-ink-muted hover:text-ink')}>
            {includeDups ? 'Including duplicates' : 'Include duplicates'}
          </button>
        </div>
      )}

      {/* ── Staged previews ── */}
      {staged.length > 0 && (multi ? (
        <div className="space-y-3">
          <p className="text-[11px] text-emerald-300 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" /> {groups.length} visits detected from capture times{groups.some(g => g.group.centroid) ? ' + photo GPS' : ''} — each uploads to its own job.
          </p>
          {groups.map((g, gi) => (
            <div key={gi} className="rounded-xl border border-border p-2.5 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-ink">{groupLabel(g, gi)}</span>
                {g.property ? (
                  <span className="text-[11px] text-ink-muted flex items-center gap-1"><MapPin className="w-3 h-3 text-accent-text" /> {g.property.address || 'Property'}</span>
                ) : (
                  <span className="text-[11px] text-amber-300 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Which property?</span>
                )}
                {g.job && <span className="text-[11px] text-ink-faint">· {g.job.title || g.job.service_type || 'job'}</span>}
              </div>
              {/* One question per unresolved group: property candidates (GPS-near or the current pick). */}
              {!g.property && (
                <div className="flex flex-wrap gap-1.5">
                  {g.propertyCandidates.map(p => (
                    <button key={p.id} type="button" onClick={() => setGroupProperty(gi, p)}
                      className="text-[11px] rounded-lg px-2 py-1 border border-border text-ink-muted hover:text-ink">{p.address || 'Property'}</button>
                  ))}
                  {propertyId && ctxLabel && (
                    <button type="button" onClick={() => setGroupProperty(gi, { id: propertyId, address: ctxLabel, customer_id: customerId })}
                      className="text-[11px] rounded-lg px-2 py-1 border border-accent/40 bg-accent/10 text-accent-text">{ctxLabel}</button>
                  )}
                </div>
              )}
              {g.property && !g.job && g.jobCandidates.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {g.jobCandidates.map(j => (
                    <button key={j.id} type="button" onClick={() => setGroupJob(gi, j)}
                      className="text-[11px] rounded-lg px-2 py-1 border border-border text-ink-muted hover:text-ink">
                      {j.title || j.service_type || 'Job'}{j.start_time ? ` · ${j.start_time}` : ''}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-5 gap-1.5">
                {staged.filter(s => s.groupIdx === gi).map(s => <StagedThumb key={s.id} s={s} uploading={uploading} onFlip={flip} onRemove={removeStaged} />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {confidence === 'low' && !analyzing && (
            <p className="text-[11px] text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Couldn&apos;t tell before from after — check the tags below and tap to swap.</p>
          )}
          {confidence !== 'low' && staged.some(s => s.kind === 'before') && staged.some(s => s.kind === 'after') && (
            <p className="text-[11px] text-emerald-300 flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Auto-sorted by capture time — tap any photo to swap before/after.</p>
          )}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {staged.map(s => <StagedThumb key={s.id} s={s} uploading={uploading} onFlip={flip} onRemove={removeStaged} large />)}
          </div>
        </div>
      ))}

      {/* ── Actions ── */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[11px] text-ink-faint flex items-center gap-1">
          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
          {analyzing ? 'Sorting…' : `${staged.filter(s => s.kind === 'before').length} before · ${staged.filter(s => s.kind === 'after').length} after${multi ? ` · ${groups.length} visits` : ''}`}
        </span>
        <div className="flex items-center gap-2">
          {onClose && <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>}
          <Button type="button" size="sm" onClick={doUpload} disabled={!canUpload} loading={uploading}>
            <UploadCloud className="w-3.5 h-3.5" /> Upload{uploadable.length ? ` ${uploadable.length}` : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StagedThumb({ s, uploading, onFlip, onRemove, large }: {
  s: Staged; uploading: boolean; onFlip: (id: string) => void; onRemove: (id: string) => void; large?: boolean
}) {
  return (
    <div className={cn('relative aspect-square rounded-lg overflow-hidden border bg-bg-tertiary group', s.dup ? 'border-amber-500/50' : 'border-border')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={s.url} alt="" className={cn('w-full h-full object-cover', s.dup && 'opacity-50')} />
      <button type="button" onClick={() => onFlip(s.id)} disabled={uploading}
        title={`Switch to ${s.kind === 'before' ? 'after' : 'before'}`} aria-label={`Switch to ${s.kind === 'before' ? 'after' : 'before'}`}
        className={cn('absolute top-1 left-1 inline-flex items-center gap-0.5 font-bold uppercase tracking-wide rounded px-1 py-0.5 border', large ? 'text-[9px]' : 'text-[8px]',
          s.kind === 'before' ? 'bg-amber-500/80 text-white border-amber-300' : 'bg-emerald-500/80 text-white border-emerald-300')}>
        <ArrowLeftRight className={large ? 'w-2.5 h-2.5' : 'w-2 h-2'} /> {s.kind}
      </button>
      {s.dup && (
        <span title={PHOTO_MATCH_LABEL[s.dup]} className="absolute bottom-1 left-1 text-[10px] font-bold uppercase rounded px-1 py-0.5 bg-amber-500/90 text-white">dup</span>
      )}
      {!uploading && (
        <button type="button" onClick={() => onRemove(s.id)} aria-label="Remove photo" className="absolute top-1 right-1 h-4 w-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><X className="w-2.5 h-2.5" /></button>
      )}
    </div>
  )
}
