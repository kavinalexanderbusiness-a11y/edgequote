// ── Job Forms + Checklists: the owner engine ─────────────────────────────────
// THE MODEL (three ideas, deliberately apart):
//   template  (form_templates + form_template_fields)  — reusable, editable
//   instance  (job_forms)   — attached to ONE visit, carrying a FROZEN jsonb
//                             snapshot of the fields as they stood at attach
//                             time. A template edit reaches only forms not yet
//                             minted; history never rewrites itself.
//   response  (job_form_responses [+ _photos])         — who answered what, when
//
// WHERE ENFORCEMENT LIVES — and does not: the database. The response guard
// trigger validates every answer against the snapshot; the completion gate
// trigger refuses the transition to 'completed' while a required item is
// missing (unless the owner waived that form, with a reason); the freeze
// trigger keeps a completed visit's answers historical. The helpers in this
// file are TRANSPORT and PRESENTATION. `formProgress` below mirrors the SQL's
// counting for display only — the SQL functions (job_form_missing_items /
// job_form_summary / the gate trigger) stay the single authority, and a
// disagreement between the two is a bug in THIS file, never a reason to relax
// the trigger.
//
// AUDIENCE: owner + crew, never the customer. No portal projection selects
// these tables (registered wholeTable in lib/noteScope). There is deliberately
// NO per-field "customer visible" switch — the codebase's own law: a
// visibility flag is a control whose only use is to leak.
//
// PHOTOS: a photo requirement is satisfied by canonical `job_photos` rows of
// the SAME visit, linked through job_form_response_photos (trigger-enforced).
// This module never uploads anything — the caller hands photos from the ONE
// uploader (lib/photos / JobPhotos / api/crew/photos) and links them here.

import type { SupabaseClient } from '@supabase/supabase-js'

export type JobFormFieldType =
  | 'section' | 'instruction' | 'checkbox' | 'short_text' | 'long_text'
  | 'number' | 'yes_no' | 'dropdown' | 'date' | 'time' | 'photo'

/** Field types that carry no answer — structure, not questions. */
export const PASSIVE_FIELD_TYPES: readonly JobFormFieldType[] = ['section', 'instruction'] as const

export const FIELD_TYPE_COPY: Record<JobFormFieldType, string> = {
  section: 'Section heading',
  instruction: 'Instruction',
  checkbox: 'Checkbox',
  short_text: 'Short answer',
  long_text: 'Long answer',
  number: 'Number',
  yes_no: 'Yes / No',
  dropdown: 'Dropdown',
  date: 'Date',
  time: 'Time',
  photo: 'Photo',
}

/** One field as it lives in an instance's frozen snapshot (nulls stripped). */
export interface JobFormField {
  id: string
  position: number
  type: JobFormFieldType
  label: string
  help?: string
  required?: boolean
  options?: string[]
  unit?: string
  photo_kind?: 'before' | 'after' | 'general'
}

