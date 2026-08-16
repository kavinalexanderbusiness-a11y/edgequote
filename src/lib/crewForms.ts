// ── Job Forms: the crew half ─────────────────────────────────────────────────
// A crew session has ZERO table access (the founding crew-mode rule), so every
// read and write here rides a typed SECURITY DEFINER RPC that re-proves
// employer + crew assignment per call:
//   crew_job_forms(job)          — open a visit's checklists (mints the default
//                                  if one should exist, so "attached at
//                                  creation" is true the moment anyone looks)
//   crew_save_form_response(...) — ONE answer, typed parameters only. Never a
//                                  jsonb patch a client could stuff a column
//                                  name into. All-null values = clear.
// Photos go through the ONE crew upload door (/api/crew/photos) with the form
// field named; the server verifies, uploads, catalogues and links — a failed
// upload never marks the requirement complete because the link row is the
// requirement and it only exists after everything else succeeded.
//
// Three-outcome loads, like every crew read: ok / notYours / error. A dead
// zone must never render as "no checklist" — with nothing loaded the screen
// says it couldn't load.
//
// Every function here REPORTS ITS WRITE. Online-only, like all crew writes.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobFormField, JobFormValue } from '@/lib/jobForms'

export interface CrewFormResponse {
  field_id: string
  value_text: string | null
  value_number: number | null
  value_bool: boolean | null
  value_date: string | null
  value_time: string | null
  value_choice: string | null
  answered_role: 'owner' | 'crew'
  answered_at: string
  answered_name: string
  photos: { id: string; storage_path: string }[]
}

export interface CrewJobForm {
  id: string
  template_name: string
  fields: JobFormField[]
  waived: boolean
  frozen: boolean
  responses: CrewFormResponse[]
}

export type CrewJobFormsResult =
  | { kind: 'ok'; forms: CrewJobForm[] }
  | { kind: 'notYours' }
  | { kind: 'error'; message: string }

export async function loadCrewJobForms(
  supabase: SupabaseClient, jobId: string,
): Promise<CrewJobFormsResult> {
  const { data, error } = await supabase.rpc('crew_job_forms', { p_job_id: jobId })
  if (error) return { kind: 'error', message: error.message }
  if (data == null) return { kind: 'notYours' }
  return { kind: 'ok', forms: data as CrewJobForm[] }
}

export interface CrewFormWriteResult { ok: boolean; error?: string }

/** Save one answer. Empty value (all parts null/undefined) clears the field —
 *  "no answer" is the absence of a row, and the phone must be able to say so. */
export async function crewSaveFormResponse(
  supabase: SupabaseClient, formId: string, fieldId: string, value: JobFormValue,
): Promise<CrewFormWriteResult> {
  try {
    const { data, error } = await supabase.rpc('crew_save_form_response', {
      p_form_id: formId,
      p_field_id: fieldId,
      p_value_text: value.text ?? null,
      p_value_number: value.number ?? null,
      p_value_bool: value.bool ?? null,
      p_value_date: value.date ?? null,
      p_value_time: value.time ?? null,
      p_value_choice: value.choice ?? null,
    })
    if (error) return { ok: false, error: 'That didn’t save — check your signal and try again.' }
    const res = data as { ok?: boolean; reason?: string } | null
    if (!res?.ok) {
      if (res?.reason === 'completed') {
        return { ok: false, error: 'This visit is finished — its checklist is frozen. Ask the office if something needs correcting.' }
      }
      if (res?.reason === 'cancelled') {
        return { ok: false, error: 'This visit was cancelled — its checklist is closed.' }
      }
      return { ok: false, error: 'Couldn’t save that — this visit is no longer on your board. Refresh and try again.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'That didn’t save — check your signal and try again.' }
  }
}

/** Photograph a checklist requirement — through the canonical crew photo door,
 *  naming the form field so the server links what it catalogues. Returns only
 *  after the photo is stored, catalogued AND linked; any earlier failure rolls
 *  the upload back and reports, so a dead zone can never tick the box. */
export async function uploadCrewFormPhoto(
  jobId: string, formId: string, fieldId: string, file: File,
  kind: 'before' | 'after' | 'general' = 'general',
): Promise<CrewFormWriteResult & { photoId?: string; url?: string }> {
  try {
    const fd = new FormData()
    fd.set('jobId', jobId)
    fd.set('kind', kind)
    fd.set('formId', formId)
    fd.set('fieldId', fieldId)
    fd.set('file', file)
    const res = await fetch('/api/crew/photos', { method: 'POST', body: fd })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok) {
      return { ok: false, error: d.error || 'The photo didn’t upload — check your signal and try again.' }
    }
    return { ok: true, photoId: d.id, url: d.url }
  } catch {
    return { ok: false, error: 'The photo didn’t upload — check your signal and try again.' }
  }
}
