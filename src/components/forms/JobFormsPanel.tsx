'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { uploadPhoto } from '@/lib/photos'
import {
  ensureJobForms, attachJobForm, detachJobForm, listFormTemplates,
  listJobFormResponses, listResponsePhotoLinks, saveOwnerResponse,
  linkOwnerResponsePhoto, waiveJobForm, unwaiveJobForm, setSeriesFormTemplate,
  formProgress, actionableFields,
  type FormTemplate, type JobFormInstance, type JobFormResponse,
  type ResponsePhotoLink, type JobFormField, type JobFormValue,
} from '@/lib/jobForms'
import {
  ClipboardCheck, Check, Lock, ShieldAlert, Camera, Plus, Trash2, RotateCw,
} from 'lucide-react'

// ── The visit's checklists, on the owner's board ─────────────────────────────
// Everything the worker fills is readable here, with its attribution — who
// answered, in which role, when — and the owner can fill fields themselves
// (recorded as the OWNER's answer, never impersonating the crew).
//
// The load MINTS the default form if one should exist (ensure_job_forms), so
// "the form is attached when the job is created" is true the moment the panel
// opens, snapshotted at that moment.
//
// THE WAIVE: this panel is the only place the completion gate can be
// overridden — explicitly, with a reason, recorded on the instance
// (waived_at/by/reason — the audit-trail seam). Never silently.
//
// A COMPLETED visit's checklist is frozen. Owner edits here become explicit
// CORRECTIONS: the panel demands a reason first and the database refuses the
// write without one. Crew cannot edit frozen forms at all.
//
// This panel deliberately contains NO template building — the library lives in
// Settings. A job surface that grows a form designer stops being a job surface.

interface PanelJob {
  id: string
  status: string
  recurrence_id?: string | null
  property_id?: string | null
  customer_id?: string | null
}

interface FieldSave { state: 'idle' | 'saving' | 'failed'; error?: string }

