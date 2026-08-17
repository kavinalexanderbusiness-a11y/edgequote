// ── Job Completion Report: ONE composed view of canonical work evidence ──────
// A polished, customer-facing account of a completed visit, assembled ENTIRELY
// from records that already exist. This module owns the composition and nothing
// else:
//
//   summary    → jobs.completion_summary        (lib/completion — the customer field)
//   photos     → job_photos                     (lib/photos — THE catalogue)
//   checklist  → job_forms + responses + links  (lib/jobForms — frozen snapshots)
//   days       → job_work_sessions              (lib/workSession)
//   payment    → invoices + the payment ledger  (lib/payments/ledger)
//
// ⛔ NOT A STORE. The report is DERIVED at read time and never written anywhere:
// no report table, no report row, no version, no share token. Durable report
// storage/versioning/sharing belongs to the Session 74 document system and this
// module must not grow a rival while that is unlanded — when S74 lands, a saved
// report becomes a document THERE, composed HERE.
//
// ⭐ CUSTOMER-SAFE BY CONSTRUCTION, the same law lib/completion enforces:
//   · `jobs.notes` and `jobs.completion_issue` are INTERNAL. This module never
//     selects either — they cannot appear in a report because they never enter
//     this file. (verify:completion-report pins both absences.)
//   · Crew-typed free text (job_form_responses.value_text/number/date/time) is
//     written under the assumption nobody outside the business reads it — the
//     exact authorship trap that leaked "dog removal, keep gate closed" to a
//     portal. A checklist item therefore renders its owner-authored LABEL and a
//     state; the only values that render are ones the database constrains to an
//     owner-authored vocabulary (yes/no booleans, dropdown choices).
//   · Worked MINUTES stay internal: the portal has never exposed actual_minutes
//     and a report must not widen that quietly. Days worked are shown; the
//     clock is not.
//   · time_entries (the payroll clock, with a wage on every row) is never read.
//
// ⭐ PHOTO ORGANIZATION IS RECORDED METADATA ONLY: the kind somebody chose
// (before/after/general), the taken_at order, the caption somebody typed, and —
// where a photo satisfies a checklist photo requirement — the owner-authored
// field label it was linked to (job_form_response_photos). Nothing here looks
// INSIDE an image; no visual interpretation is claimed, because none exists.
//
// A failed read is NOT an empty history (the portal-redesign rule): every half
// that could not be loaded is named in `unavailable`, and the report says
// "couldn't load photos", never "no photos were taken".

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, PhotoKind, WorkSession } from '@/types'
import { PHOTO_KIND_LABELS } from '@/types'
import { completionEvidence, type CompletionEvidence } from '@/lib/completion'
import { listPhotosResult, type JobPhotoView } from '@/lib/photos'
import {
  actionableFields,
  listJobFormResponses,
  listResponsePhotoLinks,
  type JobFormField,
  type JobFormInstance,
  type JobFormResponse,
  type ResponsePhotoLink,
} from '@/lib/jobForms'
import { loadWorkSessions, sessionTotals } from '@/lib/workSession'
import { invoiceBalance, displayInvoiceStatus } from '@/lib/payments/ledger'
import type { FeeSettings } from '@/lib/invoiceTotals'
import { readUser } from '@/lib/authState'

// ── Shapes ───────────────────────────────────────────────────────────────────

/** The slice of a jobs row the report needs. Deliberately narrower than Job:
 *  what is absent from this type is absent from the report. */
export interface ReportJob {
  id: string
  title: string
  service_type: string | null
  status: string
  scheduled_date: string
  completed_at: string | null
  actual_minutes: number | null
  completion_summary?: string | null
  crew_id?: string | null
}

export interface ReportBusiness {
  name: string
  phone: string | null
  email: string | null
  website: string | null
  logoUrl: string | null
}

export interface ReportPhoto {
  id: string
  kind: PhotoKind
  url: string
  caption: string | null
  takenAt: string
  /** The owner-authored checklist field this photo was linked to satisfy, when
   *  it was (e.g. "Backflow valve after service"). Recorded metadata, never a
   *  guess about what the image shows. */
  checklistLabel: string | null
}

export interface ReportPhotoGroup {
  kind: PhotoKind
  label: string
  photos: ReportPhoto[]
}