export interface FormTemplate {
  id: string
  user_id: string
  name: string
  description: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** A field as the BUILDER edits it (a row, not a snapshot). */
export interface FormTemplateField {
  id: string
  template_id: string
  position: number
  field_type: JobFormFieldType
  label: string
  help_text: string | null
  required: boolean
  options: string[] | null
  unit: string | null
  photo_kind: 'before' | 'after' | 'general' | null
}

export interface JobFormInstance {
  id: string
  job_id: string
  template_id: string
  template_name: string
  fields: JobFormField[]
  source: 'service_template' | 'series' | 'manual'
  waived_at: string | null
  waived_by: string | null
  waive_reason: string | null
  created_at: string
}

export interface JobFormResponse {
  id: string
  form_id: string
  field_id: string
  value_text: string | null
  value_number: number | null
  value_bool: boolean | null
  value_date: string | null
  value_time: string | null
  value_choice: string | null
  answered_by: string
  answered_role: 'owner' | 'crew'
  answered_at: string
  corrected_at: string | null
  correction_reason: string | null
}

/** The typed value a save carries — exactly one part set (or none = clear). */
export interface JobFormValue {
  text?: string | null
  number?: number | null
  bool?: boolean | null
  date?: string | null
  time?: string | null
  choice?: string | null
}

/** Counts-only summary, as crew_day ships it per stop. Shape owned by
 *  public.job_form_summary — do not invent fields here. */
export interface JobFormSummary {
  forms: number
  items: number
  done: number
  required: number
  required_done: number
  waived: boolean
}

export interface JobFormMissingItem {
  form_id: string | null
  form: string
  field_id: string
  label: string
  type: string
}

export interface JobFormWriteResult { ok: boolean; error?: string }

const rowToInstance = (r: Record<string, unknown>): JobFormInstance => ({
  id: r.id as string,
  job_id: r.job_id as string,
  template_id: r.template_id as string,
  template_name: r.template_name as string,
  fields: (r.fields as JobFormField[] | null) ?? [],
  source: r.source as JobFormInstance['source'],
  waived_at: (r.waived_at as string | null) ?? null,
  waived_by: (r.waived_by as string | null) ?? null,
  waive_reason: (r.waive_reason as string | null) ?? null,
  created_at: r.created_at as string,
})

// ── Templates (the library) ──────────────────────────────────────────────────

export async function listFormTemplates(
  supabase: SupabaseClient, opts?: { includeArchived?: boolean },
): Promise<FormTemplate[]> {
  let q = supabase.from('form_templates').select('*').order('name')
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as FormTemplate[]
}

export async function listTemplateFields(
  supabase: SupabaseClient, templateId: string,
): Promise<FormTemplateField[]> {
  const { data, error } = await supabase.from('form_template_fields')
    .select('*').eq('template_id', templateId)
    .order('position').order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as FormTemplateField[]
}

export async function createFormTemplate(
  supabase: SupabaseClient, name: string, description?: string | null,
): Promise<FormTemplate> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in first.')
  const { data, error } = await supabase.from('form_templates')
    .insert({ user_id: user.id, name: name.trim(), description: description?.trim() || null })
    .select('*').single()
  if (error) throw new Error(error.message)
  return data as FormTemplate
}

export async function updateFormTemplate(
  supabase: SupabaseClient, id: string,
  patch: { name?: string; description?: string | null },
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('form_templates')
    .update(patch).eq('id', id).select('id')
  if (error) return { ok: false, error: error.message }
  // A PostgREST update matching zero rows returns success with no error — the
  // false-Saved shape. Ask for the row back and count it.
  if (!data || data.length === 0) return { ok: false, error: 'That template no longer exists.' }
  return { ok: true }
}

export async function setFormTemplateArchived(
  supabase: SupabaseClient, id: string, archived: boolean,
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('form_templates')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That template no longer exists.' }
  return { ok: true }
}

/** Hard delete — only possible while nothing references it. History RESTRICTs
 *  it in the database (job_forms.template_id), so the honest offer after a
 *  refusal is "archive instead", never a cascade. */
export async function deleteFormTemplate(
  supabase: SupabaseClient, id: string,
): Promise<JobFormWriteResult & { hasHistory?: boolean }> {
  const { error } = await supabase.from('form_templates').delete().eq('id', id)
  if (error) {
    const restricted = /foreign key|violates|restrict/i.test(error.message)
    return {
      ok: false,
      hasHistory: restricted,
      error: restricted
        ? 'This checklist has been used on visits — archive it instead, so history keeps rendering.'
        : error.message,
    }
  }
  return { ok: true }
}

export async function duplicateFormTemplate(
  supabase: SupabaseClient, id: string,
): Promise<FormTemplate> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in first.')
  const { data: src, error: srcErr } = await supabase.from('form_templates')
    .select('*').eq('id', id).single()
  if (srcErr || !src) throw new Error(srcErr?.message || 'Template not found.')
  const fields = await listTemplateFields(supabase, id)
  const copy = await createFormTemplate(
    supabase, `${(src as FormTemplate).name} (copy)`, (src as FormTemplate).description)
  if (fields.length) {
    const { error } = await supabase.from('form_template_fields').insert(fields.map(f => ({
      user_id: user.id,
      template_id: copy.id,
      position: f.position,
      field_type: f.field_type,
      label: f.label,
      help_text: f.help_text,
      required: f.required,
      options: f.options,
      unit: f.unit,
      photo_kind: f.photo_kind,
    })))
    // The copy must not silently arrive hollow: report, and remove the shell so
    // a half-copy can't pose as the original.
    if (error) {
      await supabase.from('form_templates').delete().eq('id', copy.id)
      throw new Error(`Couldn’t copy the fields — nothing was duplicated. (${error.message})`)
    }
  }
  return copy
}