export function JobFormsPanel({ job, onChanged }: {
  job: PanelJob
  /** Fired after any write, so a parent board can refresh its own counts. */
  onChanged?: () => void
}) {
  const supabase = createClient()
  const [forms, setForms] = useState<JobFormInstance[] | null>(null)
  const [responses, setResponses] = useState<JobFormResponse[]>([])
  const [photoLinks, setPhotoLinks] = useState<ResponsePhotoLink[]>([])
  const [templates, setTemplates] = useState<FormTemplate[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saves, setSaves] = useState<Record<string, FieldSave>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachChoice, setAttachChoice] = useState('')
  const [attachSeries, setAttachSeries] = useState(false)
  const [waivingId, setWaivingId] = useState<string | null>(null)
  const [waiveReason, setWaiveReason] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const pickingField = useRef<{ form: JobFormInstance; fieldId: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const frozen = job.status === 'completed'

  const load = useCallback(async () => {
    try {
      const [instances, tpls] = await Promise.all([
        ensureJobForms(supabase, job.id),
        listFormTemplates(supabase),
      ])
      const resp = await listJobFormResponses(supabase, instances.map(f => f.id))
      const links = await listResponsePhotoLinks(supabase, resp.map(r => r.id))
      if (!alive.current) return
      setForms(instances)
      setResponses(resp)
      setPhotoLinks(links)
      setTemplates(tpls)
      setLoadError(null)
    } catch (e) {
      if (!alive.current) return
      setLoadError(e instanceof Error ? e.message : 'Couldn’t load the checklist.')
    }
  }, [supabase, job.id])

  useEffect(() => { void load() }, [load])

  const byForm = useMemo(() => {
    const m = new Map<string, JobFormResponse[]>()
    for (const r of responses) {
      const arr = m.get(r.form_id) ?? []
      arr.push(r); m.set(r.form_id, arr)
    }
    return m
  }, [responses])

  async function save(form: JobFormInstance, field: JobFormField, value: JobFormValue) {
    const key = `${form.id}:${field.id}`
    if (frozen && !correctionReason.trim()) {
      setSaves(prev => ({ ...prev, [key]: { state: 'failed', error: 'This visit is completed — write a correction reason above before changing its checklist.' } }))
      return
    }
    setSaves(prev => ({ ...prev, [key]: { state: 'saving' } }))
    const res = await saveOwnerResponse(supabase, form, field.id, value,
      frozen ? { reason: correctionReason } : undefined)
    if (!alive.current) return
    if (!res.ok) {
      setSaves(prev => ({ ...prev, [key]: { state: 'failed', error: res.error } }))
      return
    }
    setSaves(prev => ({ ...prev, [key]: { state: 'idle' } }))
    await load()
    onChanged?.()
  }

  async function addPhoto(files: FileList | null) {
    const target = pickingField.current
    if (!files?.length || !target) return
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    for (const file of Array.from(files)) {
      const row = await uploadPhoto(supabase, {
        userId: user.id,
        file,
        propertyId: job.property_id ?? null,
        jobId: job.id,
        customerId: job.customer_id ?? null,
        kind: target.form.fields.find(f => f.id === target.fieldId)?.photo_kind ?? 'general',
      })
      if (!row) { toast.error('The photo didn’t upload — try again.'); continue }
      const linked = await linkOwnerResponsePhoto(supabase, target.form, target.fieldId, row.id)
      if (!linked.ok) { toast.error(linked.error || 'The photo didn’t attach.'); continue }
    }
    await load()
    onChanged?.()
  }

  async function doAttach() {
    if (!attachChoice) return
    try {
      const inst = await attachJobForm(supabase, job.id, attachChoice)
      if (!inst) { toast.error('Couldn’t attach that checklist.'); return }
      if (attachSeries && job.recurrence_id) {
        const r = await setSeriesFormTemplate(supabase, job.recurrence_id, attachChoice)
        if (!r.ok) toast.error(`Attached to this visit, but not to the series: ${r.error}`)
      }
      setAttachOpen(false); setAttachChoice(''); setAttachSeries(false)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t attach that checklist.')
    }
  }

  async function doWaive(form: JobFormInstance) {
    const r = await waiveJobForm(supabase, form.id, waiveReason)
    if (!r.ok) { toast.error(r.error || 'Couldn’t waive it.'); return }
    setWaivingId(null); setWaiveReason('')
    await load()
    onChanged?.()
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-ink-muted flex items-center justify-between gap-2" role="status">
        <span>Couldn’t load this visit’s checklist. ({loadError})</span>
        <Button size="sm" variant="secondary" onClick={() => { setLoadError(null); void load() }}>Retry</Button>
      </div>
    )
  }
  if (forms === null) {
    return <p className="text-xs text-ink-faint px-1 py-2">Loading checklist…</p>
  }

  const attachableTemplates = templates.filter(t => !forms.some(f => f.template_id === t.id))

  return (
    <div className="space-y-2.5">
      <input
        ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={e => { void addPhoto(e.target.files); e.target.value = '' }}
      />

      {frozen && forms.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-tertiary/50 px-3 py-2">
          <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden />
            This visit is completed — its checklist is a historical record. Changing an answer is a correction and needs a reason.
          </p>
          <input
            type="text" value={correctionReason} onChange={e => setCorrectionReason(e.target.value)}
            placeholder="Correction reason (required to edit)"
            maxLength={300}
            className="mt-1.5 w-full h-9 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
          />
        </div>
      )}

      {forms.length === 0 && (
        <p className="text-xs text-ink-faint">
          No checklist on this visit. Attach one below, or set a default checklist on the service in Settings → Service Templates.
        </p>
      )}

      {forms.map(form => {
        const formResponses = byForm.get(form.id) ?? []
        const progress = formProgress(form, formResponses, photoLinks)
        const respByField = new Map(formResponses.map(r => [r.field_id, r]))
        const waived = form.waived_at != null
        return (
          <section key={form.id} className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5 text-accent-text shrink-0" aria-hidden />
                  <span className="truncate">{form.template_name}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-ink-faint tabular-nums">
                  {progress.done} of {progress.total} done
                  {progress.requiredTotal > 0 && (
                    <> · {progress.requiredDone === progress.requiredTotal
                      ? 'required complete'
                      : `${progress.requiredTotal - progress.requiredDone} required open`}</>
                  )}
                  {' · '}
                  {form.source === 'manual' ? 'attached by hand'
                    : form.source === 'series' ? 'from this series’ default'
                    : 'from the service template'}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!frozen && !waived && progress.requiredTotal > progress.requiredDone && (
                  <Button size="sm" variant="ghost" onClick={() => { setWaivingId(waivingId === form.id ? null : form.id); setWaiveReason('') }}>
                    <ShieldAlert className="w-3.5 h-3.5" /> Waive
                  </Button>
                )}
                {!frozen && formResponses.length === 0 && (
                  <Button
                    size="sm" variant="ghost" className="text-red-400/70 hover:text-red-400"
                    aria-label="Detach checklist"
                    onClick={async () => {
                      const r = await detachJobForm(supabase, form.id)
                      if (!r.ok) { toast.error(r.error || 'Couldn’t detach it.'); return }
                      await load(); onChanged?.()
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>

            {waived && (
              <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 flex items-center justify-between gap-2">
                <p className="text-[11px] text-amber-300/90">
                  Waived — doesn’t gate completion. Reason: <span className="text-ink-muted">{form.waive_reason}</span>
                </p>
                {!frozen && (
                  <button
                    type="button"
                    className="text-[11px] font-semibold text-ink-muted hover:text-ink shrink-0"
                    onClick={async () => {
                      const r = await unwaiveJobForm(supabase, form.id)
                      if (!r.ok) { toast.error(r.error || 'Couldn’t restore it.'); return }
                      await load(); onChanged?.()
                    }}
                  >
                    Require again
                  </button>
                )}
              </div>
            )}

            {waivingId === form.id && (
              <div className="mt-2 rounded-lg border border-border bg-bg-tertiary/50 p-2.5">
                <p className="text-[11px] text-ink-muted">
                  Waiving lets this visit complete with required items unfinished. Say why — the reason is kept on the record.
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="text" value={waiveReason} onChange={e => setWaiveReason(e.target.value)}
                    placeholder="e.g. customer asked us to skip the walkthrough"
                    maxLength={300} autoFocus
                    className="flex-1 h-9 rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
                  />
                  <Button size="sm" disabled={!waiveReason.trim()} onClick={() => doWaive(form)}>Waive</Button>
                  <Button size="sm" variant="ghost" onClick={() => setWaivingId(null)}>Cancel</Button>
                </div>
              </div>
            )}

            <div className="mt-2.5 space-y-2">
              {form.fields.map(field => (
                <OwnerField
                  key={field.id}
                  field={field}
                  answer={respByField.get(field.id)}
                  links={photoLinks}
                  frozen={frozen}
                  save={saves[`${form.id}:${field.id}`] ?? { state: 'idle' }}
                  draft={drafts[`${form.id}:${field.id}`]}
                  setDraft={v => setDrafts(prev => ({ ...prev, [`${form.id}:${field.id}`]: v }))}
                  onSave={value => save(form, field, value)}
                  onAddPhoto={() => { pickingField.current = { form, fieldId: field.id }; fileRef.current?.click() }}
                />
              ))}
              {actionableFields(form.fields).length === 0 && (
                <p className="text-[11px] text-ink-faint">This checklist has no fillable items.</p>
              )}
            </div>
          </section>
        )
      })}

      {!frozen && (
        attachOpen ? (
          <div className="rounded-lg border border-border bg-bg-tertiary/50 p-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={attachChoice} onChange={e => setAttachChoice(e.target.value)}
                className="h-9 flex-1 min-w-[12rem] rounded-lg border border-border bg-bg-secondary px-2.5 text-xs text-ink focus:outline-none focus:border-accent"
              >
                <option value="">Choose a checklist…</option>
                {attachableTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <Button size="sm" disabled={!attachChoice} onClick={() => void doAttach()}>Attach</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAttachOpen(false); setAttachChoice('') }}>Cancel</Button>
            </div>
            {job.recurrence_id && (
              <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-muted cursor-pointer">
                <input type="checkbox" checked={attachSeries} onChange={e => setAttachSeries(e.target.checked)} className="accent-current" />
                Also make it the default for future visits in this series
              </label>
            )}
            {attachableTemplates.length === 0 && (
              <p className="mt-1.5 text-[11px] text-ink-faint">
                Every checklist is already attached, or none exist yet — build one in Settings → Job Checklists.
              </p>
            )}
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setAttachOpen(true)}>
            <Plus className="w-3.5 h-3.5" /> Attach a checklist
          </Button>
        )
      )}
    </div>
  )
}