/** What a checklist item may say about itself in front of a customer.
 *  'recorded' is deliberate reticence: the item was answered, and the typed
 *  value stays inside the business. */
export type ChecklistItemState = 'done' | 'yes' | 'no' | 'photo' | 'choice' | 'recorded' | 'pending'

export interface ReportChecklistItem {
  label: string
  required: boolean
  state: ChecklistItemState
  /** Set only for state 'choice': a dropdown answer, which the response guard
   *  trigger constrains to the snapshot's owner-authored options. */
  choice: string | null
}

export interface ReportChecklist {
  name: string
  items: ReportChecklistItem[]
  done: number
  total: number
}

export type ReportPaymentState = 'paid' | 'partial' | 'due'

export interface ReportPayment {
  invoiceNumber: string
  total: number
  paid: number
  /** Never negative — an overpayment is a credit conversation, not a report line. */
  balance: number
  state: ReportPaymentState
  overdue: boolean
}

export interface ReportWorkedDays {
  count: number
  first: string
  last: string
}

export interface CompletionReport {
  /** The canonical stamp. false ⇒ nothing below may be presented as an account
   *  of a COMPLETED visit — the surfaces refuse to render a report for it. */
  completed: boolean
  completedAt: string | null
  scheduledDate: string
  title: string
  serviceType: string | null
  customerName: string | null
  address: string | null
  business: ReportBusiness | null
  crewName: string | null
  summary: string | null
  photoGroups: ReportPhotoGroup[]
  photoCount: number
  /** null = the photo read FAILED (say "unavailable"); [] in photoGroups with
   *  photosKnown true = genuinely no photos. */
  photosKnown: boolean
  checklists: ReportChecklist[]
  checklistsKnown: boolean
  workedDays: ReportWorkedDays | null
  payment: ReportPayment | null
  evidence: CompletionEvidence
  /** Human labels of the halves that could not be loaded. */
  unavailable: string[]
}

// ── Pure composition ─────────────────────────────────────────────────────────

const KIND_ORDER: readonly PhotoKind[] = ['before', 'general', 'after']

/** The DB does not CHECK job_photos.kind, so an unknown value must land
 *  somewhere honest: 'general' (the label is just "Photo"). */
const normalizeKind = (kind: string | null | undefined): PhotoKind =>
  kind === 'before' || kind === 'after' ? kind : 'general'

/** photo_id → the owner-authored label of the checklist field it satisfies. */
export function photoChecklistLabels(
  forms: JobFormInstance[],
  responses: JobFormResponse[],
  links: ResponsePhotoLink[],
): Map<string, string> {
  const fieldLabel = new Map<string, string>()
  for (const form of forms) {
    for (const f of form.fields) fieldLabel.set(`${form.id}:${f.id}`, f.label)
  }
  const responseLabel = new Map<string, string>()
  for (const r of responses) {
    const label = fieldLabel.get(`${r.form_id}:${r.field_id}`)
    if (label) responseLabel.set(r.id, label)
  }
  const out = new Map<string, string>()
  for (const l of links) {
    const label = responseLabel.get(l.response_id)
    if (label) out.set(l.photo_id, label)
  }
  return out
}

/** Groups in story order (Before → Photo → After), oldest first inside each
 *  group — a report reads forward in time, unlike the newest-first galleries. */
export function groupReportPhotos(
  photos: Pick<JobPhotoView, 'id' | 'kind' | 'url' | 'caption' | 'taken_at'>[],
  checklistLabels: Map<string, string>,
): ReportPhotoGroup[] {
  const buckets = new Map<PhotoKind, ReportPhoto[]>()
  for (const p of photos) {
    const kind = normalizeKind(p.kind)
    const list = buckets.get(kind) ?? []
    list.push({
      id: p.id,
      kind,
      url: p.url,
      caption: p.caption ?? null,
      takenAt: p.taken_at,
      checklistLabel: checklistLabels.get(p.id) ?? null,
    })
    buckets.set(kind, list)
  }
  const groups: ReportPhotoGroup[] = []
  for (const kind of KIND_ORDER) {
    const list = buckets.get(kind)
    if (!list || list.length === 0) continue
    list.sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    groups.push({ kind, label: PHOTO_KIND_LABELS[kind], photos: list })
  }
  return groups
}