export async function insertTemplateField(
  supabase: SupabaseClient, templateId: string,
  field: Omit<FormTemplateField, 'id' | 'template_id'>,
): Promise<FormTemplateField> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in first.')
  const { data, error } = await supabase.from('form_template_fields')
    .insert({ user_id: user.id, template_id: templateId, ...field })
    .select('*').single()
  if (error) throw new Error(error.message)
  return data as FormTemplateField
}

export async function updateTemplateField(
  supabase: SupabaseClient, id: string,
  patch: Partial<Omit<FormTemplateField, 'id' | 'template_id'>>,
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('form_template_fields')
    .update(patch).eq('id', id).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That field no longer exists.' }
  return { ok: true }
}

export async function deleteTemplateField(
  supabase: SupabaseClient, id: string,
): Promise<JobFormWriteResult> {
  const { error } = await supabase.from('form_template_fields').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Attachment ───────────────────────────────────────────────────────────────

/** Mint whatever default should exist for this visit (idempotent) and return
 *  every instance it carries. The lazy-mint IS the "attached at creation"
 *  behaviour: whoever looks first — owner panel, crew open, completion gate —
 *  finds the form there, snapshotted at that moment. */
export async function ensureJobForms(
  supabase: SupabaseClient, jobId: string,
): Promise<JobFormInstance[]> {
  const { data, error } = await supabase.rpc('ensure_job_forms', { p_job_id: jobId })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Record<string, unknown>[]).map(rowToInstance)
}

/** Manual attach — mints through the SAME SQL snapshot builder the defaults
 *  use (attach_job_form), never a TypeScript copy of it. */
export async function attachJobForm(
  supabase: SupabaseClient, jobId: string, templateId: string,
): Promise<JobFormInstance | null> {
  const { data, error } = await supabase.rpc('attach_job_form', {
    p_job_id: jobId, p_template_id: templateId,
  })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Record<string, unknown>[]
  return rows.length ? rowToInstance(rows[0]) : null
}

/** Detach an instance from a visit. Refused by the DB once answers are frozen
 *  with a completed visit (the cascade would erase history) — so the client
 *  only offers it while the visit is open. */
