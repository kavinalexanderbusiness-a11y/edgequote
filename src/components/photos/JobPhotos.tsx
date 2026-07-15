'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PhotoKind, PHOTO_KIND_LABELS } from '@/types'
import { JobPhotoView, listPhotos, uploadPhotos, deletePhoto, updatePhoto, thumbUrl } from '@/lib/photos'
import { captureMetaFor } from '@/lib/exif'
import { downloadBlob } from '@/lib/portalPdf'
import { toast } from '@/lib/toast'
import { formatDate } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Skeleton'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { Camera, ImagePlus, Trash2, X, Loader2, Check, ChevronLeft, ChevronRight, Download } from 'lucide-react'

interface Props {
  propertyId: string | null
  jobId?: string | null
  customerId?: string | null
  // 'visit' = capture surface on a job (Before/After buttons up front, Day Ops).
  // 'gallery' = a property's full visual history (also offers a plain Photo).
  variant?: 'visit' | 'gallery'
  // When provided (e.g. a list page that batch-fetched photos), the component
  // seeds from these and skips its own list query — so N galleries on one page
  // don't each fire a round-trip.
  initialPhotos?: JobPhotoView[]
  // Read-only viewer: hides capture/delete/retag/caption controls — just
  // thumbnails + the lightbox (with Download). Used to SHOW customer-attached
  // photos (booking photos on the profile / draft quote) without edit actions.
  readOnly?: boolean
  className?: string
}

const KIND_BADGE: Record<PhotoKind, string> = {
  before: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  after: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  general: 'bg-bg-tertiary text-ink-muted border-border',
}

// Bound the gallery pull so a property with a huge history doesn't fetch it all.
const GALLERY_FETCH_LIMIT = 60
const PAGE = 12 // tiles shown before "Show more"

// An in-flight upload rendered instantly from a local blob URL (no wait for the network).
interface PendingTile { tempId: string; url: string; kind: PhotoKind; status: 'uploading' | 'error'; file: File }