/** What one answered field may say to a customer. Mirrors the gate's counting
 *  (a photo field is answered by a LINK, anything else by its response row —
 *  lib/jobForms.formProgress); the difference is presentation: only values the
 *  DB constrains to owner vocabulary (booleans, dropdown choices) render, and a
 *  checkbox that was answered-but-unchecked stays 'pending' rather than
 *  claiming a tick that was never given. */
export function checklistItemState(
  field: JobFormField,
  response: JobFormResponse | undefined,
  linkedResponseIds: Set<string>,
): Pick<ReportChecklistItem, 'state' | 'choice'> {
  if (field.type === 'photo') {
    return {
      state: response && linkedResponseIds.has(response.id) ? 'photo' : 'pending',
      choice: null,
    }
  }
  if (!response) return { state: 'pending', choice: null }
  if (field.type === 'checkbox') {
    return { state: response.value_bool === true ? 'done' : 'pending', choice: null }
  }
  if (field.type === 'yes_no') {
    if (response.value_bool === true) return { state: 'yes', choice: null }
    if (response.value_bool === false) return { state: 'no', choice: null }
    return { state: 'pending', choice: null }
  }
  if (field.type === 'dropdown') {
    return response.value_choice
      ? { state: 'choice', choice: response.value_choice }
      : { state: 'pending', choice: null }
  }
  return { state: 'recorded', choice: null }
}

/** A waived form is an internal operational decision — the customer report
 *  neither shows the checklist nor the waiver. The owner's record of the waive
 *  (who/when/why) lives on the instance and in JobFormsPanel. */
export function reportChecklists(
  forms: JobFormInstance[],
  responses: JobFormResponse[],
  links: ResponsePhotoLink[],
): ReportChecklist[] {
  const linkedResponseIds = new Set(links.map(l => l.response_id))
  const out: ReportChecklist[] = []
  for (const form of forms) {
    if (form.waived_at) continue
    const byField = new Map(
      responses.filter(r => r.form_id === form.id).map(r => [r.field_id, r]),
    )
    const items: ReportChecklistItem[] = actionableFields(form.fields).map(f => {
      const { state, choice } = checklistItemState(f, byField.get(f.id), linkedResponseIds)
      return { label: f.label, required: !!f.required, state, choice }
    })
    if (items.length === 0) continue
    out.push({
      name: form.template_name,
      items,
      done: items.filter(i => i.state !== 'pending').length,
      total: items.length,
    })
  }
  return out
}

/** Payment, only where appropriate: a draft invoice is private until sent (the
 *  same privacy predicate get_portal_data enforces) and a cancelled one is a
 *  withdrawn charge that has no business on a completion report. Figures come
 *  from THE ledger engine — GST-inclusive totals, so a taxed invoice paid only
 *  its pre-tax amount never reads as settled. */
export function reportPayment(
  invoice: Pick<Invoice,
    'invoice_number' | 'status' | 'amount' | 'amount_paid'
    | 'discount_type' | 'discount_value' | 'due_date'> & { viewed_at?: string | null } | null,
  fees: FeeSettings | null,
  todayISO: string,
): ReportPayment | null {
  if (!invoice) return null
  if (invoice.status === 'draft' || invoice.status === 'cancelled') return null
  const { total, paid, balance } = invoiceBalance(invoice, fees)
  const state: ReportPaymentState =
    balance <= 0.01 ? 'paid' : paid > 0.01 ? 'partial' : 'due'
  return {
    invoiceNumber: invoice.invoice_number,
    total,
    paid,
    balance: Math.max(0, balance),
    state,
    overdue: displayInvoiceStatus(invoice, fees, todayISO) === 'overdue',
  }
}

export interface CompletionReportInput {
  job: ReportJob
  customerName: string | null
  address: string | null
  business: ReportBusiness | null
  /** null = that read failed (distinct from an empty result). */
  photos: JobPhotoView[] | null
  forms: JobFormInstance[] | null
  responses: JobFormResponse[] | null
  photoLinks: ResponsePhotoLink[] | null
  sessions: WorkSession[] | null
  invoice: Invoice | null
  fees: FeeSettings | null
  crewName: string | null
  todayISO: string
}