// ── One field, owner-side ────────────────────────────────────────────────────

function OwnerField({ field, answer, links, frozen, save, draft, setDraft, onSave, onAddPhoto }: {
  field: JobFormField
  answer: JobFormResponse | undefined
  links: ResponsePhotoLink[]
  frozen: boolean
  save: FieldSave
  draft: string | undefined
  setDraft: (v: string) => void
  onSave: (value: JobFormValue) => void
  onAddPhoto: () => void
}) {
  const supabase = createClient()
  if (field.type === 'section') {
    return <p className="pt-1.5 text-xs font-bold text-ink tracking-tight border-t border-border/60 first:border-0 first:pt-0">{field.label}</p>
  }
  if (field.type === 'instruction') {
    return <p className="text-[11px] text-ink-muted whitespace-pre-wrap break-words">{field.label}{field.help ? ` — ${field.help}` : ''}</p>
  }

  const myLinks = answer ? links.filter(l => l.response_id === answer.id) : []
  const answered = field.type === 'photo' ? myLinks.length > 0 : answer != null
  const saving = save.state === 'saving'
  const boxCls = 'w-full rounded-lg border border-border bg-bg-tertiary/60 px-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent disabled:opacity-60'

  const control = (() => {
    if (field.type === 'checkbox') {
      const checked = answer?.value_bool === true
      return (
        <button
          type="button" disabled={saving}
          onClick={() => onSave(checked ? {} : { bool: true })}
          className={cn('h-9 px-3 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors',
            checked ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong')}
        >
          <Check className="w-3.5 h-3.5" aria-hidden /> {checked ? 'Done' : 'Mark done'}
        </button>
      )
    }
    if (field.type === 'yes_no') {
      const v = answer?.value_bool ?? null
      return (
        <div className="flex gap-1.5">
          {([['Yes', true], ['No', false]] as const).map(([label, val]) => (
            <button
              key={label} type="button" disabled={saving}
              onClick={() => onSave(v === val ? {} : { bool: val })}
              className={cn('h-9 px-3.5 rounded-lg border text-xs font-semibold transition-colors',
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
          disabled={saving}
          value={answer?.value_choice ?? ''}
          onChange={e => onSave(e.target.value ? { choice: e.target.value } : {})}
          className={cn(boxCls, 'h-9 max-w-[16rem]')}
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
            type="text" inputMode="decimal" disabled={saving} value={current}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => {
              if (draft === undefined) return
              const raw = draft.trim()
              if (raw === '') { onSave({}); return }
              const n = Number(raw)
              if (Number.isFinite(n)) onSave({ number: n })
            }}
            placeholder="0"
            className={cn(boxCls, 'h-9 max-w-[9rem]')}
          />
          {field.unit && <span className="text-xs text-ink-muted">{field.unit}</span>}
        </div>
      )
    }
    if (field.type === 'date' || field.type === 'time') {
      const stored = field.type === 'date' ? answer?.value_date : answer?.value_time?.slice(0, 5)
      return (
        <input
          type={field.type} disabled={saving} value={stored ?? ''}
          onChange={e => onSave(e.target.value
            ? (field.type === 'date' ? { date: e.target.value } : { time: e.target.value })
            : {})}
          className={cn(boxCls, 'h-9 max-w-[11rem]')}
        />
      )
    }
    if (field.type === 'photo') {
      return (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button" onClick={onAddPhoto}
            className="h-9 px-3 rounded-lg border border-border text-xs font-medium text-ink-muted flex items-center gap-1.5 hover:text-ink hover:border-border-strong transition-colors"
          >
            <Camera className="w-3.5 h-3.5" aria-hidden /> Add photo
          </button>
          {myLinks.map(l => l.storage_path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={l.photo_id}
              src={supabase.storage.from('job-photos').getPublicUrl(l.storage_path).data.publicUrl}
              alt="Checklist photo"
              className="h-9 w-9 rounded-lg object-cover border border-emerald-500/50"
            />
          ) : null)}
        </div>
      )
    }
    const stored = answer?.value_text ?? ''
    const current = draft ?? stored
    const commit = () => {
      if (draft === undefined) return
      const trimmed = draft.trim()
      if (trimmed === stored.trim()) return
      onSave(trimmed ? { text: trimmed } : {})
    }
    return field.type === 'long_text' ? (
      <textarea rows={2} disabled={saving} value={current}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        placeholder={field.help || 'Write it here'} className={cn(boxCls, 'py-1.5 resize-y')} />
    ) : (
      <input type="text" disabled={saving} value={current} maxLength={200}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        placeholder={field.help || 'Write it here'} className={cn(boxCls, 'h-9')} />
    )
  })()

  return (
    <div>
      <p className="text-xs font-medium text-ink flex items-start gap-1.5">
        {answered
          ? <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" aria-hidden />
          : <span className={cn('w-1.5 h-1.5 rounded-full shrink-0 mt-1.5', field.required ? 'bg-amber-400/70' : 'bg-border')} aria-hidden />}
        <span className="min-w-0 break-words">
          {field.label}
          {field.required && <span className="text-ink-faint font-normal"> · required</span>}
        </span>
      </p>
      {field.help && field.type !== 'short_text' && field.type !== 'long_text' && (
        <p className="mt-0.5 pl-5 text-[11px] text-ink-faint">{field.help}</p>
      )}
      <div className="mt-1 pl-5">{control}</div>
      {answer && (
        <p className="mt-0.5 pl-5 text-[10px] text-ink-faint">
          {answer.answered_role === 'crew' ? 'Answered by crew' : 'Answered by you'} ·{' '}
          {new Date(answer.answered_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          {answer.corrected_at && <> · corrected: <span className="text-ink-muted">{answer.correction_reason}</span></>}
        </p>
      )}
      {save.state === 'failed' && (
        <p className="mt-1 pl-5 text-[11px] text-red-400 flex items-center gap-1.5" role="status">
          <RotateCw className="w-3 h-3 shrink-0" aria-hidden /> {save.error || 'That didn’t save — try again.'}
        </p>
      )}
    </div>
  )
}
