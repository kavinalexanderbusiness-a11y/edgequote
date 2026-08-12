'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  CREW_MEDIA_ACCEPT, CREW_MEDIA_MAX_BYTES, deleteCrewMedia, listCrewMedia,
  playbackCaveat, signedMediaUrl, sizeLabel, uploadCrewMedia, type CrewMedia,
} from '@/lib/crewMedia'
import { AUDIENCE_COPY } from '@/lib/noteScope'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Paperclip, Video, Trash2, RotateCw, X, AlertTriangle } from 'lucide-react'

// ── Reference media the office sends to the field ────────────────────────────
// The owner's half of crew instructions: attach the photo of the gate, the clip
// showing which bed gets mulch. It sits directly under the note it illustrates,
// because "use the east gate" and a picture of the east gate are one thought.
//
// ⛔ Deliberately NOT an asset manager. No folders, no tags, no library, no
// reuse across visits. A file belongs to ONE visit, and the way you attach one
// is to pick it. Everything a media library would add is a thing the owner then
// has to maintain.
//
// ⭐ VISIBILITY IS STATED, NOT IMPLIED. The header says who sees this, in the
// same words every other scoped field uses (lib/noteScope AUDIENCE_COPY), so an
// owner never has to infer an audience from a control's position on a form.

interface Pending {
  key: string
  file: File
  state: 'uploading' | 'failed'
  error?: string
}