export function buildCompletionReport(input: CompletionReportInput): CompletionReport {
  const { job } = input
  const unavailable: string[] = []

  const photosKnown = input.photos !== null
  if (!photosKnown) unavailable.push('photos')
  const checklistsKnown =
    input.forms !== null && input.responses !== null && input.photoLinks !== null
  if (!checklistsKnown) unavailable.push('checklist')
  if (input.sessions === null) unavailable.push('days worked')

  const forms = input.forms ?? []
  const responses = input.responses ?? []
  const links = input.photoLinks ?? []

  const photoGroups = photosKnown
    ? groupReportPhotos(input.photos!, photoChecklistLabels(forms, responses, links))
    : []
  const photoCount = photoGroups.reduce((n, g) => n + g.photos.length, 0)

  // Days worked come from the session log when there is one; a session-less
  // visit (most single-day work) worked the day it completed. No sessions AND
  // no stamp = no claim.
  let workedDays: ReportWorkedDays | null = null
  if (input.sessions && input.sessions.length > 0) {
    const totals = sessionTotals(input.sessions)
    if (totals.firstDay && totals.lastDay) {
      workedDays = { count: totals.days, first: totals.firstDay, last: totals.lastDay }
    }
  } else if (input.sessions && job.completed_at) {
    const day = job.completed_at.slice(0, 10)
    workedDays = { count: 1, first: day, last: day }
  }

  return {
    completed: job.status === 'completed' && !!job.completed_at,
    completedAt: job.completed_at ?? null,
    scheduledDate: job.scheduled_date,
    title: job.title,
    serviceType: job.service_type ?? null,
    customerName: input.customerName,
    address: input.address,
    business: input.business,
    crewName: input.crewName,
    summary: job.completion_summary ?? null,
    photoGroups,
    photoCount,
    photosKnown,
    checklists: checklistsKnown ? reportChecklists(forms, responses, links) : [],
    checklistsKnown,
    workedDays,
    payment: reportPayment(input.invoice, input.fees, input.todayISO),
    evidence: completionEvidence(
      { completed_at: job.completed_at, actual_minutes: job.actual_minutes,
        completion_summary: job.completion_summary ?? null },
      (input.photos ?? []).map(p => ({ kind: normalizeKind(p.kind) })),
    ),
    unavailable,
  }
}

/** 'YYYY-MM-DD' → 'Aug 16, 2026' without ever constructing a Date from a
 *  date-only string (which UTC-shifts a day for every tenant west of
 *  Greenwich — the worked_on lesson from work-sessions). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function formatReportDay(dayISO: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayISO)
  if (!m) return dayISO
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

/** The one date line a report headline carries. Multi-day work says so. */
export function workedDaysLine(report: Pick<CompletionReport, 'workedDays' | 'completedAt'>): string | null {
  const w = report.workedDays
  if (!w) {
    return report.completedAt ? formatReportDay(report.completedAt.slice(0, 10)) : null
  }
  if (w.count <= 1 || w.first === w.last) return formatReportDay(w.first)
  return `${formatReportDay(w.first)} – ${formatReportDay(w.last)} (${w.count} days)`
}

// ── Loading (owner-side transport; every source is the canonical reader) ─────

// ⛔ `notes` and `completion_issue` are DELIBERATELY absent from this select —
// that absence is the report's privacy boundary and verify:completion-report
// pins it. Do not add either, ever; customer-facing words live in
// completion_summary.
const REPORT_JOB_SELECT =
  'id, title, service_type, status, scheduled_date, completed_at, actual_minutes, '
  + 'completion_summary, crew_id, customers(name), properties(address)'

const REPORT_FORM_SELECT =
  'id, job_id, template_id, template_name, fields, source, waived_at, waived_by, waive_reason, created_at'

const REPORT_INVOICE_SELECT =
  'id, invoice_number, status, amount, amount_paid, discount_type, discount_value, due_date, viewed_at, created_at'

export interface CompletionReportLoad {
  report: CompletionReport | null
  error: string | null
}

