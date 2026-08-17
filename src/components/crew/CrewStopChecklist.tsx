'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { downscale } from '@/lib/photos'
import { cn } from '@/lib/utils'
import {
  loadCrewJobForms, crewSaveFormResponse, uploadCrewFormPhoto,
  type CrewJobForm, type CrewFormResponse,
} from '@/lib/crewForms'
import type { JobFormField, JobFormValue } from '@/lib/jobForms'
import { ClipboardCheck, ChevronDown, Camera, RotateCw, Check, Lock } from 'lucide-react'

// ── The visit's checklist, on the worker's phone ─────────────────────────────
// Collapsed until tapped — the card face carries only the counts crew_day
// already shipped ("3 of 7 · 2 required open"), the same load-on-tap contract
// as reference media. Opening asks crew_job_forms, which re-proves this visit
// is this worker's and mints the default form if one should exist.
//
// EVERY control saves on commit (tap / choice / blur) and then re-reads the
// form from the server — no optimistic paint, exactly like the rest of the
// crew tree. A failed save says so next to the field it failed on and keeps
// what was typed; nothing here ever pretends.
//
// Required items are marked with a quiet amber dot, not red shouting: the
// worker sees what is still open, and Finish tells them precisely if they try
// to complete around it (the server's list, not this component's opinion).
//
// A completed visit's checklist is FROZEN — the database refuses crew edits —
// so this renders read-only with the lock stated, rather than offering
// controls that would fail.

interface FieldSaveState { state: 'idle' | 'saving' | 'failed'; error?: string }

interface PendingShot { key: string; fieldId: string; previewUrl: string; file: File; state: 'uploading' | 'failed'; error?: string }

