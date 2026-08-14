'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { ImageIcon, Video, ChevronDown, RotateCw, Download, X } from 'lucide-react'

// ── The work instructions, on the phone ──────────────────────────────────────
// The reference photos and video the office attached to THIS visit: what the
// gate looks like, how deep the mulch goes, which shrub to leave alone.
//
// ⭐ IT NEVER LOADS UNTIL IT IS OPENED. The day view already knows the COUNTS
// (one summary request for the whole day, no URLs in it), so the card can offer
// "2 photos · 1 video" honestly without a request per stop. Signed URLs are
// minted only when the worker taps — because a signature minted at 7am is dead
// by the eighth stop, and a worker meeting a broken video has no way to know it
// is the clock rather than the app.
//
// ⛔ NOTHING HERE IS CUSTOMER-FACING. This is crew-audience material in a
// private bucket, and it stays that way after the visit is completed: finishing
// the work does not turn the office's gate video into proof of work. Proof of
// work is jobs.completion_summary + job_photos, and it is a separate surface on
// purpose (lib/noteScope).
//
// Honest states, because this runs at the edge of coverage:
//   loading → a line that says so
//   error   → what failed, and a Retry that re-signs
//   empty   → "Nothing attached", which is a fact about the visit
//   expired → a signature outlives its five minutes while the sheet is open;
//             the player reports it and Retry re-signs rather than pretending.

interface MediaItem {
  id: string
  kind: 'photo' | 'video'
  mime: string | null
  size_bytes: number | null
  caption: string | null
  created_at: string
  url: string | null
}

type Load =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; media: MediaItem[]; at: number }
  | { kind: 'error'; message: string }