export async function detachJobForm(
  supabase: SupabaseClient, formId: string,
): Promise<JobFormWriteResult> {
  const { error } = await supabase.from('job_forms').delete().eq('id', formId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** The recurring series' own default. `null` clears it. */
export async function setSeriesFormTemplate(
  supabase: SupabaseClient, recurrenceId: string, templateId: string | null,
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('job_recurrences')
    .update({ form_template_id: templateId }).eq('id', recurrenceId).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That series no longer exists.' }
  return { ok: true }
}

/** The service template's default checklist. `null` clears it. */
export async function setServiceTemplateForm(
  supabase: SupabaseClient, serviceTemplateId: string, formTemplateId: string | null,
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('service_templates')
    .update({ form_template_id: formTemplateId }).eq('id', serviceTemplateId).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That service no longer exists.' }
  return { ok: true }
}

// ── Responses (owner side; crew goes through lib/crewForms) ──────────────────

export async function listJobFormResponses(
  supabase: SupabaseClient, formIds: string[],
): Promise<JobFormResponse[]> {
  if (!formIds.length) return []
  const { data, error } = await supabase.from('job_form_responses')
    .select('*').in('form_id', formIds)
  if (error) throw new Error(error.message)
  return (data ?? []) as JobFormResponse[]
}

export interface ResponsePhotoLink { response_id: string; photo_id: string; storage_path: string | null }

export async function listResponsePhotoLinks(
  supabase: SupabaseClient, responseIds: string[],
): Promise<ResponsePhotoLink[]> {
  if (!responseIds.length) return []
  const { data, error } = await supabase.from('job_form_response_photos')
    .select('response_id, photo_id, job_photos(storage_path)')
    .in('response_id', responseIds)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Record<string, unknown>[]).map(r => ({
    response_id: r.response_id as string,
    photo_id: r.photo_id as string,
    storage_path: ((r.job_photos as { storage_path?: string } | null)?.storage_path) ?? null,
  }))
}

const valueColumns = (value: JobFormValue) => ({
  value_text: value.text ?? null,
  value_number: value.number ?? null,
  value_bool: value.bool ?? null,
  value_date: value.date ?? null,
  value_time: value.time ?? null,
  value_choice: value.choice ?? null,
})

export const isEmptyValue = (value: JobFormValue): boolean =>
  value.text == null && value.number == null && value.bool == null
  && value.date == null && value.time == null && value.choice == null

/** Save one answer as the OWNER. An all-empty value clears the response row —
 *  "no answer" is the absence of a row, never a row of nulls (the DB refuses
 *  those). On a visit already completed, pass `correction` — the database
 *  refuses a frozen edit without it. */
export async function saveOwnerResponse(
  supabase: SupabaseClient,
  form: JobFormInstance,
  fieldId: string,
  value: JobFormValue,
  correction?: { reason: string },
): Promise<JobFormWriteResult> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Sign in first.' }

  if (isEmptyValue(value)) {
    const { error } = await supabase.from('job_form_responses')
      .delete().eq('form_id', form.id).eq('field_id', fieldId)
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase.from('job_form_responses')
    .upsert({
      user_id: user.id,   // the owner IS the tenant
      form_id: form.id,
      field_id: fieldId,
      ...valueColumns(value),
      answered_by: user.id,
      answered_role: 'owner' as const,
      answered_at: now,
      ...(correction ? {
        corrected_at: now,
        corrected_by: user.id,
        correction_reason: correction.reason.trim(),
      } : {}),
    }, { onConflict: 'form_id,field_id' })
    .select('id')
  if (error) return { ok: false, error: friendlyResponseError(error.message) }
  if (!data || data.length === 0) return { ok: false, error: 'That didn’t save — refresh and try again.' }
  return { ok: true }
}

/** Link an existing canonical photo (job_photos) to a photo-field response,
 *  creating the response anchor row if this is the field's first photo. The
 *  database refuses a photo of another visit. */
export async function linkOwnerResponsePhoto(
  supabase: SupabaseClient,
  form: JobFormInstance,
  fieldId: string,
  photoId: string,
): Promise<JobFormWriteResult> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Sign in first.' }

  // Anchor row (photo fields carry no typed value — the trigger allows all-null
  // for exactly this shape).
  const { data: anchor, error: anchorErr } = await supabase.from('job_form_responses')
    .upsert({
      user_id: user.id,
      form_id: form.id,
      field_id: fieldId,
      answered_by: user.id,
      answered_role: 'owner' as const,
      answered_at: new Date().toISOString(),
    }, { onConflict: 'form_id,field_id' })
    .select('id')
  if (anchorErr) return { ok: false, error: friendlyResponseError(anchorErr.message) }
  const responseId = anchor?.[0]?.id as string | undefined
  if (!responseId) return { ok: false, error: 'That didn’t save — refresh and try again.' }

  const { error: linkErr } = await supabase.from('job_form_response_photos')
    .insert({ response_id: responseId, photo_id: photoId, user_id: user.id })
  if (linkErr && !/duplicate key/i.test(linkErr.message)) {
    return { ok: false, error: friendlyResponseError(linkErr.message) }
  }
  return { ok: true }
}

export async function unlinkResponsePhoto(
  supabase: SupabaseClient, responseId: string, photoId: string,
): Promise<JobFormWriteResult> {
  const { error } = await supabase.from('job_form_response_photos')
    .delete().eq('response_id', responseId).eq('photo_id', photoId)
  if (error) return { ok: false, error: friendlyResponseError(error.message) }
  return { ok: true }
}

// ── The gate, and the waive ──────────────────────────────────────────────────

export interface JobFormGateResult { ready: boolean; missing: JobFormMissingItem[] }

/** Ask THE definition (SQL) whether this visit may complete. Presentation-side
 *  pre-check only — the BEFORE UPDATE trigger enforces the same rule even on a
 *  caller that never asked. */
