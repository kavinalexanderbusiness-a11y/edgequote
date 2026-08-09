'use client'

import { useEffect, useRef, useState } from 'react'
import { downscale } from '@/lib/photos'
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
//   with Retry (the file is still in hand, nothing pretends). Online-only like
//   every crew write in V1 — a dead-zone upload FAILS VISIBLY rather than
//   queueing silently.

interface Shot {
  key: string
  file: File
  previewUrl: string
  state: 'uploading' | 'done' | 'failed'
  error?: string
}

export function CrewStopPhotos({ jobId, status }: {
  jobId: string
  status: 'scheduled' | 'in_progress' | 'completed'
}) {
  const [shots, setShots] = useState<Shot[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const kind = status === 'scheduled' ? 'before' : 'after'

  // Object URLs leak unless revoked — release them when the card unmounts.
  useEffect(() => () => { shots.forEach(s => URL.revokeObjectURL(s.previewUrl)) }, [shots])

  async function upload(key: string, file: File) {
    setShots(prev => prev.map(s => s.key === key ? { ...s, state: 'uploading', error: undefined } : s))
    try {
      const blob = await downscale(file)
      const body = new FormData()
      body.set('jobId', jobId)
      body.set('kind', kind)
      body.set('file', new File([blob], file.name || 'photo.jpg', { type: blob.type || file.type || 'image/jpeg' }))
      const res = await fetch('/api/crew/photos', { method: 'POST', body })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) throw new Error(d.error || 'The photo didn’t upload.')
      setShots(prev => prev.map(s => s.key === key ? { ...s, state: 'done' } : s))
    } catch (e) {
      // The shot is kept — the thumbnail turns into a Retry, and the worker can
      // send it again from the truck. Nothing here ever claims a photo saved
      // when the server didn't say so.
      setShots(prev => prev.map(s => s.key === key
        ? { ...s, state: 'failed', error: e instanceof Error ? e.message : 'Upload failed.' } : s))
    }
  }

  function onPick(files: FileList | null) {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setShots(prev => [...prev, { key, file, previewUrl: URL.createObjectURL(file), state: 'uploading' }])
      void upload(key, file)
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
                onClick={() => upload(s.key, s.file)}
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