export function JobPhotos({ propertyId, jobId, customerId, variant = 'visit', initialPhotos, readOnly = false, className }: Props) {
  const supabase = createClient()
  const [photos, setPhotos] = useState<JobPhotoView[]>(initialPhotos ?? [])
  const [loading, setLoading] = useState(!initialPhotos)
  const [pending, setPending] = useState<PendingTile[]>([])
  const [kindFilter, setKindFilter] = useState<'all' | PhotoKind>('all')
  const [shown, setShown] = useState(PAGE)
  const [downloading, setDownloading] = useState<string | null>(null)
  // Track the open photo by ID (not index) so retagging/deleting/filtering can't make
  // the lightbox silently jump to a different photo — it stays on the same one or closes.
  const [lightboxId, setLightboxId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const pendingKind = useRef<PhotoKind>('after')
  const userIdRef = useRef<string | null>(null)
  const objectUrls = useRef<Set<string>>(new Set())
  const seq = useRef(0)

  useEffect(() => {
    let alive = true
    async function load() {
      // getSession is a LOCAL read (no network) — so N galleries on a page don't
      // each fire a GoTrue round-trip just to learn who the user is.
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id ?? null
      userIdRef.current = uid
      if (!uid) { if (alive) setLoading(false); return }
      if (initialPhotos) return // seeded by the parent — no child fetch needed
      const rows = await listPhotos(supabase, uid, { jobId, propertyId, limit: variant === 'gallery' ? GALLERY_FETCH_LIMIT : undefined })
      if (alive) { setPhotos(rows); setLoading(false) }
    }
    load()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, propertyId])

  // Free any preview blob URLs on unmount so a big session doesn't leak memory.
  useEffect(() => () => { for (const u of objectUrls.current) URL.revokeObjectURL(u) }, [])

  // Filtered + paged view over the loaded photos (client-side; no extra query).
  const filtered = useMemo(() => kindFilter === 'all' ? photos : photos.filter(p => p.kind === kindFilter), [photos, kindFilter])
  const visible = filtered.slice(0, shown)
  const counts = useMemo(() => {
    const c = { before: 0, after: 0, general: 0 } as Record<PhotoKind, number>
    for (const p of photos) c[p.kind]++
    return c
  }, [photos])

  // If the active filter empties out (e.g. you deleted the last "Before"), fall back
  // to All instead of showing a blank grid with a dead chip.
  useEffect(() => { if (kindFilter !== 'all' && counts[kindFilter] === 0) setKindFilter('all') }, [kindFilter, counts])

  // Lightbox navigation over the currently-filtered set, resolved by stable ID.
  const lightboxIdx = lightboxId != null ? filtered.findIndex(p => p.id === lightboxId) : -1
  const current = lightboxIdx >= 0 ? filtered[lightboxIdx] : null
  function step(delta: number) {
    setLightboxId(id => {
      const idx = filtered.findIndex(p => p.id === id)
      if (idx < 0) return id
      const n = idx + delta
      return n >= 0 && n < filtered.length ? filtered[n].id : id
    })
  }
  useEffect(() => {
    if (!lightboxId) return
    function onKey(e: KeyboardEvent) {
      // Don't hijack arrow keys while the caption input is focused (would discard typing).
      if (e.key === 'Escape') { setLightboxId(null); return }
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxId, filtered.length])

  function releaseTile(t: PendingTile) {
    URL.revokeObjectURL(t.url); objectUrls.current.delete(t.url)
  }

  // Before/After are taken standing on the lawn, so they go straight to the
  // camera: `capture="environment"` opens the rear shutter instead of the OS
  // "Take Photo / Photo Library" chooser, cutting a tap and a decision out of the
  // action a contractor repeats at every stop. "Add photo" keeps the plain picker
  // for attaching from the library, so neither capability is lost.
  function pick(kind: PhotoKind, source: 'camera' | 'library' = 'camera') {
    pendingKind.current = kind
    ;(source === 'camera' ? cameraRef : fileRef).current?.click()
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file
    if (!files.length) return
    const kind = pendingKind.current
    // Optimistic tiles appear INSTANTLY (before any compression / auth / upload),
    // each rendered from a local blob URL with an uploading overlay — so the grid
    // fills the moment you pick, and nothing ever looks frozen.
    const tiles: PendingTile[] = files.map(f => {
      const url = URL.createObjectURL(f)
      objectUrls.current.add(url)
      return { tempId: `t${seq.current++}`, url, kind, status: 'uploading', file: f }
    })
    setPending(prev => [...tiles, ...prev])

    let uid = userIdRef.current
    if (!uid) { const { data: { session } } = await supabase.auth.getSession(); uid = session?.user?.id ?? null; userIdRef.current = uid }
    if (!uid) { setPending(prev => prev.filter(t => !tiles.some(x => x.tempId === t.tempId))); tiles.forEach(releaseTile); return }

    await uploadPhotos(supabase, files, { userId: uid, propertyId, jobId, customerId, kind }, {
      concurrency: 3,
      // Stamp the REAL capture time from EXIF. Without this taken_at defaulted to
      // now(), so a batch uploaded at the end of a job all landed within a second
      // of each other and the Studio's "earliest before / latest after" ordering
      // quietly degraded to upload order. Nothing errored — the pairs were just
      // subtly wrong. Falls back to the file's lastModified, then to the DB default.
      perFile: async (f) => {
        const meta = await captureMetaFor(f)
        return meta.ms ? { takenAt: new Date(meta.ms).toISOString() } : {}
      },
      onUploaded: (row, i) => {
        const t = tiles[i]
        setPhotos(prev => [row, ...prev])
        setPending(prev => prev.filter(x => x.tempId !== t.tempId))
        releaseTile(t)
      },
      onError: (_f, i) => {
        const id = tiles[i].tempId
        setPending(prev => prev.map(x => x.tempId === id ? { ...x, status: 'error' } : x))
      },
    })
  }

  async function retryTile(t: PendingTile) {
    const uid = userIdRef.current
    if (!uid) return
    setPending(prev => prev.map(x => x.tempId === t.tempId ? { ...x, status: 'uploading' } : x))
    await uploadPhotos(supabase, [t.file], { userId: uid, propertyId, jobId, customerId, kind: t.kind }, {
      onUploaded: row => { setPhotos(prev => [row, ...prev]); setPending(prev => prev.filter(x => x.tempId !== t.tempId)); releaseTile(t) },
      onError: () => setPending(prev => prev.map(x => x.tempId === t.tempId ? { ...x, status: 'error' } : x)),
    })
  }

  function dismissTile(t: PendingTile) {
    setPending(prev => prev.filter(x => x.tempId !== t.tempId)); releaseTile(t)
  }

  // Delete the app way: remove now, offer Undo, commit only after the undo window
  // (matches every other destructive action — no blocking confirm dialog).
  function remove(photo: JobPhotoView) {
    const idx = photos.findIndex(p => p.id === photo.id)
    if (idx < 0) return
    // If the deleted photo is open, advance the lightbox to a neighbor (so a crew can
    // cull a batch without reopening); close only when it was the last one.
    if (lightboxId === photo.id) {
      const fIdx = filtered.findIndex(p => p.id === photo.id)
      setLightboxId(filtered[fIdx + 1]?.id ?? filtered[fIdx - 1]?.id ?? null)
    }
    setPhotos(prev => prev.filter(p => p.id !== photo.id))
    let undone = false
    toast.undo('Photo deleted.', () => { undone = true; setPhotos(prev => { const c = [...prev]; c.splice(Math.min(idx, c.length), 0, photo); return c }) })
    // The delete is deferred so Undo costs no write — but its result was never inspected,
    // so a failure meant the tile stayed gone, "Photo deleted." stood, and the photo
    // reappeared on the next load with no explanation. retag/saveCaption below both roll
    // back and surface the error; this path was the only one that didn't.
    if (typeof window !== 'undefined') window.setTimeout(async () => {
      if (undone) return
      const ok = await deletePhoto(supabase, photo)
      if (!ok) {
        setPhotos(prev => { const c = [...prev]; c.splice(Math.min(idx, c.length), 0, photo); return c })
        toast.error('Could not delete that photo — it’s still here.')
      }
    }, 7000)
  }

  async function retag(photo: JobPhotoView, kind: PhotoKind) {
    const prev = photo.kind
    setPhotos(ps => ps.map(p => p.id === photo.id ? { ...p, kind } : p))
    const ok = await updatePhoto(supabase, photo.id, { kind })
    if (!ok) { setPhotos(ps => ps.map(p => p.id === photo.id ? { ...p, kind: prev } : p)); toast.error('Could not update the tag.') }
  }

  // Real download (not just "open in a new tab"): a cross-origin storage URL ignores
  // the anchor `download` attr, so fetch the bytes and save the blob via the shared
  // downloadBlob helper. Available on every gallery, read-only or not.
  async function download(photo: JobPhotoView) {
    setDownloading(photo.id)
    try {
      const res = await fetch(photo.url)
      const blob = await res.blob()
      const ext = (photo.storage_path.split('?')[0].split('.').pop() || 'jpg').toLowerCase()
      const base = (photo.caption || PHOTO_KIND_LABELS[photo.kind] || 'photo').replace(/[^\w.-]+/g, '-').slice(0, 40)
      downloadBlob(blob, `${base}-${photo.id.slice(0, 8)}.${ext}`)
    } catch { toast.error('Could not download the photo.') }
    setDownloading(null)
  }

  async function saveCaption(photo: JobPhotoView, caption: string) {
    const clean = caption.trim() || null
    if (clean === (photo.caption ?? null)) return
    const prev = photo.caption ?? null
    setPhotos(ps => ps.map(p => p.id === photo.id ? { ...p, caption: clean } : p))
    const ok = await updatePhoto(supabase, photo.id, { caption: clean })
    if (ok) toast.success('Caption saved.')
    else { setPhotos(ps => ps.map(p => p.id === photo.id ? { ...p, caption: prev } : p)); toast.error('Could not save the caption.') }
  }

  const uploadingCount = pending.filter(t => t.status === 'uploading').length
  const busyOf = (k: PhotoKind) => pending.some(t => t.kind === k && t.status === 'uploading')
  const showFilters = photos.length > 4

  function setFilter(k: 'all' | PhotoKind) { setKindFilter(k); setShown(PAGE) }

  return (
    <div className={className}>
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
      {/* Separate node: `capture` can't be toggled per click — the attribute has to
          be on the input at the moment it's activated, so camera and library are
          two inputs sharing one handler. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onFiles} />

      {/* Capture buttons — never disabled during upload, so you can keep adding.
          Hidden in read-only mode (a pure viewer for customer-attached photos). */}
      <div className="flex items-center gap-2 flex-wrap">
        {!readOnly && <>
          <CaptureBtn label="Before" icon={Camera} busy={busyOf('before')} onClick={() => pick('before')} tone="amber" />
          <CaptureBtn label="After" icon={Camera} busy={busyOf('after')} onClick={() => pick('after')} tone="emerald" />
          {variant === 'gallery' && (
            <CaptureBtn label="Add photo" icon={ImagePlus} busy={busyOf('general')} onClick={() => pick('general', 'library')} />
          )}
        </>}
        <span className="text-[11px] ml-auto inline-flex items-center gap-1.5">
          {uploadingCount > 0
            ? <span className="text-accent-text inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Uploading {uploadingCount}…</span>
            : photos.length > 0 ? <span className="text-ink-faint">{photos.length} photo{photos.length !== 1 ? 's' : ''}</span> : null}
        </span>
      </div>

      {/* Kind filter — only when there's enough to be worth culling. */}
      {showFilters && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <FilterPill active={kindFilter === 'all'} onClick={() => setFilter('all')} className="px-2.5 py-0.5 text-[11px]">All {photos.length}</FilterPill>
          {(['before', 'after', 'general'] as PhotoKind[]).filter(k => counts[k] > 0).map(k => (
            <FilterPill key={k} active={kindFilter === k} onClick={() => setFilter(k)} className="px-2.5 py-0.5 text-[11px]">{PHOTO_KIND_LABELS[k]} {counts[k]}</FilterPill>
          ))}
        </div>
      )}

      {/* Thumbnails */}
      {loading ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2.5">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}
        </div>
      ) : photos.length === 0 && pending.length === 0 ? (
        readOnly ? null : <InlineEmpty icon={Camera}>No photos yet — snap a before &amp; after to build this property&apos;s service history.</InlineEmpty>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2.5">
            {/* Optimistic upload tiles first — visible instantly, with progress / retry. */}
            {pending.map(t => (
              <div key={t.tempId} className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.url} alt="" className={`w-full h-full object-cover ${t.status === 'error' ? 'opacity-40' : 'opacity-70'}`} />
                <span className={`absolute top-1 left-1 text-[10px] font-semibold uppercase tracking-wide rounded px-1 py-0.5 border ${KIND_BADGE[t.kind]}`}>
                  {PHOTO_KIND_LABELS[t.kind]}
                </span>
                {t.status === 'uploading' ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/25"><Loader2 className="w-5 h-5 text-white animate-spin" /></div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/45">
                    <span className="text-[10px] font-medium text-white">Upload failed</span>
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={() => retryTile(t)} className="text-[10px] font-semibold text-white bg-white/20 hover:bg-white/30 rounded px-2 py-0.5">Retry</button>
                      <button type="button" onClick={() => dismissTile(t)} className="text-white/80 hover:text-white" title="Dismiss" aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {visible.map(p => (
              <button key={p.id} type="button" onClick={() => setLightboxId(p.id)}
                className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbUrl(p.url)} alt={p.caption || PHOTO_KIND_LABELS[p.kind]} loading="lazy"
                  className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                <span className={`absolute top-1 left-1 text-[10px] font-semibold uppercase tracking-wide rounded px-1 py-0.5 border ${KIND_BADGE[p.kind]}`}>
                  {PHOTO_KIND_LABELS[p.kind]}
                </span>
              </button>
            ))}
          </div>
          {filtered.length > shown && (
            <button type="button" onClick={() => setShown(s => s + 24)} className="mt-2 w-full text-xs font-medium text-accent-text hover:underline py-1.5">
              Show {Math.min(24, filtered.length - shown)} more ({filtered.length - shown} hidden)
            </button>
          )}
        </>
      )}

      {/* Lightbox */}
      {current && (
        <div className="fixed inset-0 z-overlay bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxId(null)}>
          {/* Prev / next across the current (filtered) set — no open-close per photo. */}
          {filtered.length > 1 && (
            <>
              <button type="button" onClick={e => { e.stopPropagation(); step(-1) }} disabled={lightboxIdx === 0} aria-label="Previous photo"
                className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center disabled:opacity-30"><ChevronLeft className="w-5 h-5" /></button>
              <button type="button" onClick={e => { e.stopPropagation(); step(1) }} disabled={lightboxIdx === filtered.length - 1} aria-label="Next photo"
                className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center disabled:opacity-30"><ChevronRight className="w-5 h-5" /></button>
            </>
          )}
          <div role="dialog" aria-modal="true" aria-label="Photo viewer" className="bg-bg-secondary border border-border rounded-card max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border ${KIND_BADGE[current.kind]}`}>
                {PHOTO_KIND_LABELS[current.kind]} · {formatDate(current.taken_at)}
              </span>
              <span className="text-[11px] text-ink-faint">{lightboxIdx + 1} / {filtered.length}</span>
              <button type="button" onClick={() => setLightboxId(null)} aria-label="Close" className="h-7 w-7 rounded-lg hover:bg-black/20 flex items-center justify-center text-ink-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current.url} alt={current.caption || ''} className="w-full max-h-[55vh] object-contain bg-black" />
            <div className="p-4 space-y-3">
              {!readOnly && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-faint uppercase tracking-wide">Tag</span>
                  {(['before', 'after', 'general'] as PhotoKind[]).map(k => (
                    <button key={k} type="button" onClick={() => retag(current, k)} aria-pressed={current.kind === k}
                      className={`text-xs font-medium rounded-lg px-2.5 py-1 border transition-colors ${current.kind === k ? KIND_BADGE[k] : 'border-border text-ink-muted hover:text-ink'}`}>
                      {current.kind === k && <Check className="w-3 h-3 inline mr-1" />}{PHOTO_KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
              )}
              {!readOnly ? (
                <input
                  key={current.id}
                  defaultValue={current.caption || ''}
                  placeholder="Add a caption (optional)…"
                  onBlur={e => saveCaption(current, e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              ) : current.caption ? (
                <p className="text-sm text-ink">{current.caption}</p>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <a href={current.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent-text hover:underline">Open full size</a>
                  <button type="button" onClick={() => download(current)} disabled={downloading === current.id}
                    className="text-xs font-medium text-ink-muted hover:text-ink flex items-center gap-1 disabled:opacity-50">
                    {downloading === current.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
                  </button>
                </div>
                {!readOnly && (
                  <Button variant="danger" size="sm" onClick={() => remove(current)}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CaptureBtn({ label, icon: Icon, busy, disabled, onClick, tone }: {
  label: string; icon: typeof Camera; busy: boolean; disabled?: boolean; onClick: () => void; tone?: 'amber' | 'emerald'
}) {
  return (
    // tap-target: 44px on a phone (gloves, sun, one hand), unchanged 32px with a mouse.
    <button type="button" onClick={onClick} disabled={disabled}
      className={`tap-target h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 active:scale-95 transition-transform disabled:opacity-50 ${
        tone === 'amber' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25'
          : tone === 'emerald' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
            : 'border-border text-ink-muted hover:text-ink hover:bg-black/10'
      }`}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />} {label}
    </button>
  )
}