export function CrewStopMedia({ jobId, photos, videos }: {
  jobId: string
  photos: number
  videos: number
}) {
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ kind: 'idle' })
  const [lightbox, setLightbox] = useState<MediaItem | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const total = photos + videos

  const fetchMedia = useCallback(async () => {
    setLoad({ kind: 'loading' })
    try {
      const res = await fetch(`/api/crew/media?jobId=${encodeURIComponent(jobId)}`)
      const d = await res.json().catch(() => ({}))
      if (!alive.current) return
      if (!res.ok || !d.ok) throw new Error(d.error || 'Couldn’t load the work instructions.')
      setLoad({ kind: 'ok', media: (d.media || []) as MediaItem[], at: Date.now() })
    } catch (e) {
      if (!alive.current) return
      setLoad({ kind: 'error', message: e instanceof Error ? e.message : 'Couldn’t load the work instructions.' })
    }
  }, [jobId])

  // Nothing attached → no affordance at all. An empty disclosure that always
  // says "nothing here" is a dead end on every card of the day.
  if (total === 0) return null

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && load.kind === 'idle') void fetchMedia()
  }

  return (
    // data-scoped-notes marks this subtree for scripts/notes-cdp.mjs, so a
    // mobile overflow finding can be attributed to THIS component rather than to
    // whatever else happens to share the worker's screen.
    <div data-scoped-notes className="mt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="tap-target w-full min-h-10 px-3 py-2 rounded-lg border border-sky-500/30 bg-sky-500/10 flex items-center gap-2 text-left"
      >
        <ImageIcon className="w-3.5 h-3.5 shrink-0 text-sky-400" aria-hidden />
        <span className="text-xs font-semibold text-sky-200">Work instructions</span>
        <span className="text-[11px] text-sky-300/70 truncate">
          {photos > 0 && `${photos} photo${photos === 1 ? '' : 's'}`}
          {photos > 0 && videos > 0 && ' · '}
          {videos > 0 && `${videos} video${videos === 1 ? '' : 's'}`}
        </span>
        <ChevronDown className={cn('w-4 h-4 ml-auto shrink-0 text-sky-400/70 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {load.kind === 'loading' && (
            <p className="text-[11px] text-ink-muted" role="status">Loading…</p>
          )}

          {load.kind === 'error' && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5">
              <p className="text-[11px] text-red-300">{load.message}</p>
              <button type="button" onClick={() => void fetchMedia()}
                className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-red-500/40 text-[11px] font-medium text-red-200 inline-flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" aria-hidden /> Try again
              </button>
            </div>
          )}

          {load.kind === 'ok' && load.media.length === 0 && (
            <p className="text-[11px] text-ink-muted">Nothing attached to this visit.</p>
          )}

          {load.kind === 'ok' && load.media.map(m => (
            <MediaTile key={m.id} item={m} onExpand={setLightbox} onRetry={() => void fetchMedia()} />
          ))}
        </div>
      )}

      {lightbox && <Lightbox item={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

// ── One attachment ───────────────────────────────────────────────────────────
// ⚠️ PLAYBACK IS NOT PROMISED, IT IS REPORTED. An iPhone records .mov, usually
// HEVC; Chrome and Firefox on Android and Windows often cannot decode it, and
// what they render is a black rectangle with a spinner — which reads to a worker
// as "the app is broken". V1 does not transcode (that is a service, not a
// feature). So a decode failure is caught and SAID, with a download that still
// works, instead of a black box.
function MediaTile({ item, onExpand, onRetry }: {
  item: MediaItem
  onExpand: (m: MediaItem) => void
  onRetry: () => void
}) {
  const [failed, setFailed] = useState(false)

  // The URL didn't sign at all — the catalogue knows about a file the storage
  // layer wouldn't hand over. Never render this as "no instructions".
  if (!item.url) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
        <p className="text-[11px] text-amber-200">
          {item.caption?.trim() || (item.kind === 'video' ? 'A video' : 'A photo')} is attached but wouldn’t open.
        </p>
        <button type="button" onClick={onRetry}
          className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-amber-500/40 text-[11px] font-medium text-amber-100 inline-flex items-center gap-1.5">
          <RotateCw className="w-3 h-3" aria-hidden /> Try again
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
      {item.kind === 'video' ? (
        failed ? (
          <div className="p-2.5">
            <p className="text-[11px] text-amber-200 flex items-start gap-1.5">
              <Video className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              <span>This video won’t play on this phone{item.mime === 'video/quicktime' ? ' (it’s a MOV)' : ''}. Download it to watch, or ask the office to send an MP4.</span>
            </p>
            <a href={item.url} download
              className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-border text-[11px] font-medium text-ink-muted inline-flex items-center gap-1.5">
              <Download className="w-3 h-3" aria-hidden /> Download
            </a>
          </div>
        ) : (
          // `w-full` + `max-w-full` + a block display keep a 4K clip inside a
          // 375px card instead of pushing the whole page sideways. playsInline
          // stops iOS hijacking the screen into its own fullscreen player, so
          // "back to the job" is still one tap.
          <video
            src={item.url}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
            className="block w-full max-w-full max-h-64 bg-black"
          />
        )
      ) : (
        failed ? (
          <div className="p-2.5">
            <p className="text-[11px] text-amber-200">
              This photo won’t display on this phone{(item.mime === 'image/heic' || item.mime === 'image/heif') ? ' (it’s a HEIC)' : ''}.
            </p>
            <a href={item.url} download
              className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-border text-[11px] font-medium text-ink-muted inline-flex items-center gap-1.5">
              <Download className="w-3 h-3" aria-hidden /> Download
            </a>
          </div>
        ) : (
          <button type="button" onClick={() => onExpand(item)} className="block w-full" aria-label="Enlarge photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt={item.caption?.trim() || 'Reference photo'}
              onError={() => setFailed(true)}
              className="block w-full max-w-full max-h-64 object-cover bg-black" />
          </button>
        )
      )}
      {item.caption?.trim() && (
        <p className="px-2.5 py-2 text-[11px] text-ink whitespace-pre-wrap break-words">{item.caption.trim()}</p>
      )}
    </div>
  )
}

/** Tap a reference photo to see it properly — a gate latch is not legible in a
 *  64px-tall strip. Full-screen, one tap out, no navigation away from the job. */
function Lightbox({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" role="dialog" aria-modal="true"
      onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.url || ''} alt={item.caption?.trim() || 'Reference photo'}
        className="max-w-full max-h-full object-contain" onClick={e => e.stopPropagation()} />
      <button type="button" onClick={onClose} aria-label="Close"
        className="tap-target absolute top-3 right-3 w-11 h-11 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-white">
        <X className="w-5 h-5" aria-hidden />
      </button>
    </div>
  )
}