export function JobReferenceMedia({ jobId }: { jobId: string | null }) {
  const supabase = createClient()
  // Resolved here rather than threaded through the form: this id is BOTH the
  // catalogue's tenant column and the first segment of every storage path, so
  // the one place that writes files should be the one place that answers "whose
  // are they". A prop could be passed the wrong value; a session cannot.
  const [userId, setUserId] = useState<string | null>(null)
  const [media, setMedia] = useState<CrewMedia[]>([])
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Pending[]>([])
  const [preview, setPreview] = useState<{ media: CrewMedia; url: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (alive.current) setUserId(session?.user?.id ?? null)
    })()
  }, [supabase])

  const load = useCallback(async () => {
    if (!jobId || !userId) { if (!jobId) setLoading(false); return }
    const res = await listCrewMedia(supabase, userId, jobId)
    if (!alive.current) return
    // An empty list and a failed read are different facts. "No instructions
    // attached" is a statement about the visit; "couldn't load" is not, and an
    // owner must not re-upload a file that is already there because a fetch
    // blipped.
    setLoadError(res.error)
    if (!res.error) setMedia(res.media)
    setLoading(false)
  }, [supabase, userId, jobId])

  useEffect(() => { void load() }, [load])

  async function send(key: string, file: File) {
    if (!jobId || !userId) return
    setPending(p => p.map(x => x.key === key ? { ...x, state: 'uploading', error: undefined } : x))
    const res = await uploadCrewMedia(supabase, { userId, jobId, file, uploadedBy: userId })
    if (!alive.current) return
    if (res.error || !res.media) {
      // ⛔ The file is KEPT in hand and the tile turns into a Retry. A 40 MB
      // upload that died at 90% must never be silently discarded — that is the
      // whole afternoon the owner spent filming it.
      setPending(p => p.map(x => x.key === key ? { ...x, state: 'failed', error: res.error } : x))
      return
    }
    setMedia(m => [...m, res.media!])
    setPending(p => p.filter(x => x.key !== key))
    const caveat = playbackCaveat(file.type)
    if (caveat) toast.info(caveat)
  }

  function pick(files: FileList | null) {
    if (!files?.length || !jobId || !userId) return
    for (const file of Array.from(files)) {
      if (file.size > CREW_MEDIA_MAX_BYTES) {
        // Refused before a byte leaves the machine — the ceiling is also on the
        // bucket, but telling someone after a four-minute upload is not a limit,
        // it is a punishment.
        toast.error(`“${file.name}” is ${sizeLabel(file.size)} — the limit is ${sizeLabel(CREW_MEDIA_MAX_BYTES)}.`)
        continue
      }
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setPending(p => [...p, { key, file, state: 'uploading' }])
      void send(key, file)
    }
  }

  async function open(m: CrewMedia) {
    const url = await signedMediaUrl(supabase, m.storage_path)
    if (!alive.current) return
    if (!url) { toast.error('Couldn’t open that file — try again.'); return }
    setPreview({ media: m, url })
  }

  async function remove(m: CrewMedia) {
    const res = await deleteCrewMedia(supabase, m)
    if (!alive.current) return
    if (res.error) { toast.error(res.error); return }
    setMedia(list => list.filter(x => x.id !== m.id))
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-2">
      <div className="flex items-start gap-1.5">
        <Paperclip className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sky-400" aria-hidden />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Reference photos &amp; video</p>
          <p className="text-[11px] text-ink-muted">{AUDIENCE_COPY.crew.help}</p>
        </div>
      </div>

      {!jobId ? (
        // Honest about the ordering constraint rather than showing a control
        // that would fail: a file has to belong to a visit, and the visit does
        // not exist yet.
        <p className="text-[11px] text-ink-faint">Save the visit first, then reopen it to attach photos or video.</p>
      ) : (
        <>
          <input ref={inputRef} type="file" accept={CREW_MEDIA_ACCEPT} multiple hidden
            onChange={e => { pick(e.target.files); e.target.value = '' }} />

          {loadError && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
              <p className="text-[11px] text-amber-200">
                Couldn’t load what’s already attached — anything you add now would sit alongside files you can’t see.
              </p>
              <button type="button" onClick={() => void load()}
                className="tap-target mt-1.5 h-9 px-2.5 rounded-md border border-amber-500/40 text-[11px] font-medium text-amber-100 inline-flex items-center gap-1.5">
                <RotateCw className="w-3 h-3" aria-hidden /> Try again
              </button>
            </div>
          )}

          {!loading && !loadError && media.length === 0 && pending.length === 0 && (
            <p className="text-[11px] text-ink-faint">Nothing attached yet.</p>
          )}

          <div className="flex items-center gap-1.5 flex-wrap">
            {media.map(m => (
              <span key={m.id} className="relative group">
                <button type="button" onClick={() => void open(m)}
                  title={m.caption || (m.kind === 'video' ? 'Video' : 'Photo')}
                  className="tap-target h-12 w-12 rounded-lg border border-border bg-bg-tertiary flex items-center justify-center text-ink-muted">
                  {m.kind === 'video'
                    ? <Video className="w-4 h-4" aria-hidden />
                    : <Paperclip className="w-4 h-4" aria-hidden />}
                </button>
                <button type="button" onClick={() => void remove(m)} aria-label="Remove attachment"
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-tertiary border border-border flex items-center justify-center text-ink-muted hover:text-red-400">
                  <Trash2 className="w-3 h-3" aria-hidden />
                </button>
              </span>
            ))}

            {pending.map(p => (
              <span key={p.key} className="relative">
                <span className={cn('h-12 w-12 rounded-lg border flex items-center justify-center text-[10px] font-medium',
                  p.state === 'failed' ? 'border-red-500/60 text-red-300' : 'border-border text-ink-faint animate-pulse')}>
                  {p.state === 'failed' ? 'Failed' : '…'}
                </span>
                {p.state === 'failed' && (
                  <>
                    <button type="button" onClick={() => void send(p.key, p.file)} aria-label="Retry upload"
                      className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-red-200">
                      <RotateCw className="w-4 h-4" aria-hidden />
                    </button>
                    <button type="button" onClick={() => setPending(x => x.filter(y => y.key !== p.key))}
                      aria-label="Discard"
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-tertiary border border-border flex items-center justify-center text-ink-muted">
                      <X className="w-3 h-3" aria-hidden />
                    </button>
                  </>
                )}
              </span>
            ))}

            <button type="button" onClick={() => inputRef.current?.click()}
              className="tap-target h-12 px-3 rounded-lg border border-dashed border-border text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
              + Add
            </button>
          </div>

          {pending.some(p => p.state === 'failed') && (
            <p className="text-[11px] text-red-400 flex items-start gap-1.5" role="status">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              <span>
                {pending.filter(p => p.state === 'failed').length === 1 ? 'A file didn’t upload' : 'Some files didn’t upload'} —
                {' '}tap to retry. Your note is saved separately and is unaffected.
              </span>
            </p>
          )}

          <p className="text-[11px] text-ink-faint">
            MP4 plays on every phone. Up to {sizeLabel(CREW_MEDIA_MAX_BYTES)} per file.
          </p>
        </>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" role="dialog" aria-modal="true"
          onClick={() => setPreview(null)}>
          <div onClick={e => e.stopPropagation()} className="max-w-full max-h-full">
            {preview.media.kind === 'video'
              ? <video src={preview.url} controls playsInline className="block max-w-full max-h-[80vh] bg-black" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img src={preview.url} alt={preview.media.caption || 'Reference'} className="block max-w-full max-h-[80vh] object-contain" />}
          </div>
          <button type="button" onClick={() => setPreview(null)} aria-label="Close"
            className="tap-target absolute top-3 right-3 w-11 h-11 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-white">
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