export async function loadCompletionReport(
  supabase: SupabaseClient, jobId: string,
): Promise<CompletionReportLoad> {
  const auth = await readUser(supabase)
  if (auth.kind !== 'signed-in') {
    return {
      report: null,
      error: auth.kind === 'signed-out'
        ? 'Sign in to view this report.'
        : 'Could not confirm your session — check your connection and try again.',
    }
  }
  const userId = auth.user.id

  const { data: jobRow, error: jobError } = await supabase
    .from('jobs').select(REPORT_JOB_SELECT).eq('id', jobId).maybeSingle()
  if (jobError || !jobRow) {
    return { report: null, error: 'Could not load this visit — refresh and try again.' }
  }
  const row = jobRow as unknown as Record<string, unknown>
  const job: ReportJob = {
    id: row.id as string,
    title: row.title as string,
    service_type: (row.service_type as string | null) ?? null,
    status: row.status as string,
    scheduled_date: row.scheduled_date as string,
    completed_at: (row.completed_at as string | null) ?? null,
    actual_minutes: (row.actual_minutes as number | null) ?? null,
    completion_summary: (row.completion_summary as string | null) ?? null,
    crew_id: (row.crew_id as string | null) ?? null,
  }
  const customerName = ((row.customers as { name?: string } | null)?.name) ?? null
  const address = ((row.properties as { address?: string } | null)?.address) ?? null

  // The remaining halves are independent; one failing must not take the rest
  // down, and each failure is REPORTED, never rendered as emptiness.
  const [photosRes, formsRes, settingsRes, sessionsRes, invoiceRes] = await Promise.all([
    listPhotosResult(supabase, userId, { jobId }),
    supabase.from('job_forms').select(REPORT_FORM_SELECT).eq('job_id', jobId),
    supabase.from('business_settings')
      .select('company_name, phone, email_primary, website, logo_url, payment_fee_strategy, fee_recovery_percent, gst_percent')
      .limit(1).maybeSingle(),
    loadWorkSessions(supabase, jobId),
    supabase.from('invoices').select(REPORT_INVOICE_SELECT)
      .eq('job_id', jobId).order('created_at', { ascending: false }),
  ])

  const photos = photosRes.error ? null : photosRes.photos

  let forms: JobFormInstance[] | null = null
  let responses: JobFormResponse[] | null = null
  let photoLinks: ResponsePhotoLink[] | null = null
  if (!formsRes.error) {
    forms = ((formsRes.data ?? []) as unknown as Record<string, unknown>[]).map(r => ({
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
    }))
    try {
      responses = await listJobFormResponses(supabase, forms.map(f => f.id))
      photoLinks = await listResponsePhotoLinks(supabase, responses.map(r => r.id))
    } catch {
      forms = null
      responses = null
      photoLinks = null
    }
  }

  const settingsRow = (settingsRes.data ?? null) as
    | (ReportBusinessRow & FeeSettings)
    | null
  const business: ReportBusiness | null = settingsRow
    ? {
        name: settingsRow.company_name,
        phone: settingsRow.phone ?? null,
        email: settingsRow.email_primary ?? null,
        website: settingsRow.website ?? null,
        logoUrl: settingsRow.logo_url ?? null,
      }
    : null
  const fees: FeeSettings | null = settingsRow
    ? {
        payment_fee_strategy: settingsRow.payment_fee_strategy ?? null,
        fee_recovery_percent: settingsRow.fee_recovery_percent ?? null,
        gst_percent: settingsRow.gst_percent ?? null,
      }
    : null

  const sessions = sessionsRes.failed ? null : sessionsRes.sessions

  const invoices = (invoiceRes.data ?? []) as Invoice[]
  const invoice = invoiceRes.error
    ? null
    : invoices.find(i => i.status !== 'draft' && i.status !== 'cancelled') ?? null

  let crewName: string | null = null
  if (job.crew_id) {
    const { data: crewRow } = await supabase
      .from('crews').select('name').eq('id', job.crew_id).maybeSingle()
    crewName = ((crewRow as { name?: string } | null)?.name) ?? null
  }

  return {
    report: buildCompletionReport({
      job,
      customerName,
      address,
      business,
      photos,
      forms,
      responses,
      photoLinks,
      sessions,
      invoice,
      fees,
      crewName,
      todayISO: new Date().toISOString().slice(0, 10),
    }),
    error: null,
  }
}

interface ReportBusinessRow {
  company_name: string
  phone: string | null
  email_primary: string | null
  website: string | null
  logo_url: string | null
}
