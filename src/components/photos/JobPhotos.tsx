'use client'

import { confirm as confirmDialog } from '@/lib/confirm'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PhotoKind, PHOTO_KIND_LABELS } from '@/types'
import { JobPhotoView, listPhotos, uploadPhoto, deletePhoto, updatePhoto } from '@/lib/photos'
import { captureStampFor } from '@/lib/exif'
import { visualHash, findPhotoMatch } from '@/lib/dedup'
import { toast } from '@/lib/toast'
import { formatDate } from '@/lib/utils'
import { Camera, ImagePlus, Trash2, X, Loader2, Check } from 'lucide-react'

interface Props {
  propertyId: string | null
  jobId?: string | null
  customerId?: string | null
  // 'visit' = capture surface on a job (Before/After buttons up front, Day Ops).
  // 'gallery' = a property's full visual history (also offers a plain Photo).
  variant?: 'visit' | 'gallery'
  className?: string
}

const KIND_BADGE: Record<PhotoKind, string> = {
  before: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  after: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  general: 'bg-bg-tertiary text-ink-muted border-border',
}

export function JobPhotos({ propertyId, jobId, customerId, variant = 'visit', className }: Props) {
  const supabase = createClient()
  const [photos, setPhotos] = useState<JobPhotoView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKind, setBusyKind] = useState<PhotoKind | null>(null)
  const [lightbox, setLightbox] = useState<JobPhotoView | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pendingKind = useRef<PhotoKind>('after')

  useEffect(() => {
    let alive = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (alive) setLoading(false); return }
      const rows = await listPhotos(supabase, user.id, { jobId, propertyId })
      if (alive) { setPhotos(rows); setLoading(false) }
    }
    load()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, propertyId])

  function pick(kind: PhotoKind) {
    pendingKind.current = kind
    fileRef.current?.click()
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file
    if (!files.length) return
    const kind = pendingKind.current
    setBusyKind(kind)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setBusyKind(null); return }
    const added: JobPhotoView[] = []
    let skippedDups = 0
    for (const file of files) {
      // Same enrichment as the bulk uploader (ONE dedup + EXIF engine): stamp the
      // real capture time and store the visual hash; skip an already-uploaded shot.
      const [stamp, hash] = await Promise.all([captureStampFor(file), visualHash(file)])
      const match = findPhotoMatch(photos, { contentHash: hash, takenAtMs: stamp.ms, exactTime: stamp.exact })
      if (match && match.confident) { skippedDups++; continue }
      const row = await uploadPhoto(supabase, {
        userId: user.id, file, propertyId, jobId, customerId, kind,
        takenAt: stamp.exact ? new Date(stamp.ms).toISOString() : null,
        contentHash: hash,
      })
      if (row) added.push(row)
    }
    if (added.length) setPhotos(prev => [...added, ...prev])
    if (skippedDups) toast(`${skippedDups} photo${skippedDups !== 1 ? 's were' : ' was'} already uploaded — skipped`, { tone: 'info' })
    setBusyKind(null)
  }

  async function remove(photo: JobPhotoView) {
    if (!confirm('Delete this photo? This cannot be undone.')) return
    setPhotos(prev => prev.filter(p => p.id !== photo.id))
    setLightbox(null)
    await deletePhoto(supabase, photo)
  }

  async function retag(photo: JobPhotoView, kind: PhotoKind) {
    setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, kind } : p))
    setLightbox(prev => prev && prev.id === photo.id ? { ...prev, kind } : prev)
    await updatePhoto(supabase, photo.id, { kind })
  }

  async function saveCaption(photo: JobPhotoView, caption: string) {
    const clean = caption.trim() || null
    setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, caption: clean } : p))
    setLightbox(prev => prev && prev.id === photo.id ? { ...prev, caption: clean } : prev)
    await updatePhoto(supabase, photo.id, { caption: clean })
  }

  const uploading = busyKind !== null

  return (
    <div className={className}>
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />

      {/* Capture buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <CaptureBtn label="Before" icon={Camera} busy={busyKind === 'before'} disabled={uploading} onClick={() => pick('before')} tone="amber" />
        <CaptureBtn label="After" icon={Camera} busy={busyKind === 'after'} disabled={uploading} onClick={() => pick('after')} tone="emerald" />
        {variant === 'gallery' && (
          <CaptureBtn label="Photo" icon={ImagePlus} busy={busyKind === 'general'} disabled={uploading} onClick={() => pick('general')} />
        )}
        {photos.length > 0 && <span className="text-[11px] text-ink-faint ml-auto">{photos.length} photo{photos.length !== 1 ? 's' : ''}</span>}
      </div>

      {/* Thumbnails */}
      {loading ? (
        <p className="text-xs text-ink-faint mt-2">Loading photos…</p>
      ) : photos.length === 0 ? (
        <p className="text-xs text-ink-faint mt-2">No photos yet — snap a before &amp; after to build this property&apos;s service history.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2.5">
          {photos.map(p => (
            <button key={p.id} onClick={() => setLightbox(p)}
              className="relative aspect-square rounded-lg overflow-hidden border border-border bg-bg-tertiary group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={p.caption || PHOTO_KIND_LABELS[p.kind]} loading="lazy"
                className="w-full h-full object-cover transition-transform group-hover:scale-105" />
              <span className={`absolute top-1 left-1 text-[9px] font-semibold uppercase tracking-wide rounded px-1 py-0.5 border ${KIND_BADGE[p.kind]}`}>
                {PHOTO_KIND_LABELS[p.kind]}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <div className="bg-bg-secondary border border-border rounded-card max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border ${KIND_BADGE[lightbox.kind]}`}>
                {PHOTO_KIND_LABELS[lightbox.kind]} · {formatDate(lightbox.taken_at)}
              </span>
              <button onClick={() => setLightbox(null)} className="h-7 w-7 rounded-lg hover:bg-black/20 flex items-center justify-center text-ink-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.url} alt={lightbox.caption || ''} className="w-full max-h-[55vh] object-contain bg-black" />
            <div className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-faint uppercase tracking-wide">Tag</span>
                {(['before', 'after', 'general'] as PhotoKind[]).map(k => (
                  <button key={k} onClick={() => retag(lightbox, k)}
                    className={`text-xs font-medium rounded-lg px-2.5 py-1 border transition-colors ${lightbox.kind === k ? KIND_BADGE[k] : 'border-border text-ink-muted hover:text-ink'}`}>
                    {lightbox.kind === k && <Check className="w-3 h-3 inline mr-1" />}{PHOTO_KIND_LABELS[k]}
                  </button>
                ))}
              </div>
              <input
                defaultValue={lightbox.caption || ''}
                placeholder="Add a caption (optional)…"
                onBlur={e => { if ((e.target.value.trim() || null) !== lightbox.caption) saveCaption(lightbox, e.target.value) }}
                className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              <div className="flex items-center justify-between">
                <a href={lightbox.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">Open full size</a>
                <button onClick={() => remove(lightbox)} className="text-xs font-medium text-red-400 flex items-center gap-1 hover:text-red-300">
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CaptureBtn({ label, icon: Icon, busy, disabled, onClick, tone }: {
  label: string; icon: typeof Camera; busy: boolean; disabled: boolean; onClick: () => void; tone?: 'amber' | 'emerald'
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 active:scale-95 transition-transform disabled:opacity-50 ${
        tone === 'amber' ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25'
          : tone === 'emerald' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
            : 'border-border text-ink-muted hover:text-ink hover:bg-black/10'
      }`}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />} {label}
    </button>
  )
}