export async function jobFormGate(
  supabase: SupabaseClient, jobId: string,
): Promise<JobFormGateResult | null> {
  const { data, error } = await supabase.rpc('job_form_gate', { p_job_id: jobId })
  if (error) throw new Error(error.message)
  return (data as JobFormGateResult | null) ?? null
}

/** The owner's recorded override: this form no longer gates completion. The
 *  reason is mandatory — an override without one is not a record. (When the
 *  audit-trail session lands, it reads these columns.) */
export async function waiveJobForm(
  supabase: SupabaseClient, formId: string, reason: string,
): Promise<JobFormWriteResult> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Sign in first.' }
  const trimmed = reason.trim()
  if (!trimmed) return { ok: false, error: 'Say why the checklist is being waived.' }
  const { data, error } = await supabase.from('job_forms')
    .update({ waived_at: new Date().toISOString(), waived_by: user.id, waive_reason: trimmed })
    .eq('id', formId).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That form no longer exists.' }
  return { ok: true }
}

export async function unwaiveJobForm(
  supabase: SupabaseClient, formId: string,
): Promise<JobFormWriteResult> {
  const { data, error } = await supabase.from('job_forms')
    .update({ waived_at: null, waived_by: null, waive_reason: null })
    .eq('id', formId).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'That form no longer exists.' }
  return { ok: true }
}

// ── Pure presentation helpers ────────────────────────────────────────────────

export const actionableFields = (fields: JobFormField[]): JobFormField[] =>
  fields.filter(f => !PASSIVE_FIELD_TYPES.includes(f.type))

export const responsesByField = (
  responses: JobFormResponse[],
): Map<string, JobFormResponse> => {
  const m = new Map<string, JobFormResponse>()
  for (const r of responses) m.set(`${r.form_id}:${r.field_id}`, r)
  return m
}

export interface JobFormProgress {
  done: number
  total: number
  requiredDone: number
  requiredTotal: number
  missingRequired: JobFormField[]
}

/** Display-side mirror of the SQL counting: a photo field is answered by ≥1
 *  linked photo; anything else by the presence of its response row. The SQL
 *  (job_form_summary / job_form_missing_items) remains the gate's authority. */
export function formProgress(
  form: JobFormInstance,
  responses: JobFormResponse[],
  photoLinks: ResponsePhotoLink[],
): JobFormProgress {
  const byField = new Map(responses.filter(r => r.form_id === form.id).map(r => [r.field_id, r]))
  const linkedResponseIds = new Set(photoLinks.map(l => l.response_id))
  let done = 0, total = 0, requiredDone = 0, requiredTotal = 0
  const missingRequired: JobFormField[] = []
  for (const f of actionableFields(form.fields)) {
    const r = byField.get(f.id)
    const answered = f.type === 'photo' ? (r != null && linkedResponseIds.has(r.id)) : r != null
    total++
    if (answered) done++
    if (f.required) {
      requiredTotal++
      if (answered) requiredDone++
      else missingRequired.push(f)
    }
  }
  return { done, total, requiredDone, requiredTotal, missingRequired }
}

/** The completion-gate trigger raises with a marked, readable message. Detect
 *  it in any thrown/returned error so every completion door — including ones
 *  that never pre-checked — shows the checklist sentence, not SQL noise. */
export const CHECKLIST_BLOCK_MARK = 'CHECKLIST_INCOMPLETE'

export function checklistBlockMessage(message: string | null | undefined): string | null {
  if (!message || !message.includes(CHECKLIST_BLOCK_MARK)) return null
  const after = message.slice(message.indexOf(CHECKLIST_BLOCK_MARK) + CHECKLIST_BLOCK_MARK.length).trim()
  return after || 'Before completing, finish this visit’s required checklist items.'
}

function friendlyResponseError(message: string): string {
  const blocked = checklistBlockMessage(message)
  if (blocked) return blocked
  if (/historical record|frozen for crew|explicit correction/.test(message)) {
    return 'This visit is completed — its checklist is frozen. Corrections need a reason.'
  }
  if (/not one of this field/.test(message)) return 'That choice isn’t one of this field’s options.'
  return message
}
