'use client'

import { useEffect, useRef, useState } from 'react'
import { downscale } from '@/lib/photos'
import { newPhotoToken } from '@/lib/field/photoIntent'
import { cn } from '@/lib/utils'
import { Camera, RotateCw, X } from 'lucide-react'

// ── Job photos, from the driveway ────────────────────────────────────────────
// One button on the stop card: it opens the phone camera, shrinks the shot
// client-side (the same downscale the owner's uploader runs — pure canvas code,
// no table access), and POSTs it to /api/crew/photos, which verifies the visit
// belongs to this worker's crew and files the photo under the OWNER's identity.
// The client sends a job id, a kind and bytes — nothing else, because the
// server derives everything else from the verified job row.
//
// `kind` is picked by where the visit is in its life, not by a control: before
// you start, photos are 'before'; once you're on the clock (or done), they're
// 'after'. That is the exact meaning the before/after studio assigns the words.
//
// Honest states per shot, because this runs at the edge of coverage:
//   uploading → spinner tile · uploaded → thumbnail stays · failed → red tile
//   with Retry (the file is still in hand, nothing pretends). A dead-zone upload
//   FAILS VISIBLY rather than queueing silently — bytes are not an intent, and a
//   photo the app promised to send later is a promise it cannot keep once the
//   tab is evicted.
//
// ⭐ WHAT RETRY IS NOW SAFE (Field Reliability V1): each shot carries an upload
// token minted when the camera returns it, and the server derives the object's
// storage path from that token — so a retry after a lost response addresses the
// SAME object and is answered with the row that already exists. Before this, a
// retry in a dead zone filed the customer's photo twice.

interface Shot {
  key: string
  file: File
  previewUrl: string
  state: 'uploading' | 'done' | 'failed'
  error?: string
  /** ⭐ Minted ONCE when the camera hands the file over, and reused by every
   *  retry of this shot. The server derives the object's storage path from it,
   *  so a retry after a lost response addresses the SAME object and is answered
   *  with the row that already exists instead of filing a second copy.
   *  ⛔ Never regenerated in `upload()` — see lib/field/photoIntent. */
  token: string
  /** Single-flight. Two overlapping attempts on one shot are the only way the
   *  server's row lookup can be raced by this client, and an impatient worker
   *  double-tapping Retry on a slow connection is exactly how that happens. */
  inFlight?: boolean
}

export function CrewStopPhotos({ jobId, status, onOutstandingChange }: {
  jobId: string
  status: 'scheduled' | 'in_progress' | 'completed'
  /** How many shots have NOT landed on the server (uploading or failed). The
   *  completion sheet reads this so its confirmation can say a note saved while
   *  a photo is still outstanding, instead of one cheerful "Saved" that quietly
   *  covers evidence this component knows didn't make it. */
  onOutstandingChange?: (n: number) => void
}) {
  const [shots, setShots] = useState<Shot[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const kind = status === 'scheduled' ? 'before' : 'after'

  // Object URLs leak unless revoked — release them when the card unmounts.
  useEffect(() => () => { shots.forEach(s => URL.revokeObjectURL(s.previewUrl)) }, [shots])

  const outstanding = shots.filter(s => s.state !== 'done').length
  useEffect(() => { onOutstandingChange?.(outstanding) }, [outstanding, onOutstandingChange])

  async function upload(key: string, file: File, token: string) {
    // Single-flight per shot. Without it, a double-tapped Retry sends two
    // requests that can both miss the server's row lookup before either inserts
    // — the one race the deterministic path cannot settle on its own.
    let already = false
    setShots(prev => prev.map(s => {
      if (s.key !== key) return s
      if (s.inFlight) { already = true; return s }
      return { ...s, state: 'uploading', error: undefined, inFlight: true }
    }))
    if (already) return
    try {
      const blob = await downscale(file)
      const body = new FormData()
      body.set('jobId', jobId)
      body.set('kind', kind)
      // The retry identity travels with every attempt, unchanged.
      body.set('uploadToken', token)
      body.set('file', new File([blob], file.name || 'photo.jpg', { type: blob.type || file.type || 'image/jpeg' }))
      const res = await fetch('/api/crew/photos', { method: 'POST', body })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) throw new Error(d.error || 'The photo didn’t upload.')
      // ⭐ `done` means the SERVER holds the row — including when it answered
      // `deduped`, which is a previous attempt of this same shot having landed.
      // That is a success, not a duplicate: the evidence is filed exactly once.
      setShots(prev => prev.map(s => s.key === key ? { ...s, state: 'done', inFlight: false } : s))
    } catch (e) {
      // The shot is kept — the thumbnail turns into a Retry, and the worker can
      // send it again from the truck. Nothing here ever claims a photo saved
      // when the server didn't say so.
      setShots(prev => prev.map(s => s.key === key
        ? { ...s, state: 'failed', inFlight: false, error: e instanceof Error ? e.message : 'Upload failed.' } : s))
    }
  }

  function onPick(files: FileList | null) {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // ⭐ Minted HERE — at the moment the shot exists — and never again. Every
      // retry below reuses it, which is the whole idempotency guarantee.
      const token = newPhotoToken()
      setShots(prev => [...prev, { key, file, token, previewUrl: URL.createObjectURL(file), state: 'uploading' }])
      void upload(key, file, token)
    }
  }

  return (
    <div className="mt-2">
      <input
        ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden
        onChange={e => { onPick(e.target.files); e.target.value = '' }}
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="tap-target h-10 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center justify-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
        >
          <Camera className="w-3.5 h-3.5" aria-hidden /> {kind === 'before' ? 'Before photo' : 'After photo'}
        </button>
        {shots.map(s => (
          <span key={s.key} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.previewUrl} alt=""
              className={cn('h-10 w-10 rounded-lg object-cover border',
                s.state === 'done' ? 'border-emerald-500/50'
                  : s.state === 'failed' ? 'border-red-500/60 opacity-60'
                  : 'border-border opacity-50 animate-pulse')}
            />
            {s.state === 'failed' && (
              <button
                type="button"
                onClick={() => upload(s.key, s.file, s.token)}
                aria-label="Retry upload"
                className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-red-300"
              >
                <RotateCw className="w-4 h-4" aria-hidden />
              </button>
            )}
            {s.state === 'failed' && (
              <button
                type="button"
                onClick={() => setShots(prev => prev.filter(x => x.key !== s.key))}
                aria-label="Discard photo"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-tertiary border border-border flex items-center justify-center text-ink-muted"
              >
                <X className="w-3 h-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
      </div>
      {shots.some(s => s.state === 'failed') && (
        <p className="mt-1 text-[11px] text-red-400" role="status">
          A photo didn’t upload — tap it to retry when you have signal.
        </p>
      )}
    </div>
  )
}