export function CrewStopChecklist({ jobId, summary, jobStatus, blockedFieldIds, onChanged }: {
  jobId: string
  /** crew_day's counts-only summary — null/undefined when the visit carries no
   *  checklist (then this renders NOTHING; no empty-state noise on the card). */
  summary: { forms: number; items: number; done: number; required: number; required_done: number; waived: boolean } | null | undefined
  jobStatus: 'scheduled' | 'in_progress' | 'completed'
  /** Field ids the completion gate just refused on — opens the section and
   *  marks exactly those items ("Before completing: …" lives on the card). */
  blockedFieldIds?: string[]
  /** Fired after any successful save so the parent can refresh day counts. */
  onChanged?: () => void
}) {
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [forms, setForms] = useState<CrewJobForm[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saves, setSaves] = useState<Record<string, FieldSaveState>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [shots, setShots] = useState<PendingShot[]>([])
  const pickingField = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => () => { shots.forEach(s => URL.revokeObjectURL(s.previewUrl)) }, [shots])

  const load = useCallback(async () => {
    const res = await loadCrewJobForms(supabase, jobId)
    if (!alive.current) return
    if (res.kind === 'ok') { setForms(res.forms); setLoadError(null) }
    else if (res.kind === 'notYours') { setForms([]); setLoadError(null) }
    else setLoadError('Couldn’t load the checklist — check your signal and try again.')
  }, [supabase, jobId])

  // The gate refused a Finish → show the worker exactly what is open, without
  // another tap. Opening also triggers the first load.
  const blocked = (blockedFieldIds?.length ?? 0) > 0
  useEffect(() => { if (blocked) setOpen(true) }, [blocked])
  useEffect(() => { if (open && forms === null && !loadError) void load() }, [open, forms, loadError, load])

  // Render NOTHING when the visit has no checklist and nothing is blocked —
  // the card must not grow a section that says "no sections".
  const counts = summary ?? null
  if (!counts && !blocked && forms === null) return null

  const required = counts ? counts.required : 0
  const requiredOpen = counts ? Math.max(0, counts.required - counts.required_done) : 0
  const summaryLine = counts
    ? `${counts.done} of ${counts.items} done${required ? ` · ${requiredOpen ? `${requiredOpen} required open` : 'required complete'}` : ''}${counts.waived ? ' · waived' : ''}`
    : null

  async function save(form: CrewJobForm, field: JobFormField, value: JobFormValue) {
    const key = `${form.id}:${field.id}`
    setSaves(prev => ({ ...prev, [key]: { state: 'saving' } }))
    const res = await crewSaveFormResponse(supabase, form.id, field.id, value)
    if (!alive.current) return
    if (!res.ok) {
      setSaves(prev => ({ ...prev, [key]: { state: 'failed', error: res.error } }))
      return
    }
    setSaves(prev => ({ ...prev, [key]: { state: 'idle' } }))
    await load()          // truth from the server, never a local echo
    onChanged?.()
  }

  function onPickPhotos(files: FileList | null) {
    const fieldId = pickingField.current
    if (!files?.length || !fieldId) return
    const form = forms?.find(f => f.fields.some(x => x.id === fieldId))
    if (!form) return
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setShots(prev => [...prev, { key, fieldId, previewUrl: URL.createObjectURL(file), file, state: 'uploading' }])
      void uploadShot(key, form, fieldId, file)
    }
  }

  async function uploadShot(key: string, form: CrewJobForm, fieldId: string, file: File) {
    setShots(prev => prev.map(s => s.key === key ? { ...s, state: 'uploading', error: undefined } : s))
    try {
      const blob = await downscale(file)
      const field = form.fields.find(f => f.id === fieldId)
      const res = await uploadCrewFormPhoto(
        jobId, form.id, fieldId,
        new File([blob], file.name || 'photo.jpg', { type: blob.type || file.type || 'image/jpeg' }),
        field?.photo_kind ?? 'general',
      )
      if (!alive.current) return
      if (!res.ok) throw new Error(res.error)
      // Landed AND linked — the server said so. The pending tile leaves; the
      // linked photo arrives with the reload.
      setShots(prev => prev.filter(s => s.key !== key))
      await load()
      onChanged?.()
    } catch (e) {
      if (!alive.current) return
      setShots(prev => prev.map(s => s.key === key
        ? { ...s, state: 'failed', error: e instanceof Error ? e.message : 'Upload failed.' } : s))
    }
  }

  const answerOf = (form: CrewJobForm, fieldId: string): CrewFormResponse | undefined =>
    form.responses.find(r => r.field_id === fieldId)

  return (
    <div className="mt-2">
      <input
        ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden
        onChange={e => { onPickPhotos(e.target.files); e.target.value = '' }}
      />
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="tap-target w-full h-10 px-2.5 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
      >
        <ClipboardCheck className="w-3.5 h-3.5 shrink-0 text-accent-text" aria-hidden />
        <span className="font-semibold text-ink">Checklist</span>
        {summaryLine && <span className="truncate">{summaryLine}</span>}
        {requiredOpen > 0 && !counts?.waived && (
          <span className="ml-auto mr-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" aria-label={`${requiredOpen} required items open`} />
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-180', requiredOpen > 0 && !counts?.waived ? '' : 'ml-auto')} aria-hidden />
      </button>

      {open && (
        <div className="mt-1.5 space-y-2">
          {loadError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-[11px] text-ink-muted flex items-center justify-between gap-2" role="status">
              <span>{loadError}</span>
              <button type="button" className="tap-target font-semibold text-ink" onClick={() => { setLoadError(null); void load() }}>Retry</button>
            </div>
          )}
          {forms === null && !loadError && (
            <div className="rounded-lg border border-border bg-bg-tertiary/50 px-2.5 py-2 text-[11px] text-ink-faint">Loading checklist…</div>
          )}
          {forms?.length === 0 && (
            <div className="rounded-lg border border-border bg-bg-tertiary/50 px-2.5 py-2 text-[11px] text-ink-faint">
              No checklist on this visit.
            </div>
          )}
          {forms?.map(form => (
            <section key={form.id} className="rounded-lg border border-border bg-bg-tertiary/40 p-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
                {form.template_name}
                {form.frozen && (
                  <span className="inline-flex items-center gap-1 normal-case tracking-normal font-medium text-ink-faint">
                    <Lock className="w-3 h-3" aria-hidden /> completed — frozen
                  </span>
                )}
                {form.waived && <span className="normal-case tracking-normal font-medium text-amber-300/90">waived by the office</span>}
              </p>
              <div className="mt-1.5 space-y-2.5">
                {form.fields.map(field => (
                  <ChecklistField
                    key={field.id}
                    form={form}
                    field={field}
                    answer={answerOf(form, field.id)}
                    frozen={form.frozen || jobStatus === 'completed'}
                    save={saves[`${form.id}:${field.id}`] ?? { state: 'idle' }}
                    highlight={blockedFieldIds?.includes(field.id) ?? false}
                    draft={drafts[`${form.id}:${field.id}`]}
                    setDraft={v => setDrafts(prev => ({ ...prev, [`${form.id}:${field.id}`]: v }))}
                    onSave={value => save(form, field, value)}
                    pendingShots={shots.filter(s => s.fieldId === field.id)}
                    onAddPhoto={() => { pickingField.current = field.id; inputRef.current?.click() }}
                    onRetryShot={key => {
                      const s = shots.find(x => x.key === key)
                      if (s) void uploadShot(key, form, s.fieldId, s.file)
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// ── One field, one control, one honest save state ────────────────────────────

function ChecklistField({ form, field, answer, frozen, save, highlight, draft, setDraft, onSave, pendingShots, onAddPhoto, onRetryShot }: {
  form: CrewJobForm
  field: JobFormField
  answer: CrewFormResponse | undefined
  frozen: boolean
  save: FieldSaveState
  highlight: boolean
  draft: string | undefined
  setDraft: (v: string) => void
  onSave: (value: JobFormValue) => void
  pendingShots: PendingShot[]
  onAddPhoto: () => void
  onRetryShot: (key: string) => void
}) {
  if (field.type === 'section') {
    return <p className="pt-1 text-xs font-bold text-ink tracking-tight border-t border-border/60 first:border-0 first:pt-0">{field.label}</p>
  }
  if (field.type === 'instruction') {
    return <p className="text-[11px] text-ink-muted whitespace-pre-wrap break-words">{field.label}{field.help ? ` — ${field.help}` : ''}</p>
  }

  const answered = field.type === 'photo' ? (answer?.photos.length ?? 0) > 0 : answer != null
  const saving = save.state === 'saving'

  const labelRow = (
    <p className={cn('text-xs font-medium flex items-start gap-1.5', highlight ? 'text-amber-300' : 'text-ink')}>
      {answered
        ? <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" aria-hidden />
        : field.required
          ? <span className={cn('w-1.5 h-1.5 rounded-full shrink-0 mt-1.5', highlight ? 'bg-amber-400' : 'bg-amber-400/70')} aria-hidden />
          : <span className="w-1.5 h-1.5 rounded-full bg-border shrink-0 mt-1.5" aria-hidden />}
      <span className="min-w-0 break-words">
        {field.label}
        {field.required && <span className="text-ink-faint font-normal"> · required</span>}
      </span>
    </p>
  )

  const attribution = answer && (
    <p className="mt-0.5 pl-5 text-[10px] text-ink-faint">
      {answer.answered_role === 'crew' ? answer.answered_name : 'Office'} ·{' '}
      {new Date(answer.answered_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
    </p>
  )

  const failLine = save.state === 'failed' && (
    <p className="mt-1 pl-5 text-[11px] text-red-400" role="status">{save.error || 'That didn’t save — try again.'}</p>
  )

  const boxCls = 'w-full rounded-lg border border-border bg-bg-secondary px-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent disabled:opacity-60'

  const control = (() => {
    if (field.type === 'checkbox') {
      const checked = answer?.value_bool === true
      return (
        <button
          type="button" disabled={frozen || saving}
          onClick={() => onSave(checked ? {} : { bool: true })}
          className={cn('tap-target h-10 px-3 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors',
            checked ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong')}
        >
          <Check className="w-4 h-4" aria-hidden /> {checked ? 'Done' : 'Mark done'}
        </button>
      )
    }
    if (field.type === 'yes_no') {
      const v = answer?.value_bool ?? null
      return (
        <div className="flex gap-1.5">
          {([['Yes', true], ['No', false]] as const).map(([label, val]) => (
            <button
              key={label} type="button" disabled={frozen || saving}
              onClick={() => onSave(v === val ? {} : { bool: val })}
              className={cn('tap-target h-10 px-4 rounded-lg border text-xs font-semibold transition-colors',
                v === val ? 'border-accent/60 bg-accent/10 text-accent-text' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong')}
            >
              {label}
            </button>
          ))}
        </div>
      )
    }
    if (field.type === 'dropdown') {
      return (
        <select
          disabled={frozen || saving}
          value={answer?.value_choice ?? ''}
          onChange={e => onSave(e.target.value ? { choice: e.target.value } : {})}
          className={cn(boxCls, 'h-10')}
        >
          <option value="">Choose…</option>
          {(field.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (field.type === 'number') {
      const current = draft ?? (answer?.value_number != null ? String(answer.value_number) : '')
      return (
        <div className="flex items-center gap-1.5">
          <input
            type="text" inputMode="decimal" disabled={frozen || saving}
            value={current}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => {
              const raw = (draft ?? '').trim()
              if (draft === undefined) return
              if (raw === '') { onSave({}); return }
              const n = Number(raw)
              if (Number.isFinite(n)) onSave({ number: n })
            }}
            placeholder="0"
            className={cn(boxCls, 'h-10 max-w-[10rem]')}
          />
          {field.unit && <span className="text-xs text-ink-muted shrink-0">{field.unit}</span>}
        </div>
      )
    }
    if (field.type === 'date' || field.type === 'time') {
      const stored = field.type === 'date' ? answer?.value_date : answer?.value_time?.slice(0, 5)
      return (
        <input
          type={field.type} disabled={frozen || saving}
          value={stored ?? ''}
          onChange={e => onSave(e.target.value
            ? (field.type === 'date' ? { date: e.target.value } : { time: e.target.value })
            : {})}
          className={cn(boxCls, 'h-10 max-w-[12rem]')}
        />
      )
    }
    if (field.type === 'photo') {
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          {!frozen && (
            <button
              type="button" onClick={onAddPhoto}
              className="tap-target h-10 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center justify-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
            >
              <Camera className="w-3.5 h-3.5" aria-hidden /> Add photo
            </button>
          )}
          {(answer?.photos ?? []).map(p => (
            <PhotoThumb key={p.id} path={p.storage_path} />
          ))}
          {pendingShots.map(s => (
            <span key={s.key} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.previewUrl} alt="" className={cn('h-10 w-10 rounded-lg object-cover border',
                s.state === 'failed' ? 'border-red-500/60 opacity-60' : 'border-border opacity-50 animate-pulse')} />
              {s.state === 'failed' && (
                <button
                  type="button" onClick={() => onRetryShot(s.key)} aria-label="Retry upload"
                  className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-red-300"
                >
                  <RotateCw className="w-4 h-4" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )
    }
    // short_text / long_text
    const stored = answer?.value_text ?? ''
    const current = draft ?? stored
    const commit = () => {
      if (draft === undefined) return
      const trimmed = draft.trim()
      if (trimmed === stored.trim()) return
      onSave(trimmed ? { text: trimmed } : {})
    }
    return field.type === 'long_text' ? (
      <textarea
        rows={3} disabled={frozen || saving} value={current}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        placeholder={field.help || 'Write it here'}
        className={cn(boxCls, 'py-2 resize-y min-h-[4.5rem]')}
      />
    ) : (
      <input
        type="text" disabled={frozen || saving} value={current}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        placeholder={field.help || 'Write it here'}
        maxLength={200}
        className={cn(boxCls, 'h-10')}
      />
    )
  })()

  return (
    <div className={cn(highlight && 'rounded-lg -mx-1 px-1 py-1 bg-amber-500/[0.07]')}>
      {labelRow}
      {field.help && field.type !== 'short_text' && field.type !== 'long_text' && (
        <p className="mt-0.5 pl-5 text-[11px] text-ink-faint">{field.help}</p>
      )}
      <div className="mt-1 pl-5">{control}</div>
      {attribution}
      {failLine}
    </div>
  )
}

/** A linked checklist photo — job-photos is a public bucket, so the thumbnail
 *  is the canonical public URL (the same address the owner's gallery uses). */
function PhotoThumb({ path }: { path: string }) {
  const supabase = createClient()
  const { data } = supabase.storage.from('job-photos').getPublicUrl(path)
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={data.publicUrl} alt="Checklist photo" className="h-10 w-10 rounded-lg object-cover border border-emerald-500/50" />
  )
}
