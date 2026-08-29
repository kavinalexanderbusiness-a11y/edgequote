import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addVersion, requestSignature, uploadDocument,
  type DocumentSignature, type DocumentVersion, type SignaturePurpose,
} from '@/lib/documents'

// ── CONTRACTS — the commercial relationship, and nothing else ────────────────
//
// ⭐⭐ A CONTRACT IS NOT A DOCUMENT, A SIGNATURE, OR A SCHEDULE. Session 74 owns
// the artifact (documents → immutable versions), the ask (signature requests)
// and the act (signatures). `job_recurrences` owns when visits happen. This
// module owns the business meaning that sits on top of all three:
//
//   what the agreement IS      → title, contract_type, template provenance
//   who it is WITH             → customer (required), plus optional links
//   how long it RUNS           → effective_date, end_date, renewal notice
//   where it IS in its life    → draft → sent → active → terminated/superseded
//
// ⛔ NOTHING HERE SCHEDULES ANYTHING. A contract may reference a recurrence
// ("this agreement governs that series"), but signing never creates, edits or
// cancels a visit, and a contract's dates are never read from a recurrence. The
// three truths — agreed / scheduled / delivered — stay independent, and
// verify:contracts pins each direction.
//
// ⛔ NOT A SECOND SIGNATURE ENGINE. There is no signature pad, no request table,
// no bucket and no signing token here. Every one of those calls into S74.

export type ContractStatus = 'draft' | 'sent' | 'active' | 'terminated' | 'superseded'

/** What a surface actually shows. `expired` is DERIVED and never stored. */
export type ContractDisplayStatus = ContractStatus | 'expired'

export interface ContractTemplate {
  id: string
  user_id: string
  name: string
  contract_type: string | null
  body: string
  term_months: number | null
  open_ended: boolean
  renewal_notice_days: number | null
  signature_required: boolean
  purpose: SignaturePurpose
  statement: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface ContractRecord {
  id: string
  user_id: string
  template_id: string | null
  template_name: string | null
  customer_id: string
  property_id: string | null
  job_id: string | null
  quote_id: string | null
  job_recurrence_id: string | null
  service_template_id: string | null
  title: string
  contract_type: string | null
  status: ContractStatus
  signature_required: boolean
  effective_date: string | null
  end_date: string | null
  renewal_notice_days: number | null
  document_id: string | null
  document_version_id: string | null
  signature_request_id: string | null
  sent_at: string | null
  activated_at: string | null
  terminated_at: string | null
  termination_reason: string | null
  superseded_by_id: string | null
  created_at: string
  updated_at: string
}

export interface ContractView extends ContractRecord {
  /** Status as a human should read it — `expired` folded in. */
  display: ContractDisplayStatus
  /** Term in one line, honest about open-ended. */
  termLabel: string
  /** Renewal awareness. See renewalState — deliberately NOT Session 53's engine. */
  renewal: RenewalState
  /** True once the customer has signed; drives what the UI may still offer. */
  signed: boolean
}

// ── Vocabulary ───────────────────────────────────────────────────────────────
// ⭐ SUGGESTIONS, NEVER A CLOSED LIST. `contract_type` is free text in the schema
// because EdgeHQ serves whatever trade the owner runs. A fixed five-word enum
// would be wrong for the first owner who needs a sixth word.
export const CONTRACT_TYPES = [
  'Service Agreement',
  'Maintenance Agreement',
  'Project Contract',
  'Terms Acknowledgement',
  'Other',
] as const

export const STATUS_LABEL: Record<ContractDisplayStatus, string> = {
  draft: 'Draft',
  sent: 'Awaiting signature',
  active: 'Active',
  expired: 'Expired',
  terminated: 'Terminated',
  superseded: 'Superseded',
}

/** What each state means, in the owner's language. Shown beside the badge so a
 *  status never has to be guessed at. */
export const STATUS_HELP: Record<ContractDisplayStatus, string> = {
  draft: 'Not sent yet. Nothing has been shared with the customer.',
  sent: 'Sent to the customer. It becomes active when they sign.',
  active: 'In force.',
  expired: 'Its end date has passed. The record is kept in full.',
  terminated: 'Ended deliberately before its end date.',
  superseded: 'Replaced by a newer contract. The signed record is preserved.',
}

// ── Term semantics ───────────────────────────────────────────────────────────
// ⛔ NO ANNUAL DEFAULT. ⛔ NO SEASONAL DATES. ⛔ Monthly billing does not imply
// monthly visits — this module has no opinion about visits at all.

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` for a Date, in local terms — dates here are calendar dates, not
 *  instants, so they must never be shifted by a timezone conversion. */
export function toISODate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function daysUntil(iso: string, today = new Date()): number {
  const a = parseISODate(toISODate(today))
  const b = parseISODate(iso)
  return Math.round((b.getTime() - a.getTime()) / DAY_MS)
}

/**
 * The end date implied by a term length — the ONE place months are turned into a
 * date. An open-ended agreement returns null, which is the schema's own way of
 * saying "no end", not a sentinel far-future date that would later read as a
 * real deadline.
 */
export function endDateFromTerm(
  effective: string | null, termMonths: number | null, openEnded: boolean,
): string | null {
  if (openEnded || !effective || !termMonths || termMonths <= 0) return null
  const d = parseISODate(effective)
  // ⚠️ A DATE THAT DOES NOT EXIST MUST NOT SILENTLY BECOME A DIFFERENT ONE.
  // `new Date(2026, 1, 30)` is March 2nd, so '2026-02-30' would quietly produce a
  // term measured from a day the owner never chose. Refuse instead.
  if (toISODate(d) !== effective) return null

  const target = new Date(d.getFullYear(), d.getMonth() + termMonths, d.getDate())
  if (target.getDate() !== d.getDate()) {
    // ⭐ THE ANNIVERSARY DOES NOT EXIST IN THAT MONTH (Jan 31 + 1 month). Clamping
    // to the month's last day IS the end of the term — the day before it would be
    // subtracting twice, and turned a one-month agreement from Jan 31 into one
    // that ended Feb 27.
    target.setDate(0)
  } else {
    // A term runs UP TO the day before the anniversary: a 12-month agreement
    // starting Jan 1 ends Dec 31, not Jan 1 of the next year.
    // setDate() rather than millisecond arithmetic, so a DST shift inside the
    // term cannot move the answer.
    target.setDate(target.getDate() - 1)
  }
  return toISODate(target)
}

export function termLabel(c: Pick<ContractRecord, 'effective_date' | 'end_date'>): string {
  if (!c.effective_date) return 'Term not set'
  if (!c.end_date) return `From ${c.effective_date} · open-ended`
  return `${c.effective_date} → ${c.end_date}`
}

// ── Derived status ───────────────────────────────────────────────────────────

/**
 * ⭐⭐ THE definition of an expired contract, and the twin of the database's
 * `contract_is_expired`. Expiry is DERIVED on every read: a stored flag would be
 * wrong the morning after it was written, and would need a cron job to stay
 * honest. verify:contracts pins this function and the SQL one to the same rule.
 *
 * Only a LIVE agreement can lapse — a draft was never in force, and terminated
 * or superseded already have a truer word for what happened.
 */
export function isExpired(
  c: Pick<ContractRecord, 'status' | 'end_date'>, today = new Date(),
): boolean {
  return c.status === 'active' && !!c.end_date && daysUntil(c.end_date, today) < 0
}

export function displayStatus(
  c: Pick<ContractRecord, 'status' | 'end_date'>, today = new Date(),
): ContractDisplayStatus {
  return isExpired(c, today) ? 'expired' : c.status
}

// ── Renewal awareness ────────────────────────────────────────────────────────
//
// ⭐⭐ THIS IS NOT SESSION 53'S ENGINE, AND MUST NEVER BECOME IT. `lib/signals/
// renewal.ts` answers a question about an OPERATIONAL PLAN: a recurring series
// reached the end of its cycle, so offer the next one. It reads cadence, season
// definitions and delivered visits.
//
// This function answers a different question with different inputs: a COMMERCIAL
// TERM has an end date, and the owner asked to be told before it arrives. It
// reads `end_date` and `renewal_notice_days` and NOTHING ELSE — no cadence, no
// season, no visit history, no recurrence. That is exactly why the two can
// coexist: a contract can be expiring while its recurrence is mid-season, and
// both statements are true at once.

export type RenewalState =
  | { state: 'none' }
  | { state: 'open_ended' }
  | { state: 'expiring_soon'; days: number }
  | { state: 'expired'; days: number }

/** Default notice window when the owner set none. Small, and overridable per
 *  contract — not a policy this product is entitled to decide for them. */
export const DEFAULT_RENEWAL_NOTICE_DAYS = 30

export function renewalState(
  c: Pick<ContractRecord, 'status' | 'end_date' | 'renewal_notice_days'>,
  today = new Date(),
): RenewalState {
  if (c.status !== 'active') return { state: 'none' }
  if (!c.end_date) return { state: 'open_ended' }
  const days = daysUntil(c.end_date, today)
  if (days < 0) return { state: 'expired', days }
  const notice = c.renewal_notice_days ?? DEFAULT_RENEWAL_NOTICE_DAYS
  return days <= notice ? { state: 'expiring_soon', days } : { state: 'none' }
}

export function renewalLabel(r: RenewalState): string | null {
  switch (r.state) {
    case 'expiring_soon':
      return r.days === 0 ? 'Ends today' : r.days === 1 ? 'Ends tomorrow' : `Ends in ${r.days} days`
    case 'expired':
      return `Ended ${Math.abs(r.days)} ${Math.abs(r.days) === 1 ? 'day' : 'days'} ago`
    default:
      return null
  }
}

export function toView(row: ContractRecord, signatures?: DocumentSignature[], today = new Date()): ContractView {
  const signed = !!row.signature_request_id
    && !!signatures?.some(s => s.request_id === row.signature_request_id)
  return {
    ...row,
    display: displayStatus(row, today),
    termLabel: termLabel(row),
    renewal: renewalState(row, today),
    signed,
  }
}

// ── Rendering the agreement ──────────────────────────────────────────────────
//
// ⭐ The template body is the BUSINESS MEANING; the rendered result becomes a
// Session 74 document version and is immutable from that moment. Placeholders
// are deliberately generic — nothing here knows what trade the owner is in.

export interface ContractVars {
  customer_name?: string | null
  business_name?: string | null
  property_address?: string | null
  contract_title?: string | null
  contract_type?: string | null
  effective_date?: string | null
  end_date?: string | null
}

export const CONTRACT_PLACEHOLDERS = [
  'customer_name', 'business_name', 'property_address',
  'contract_title', 'contract_type', 'effective_date', 'end_date',
] as const

/**
 * Fill `{{placeholder}}` tokens. An unknown token is LEFT AS WRITTEN rather than
 * blanked: a contract that silently drops a phrase the owner typed is worse than
 * one that visibly shows an unfilled field before it is ever sent.
 */
export function renderContractBody(body: string, vars: ContractVars): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const k = key.toLowerCase() as keyof ContractVars
    const v = vars[k]
    if (v === undefined) return whole
    return v === null || v === '' ? '—' : String(v)
  })
}

/** Open-ended is stated in words, because a blank end date reads as an omission. */
export function contractHeader(title: string, type: string | null, vars: ContractVars): string {
  const lines = [
    title,
    type ? `(${type})` : null,
    '',
    vars.business_name ? `Business: ${vars.business_name}` : null,
    vars.customer_name ? `Customer: ${vars.customer_name}` : null,
    vars.property_address ? `Service location: ${vars.property_address}` : null,
    vars.effective_date ? `Effective: ${vars.effective_date}` : null,
    `Ends: ${vars.end_date || 'open-ended (no end date)'}`,
    '',
    '───────────────────────────────────────────',
    '',
  ]
  return lines.filter(l => l !== null).join('\n')
}

/**
 * The full text that becomes the artifact.
 *
 * ⭐ V1 renders `text/plain`, which is already in Session 74's accepted types.
 * That is a deliberate choice over adding a PDF dependency: the immutable thing
 * must be the thing the customer read, and a text version is exactly that with
 * no rendering engine in between to disagree about. The seam for a richer format
 * is `contractFile` — swap the blob type there and nothing else changes.
 */
export function contractText(
  title: string, type: string | null, body: string, vars: ContractVars,
): string {
  return contractHeader(title, type, vars) + renderContractBody(body, vars)
}

function safeFileName(title: string): string {
  const base = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 60)
  return `${base || 'contract'}.txt`
}

/** The rendered agreement as a File, ready for Session 74's uploader. */
export function contractFile(title: string, text: string): File {
  return new File([text], safeFileName(title), { type: 'text/plain' })
}

// ── Reads ────────────────────────────────────────────────────────────────────

const SELECT = '*'

export async function listContracts(
  sb: SupabaseClient, userId: string, opts?: { customerId?: string },
): Promise<ContractRecord[]> {
  let q = sb.from('contracts').select(SELECT).eq('user_id', userId)
  if (opts?.customerId) q = q.eq('customer_id', opts.customerId)
  const { data, error } = await q.order('created_at', { ascending: false })
  // ⭐ A failed read is NOT an empty list. Callers must be able to say "couldn't
  // load" rather than inventing "no contracts" — the false-all-clear rule.
  if (error) throw new Error(error.message)
  return (data as ContractRecord[]) || []
}

export async function getContract(
  sb: SupabaseClient, id: string,
): Promise<ContractRecord | null> {
  const { data, error } = await sb.from('contracts').select(SELECT).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as ContractRecord) || null
}

export async function listTemplates(
  sb: SupabaseClient, userId: string, opts?: { includeArchived?: boolean },
): Promise<ContractTemplate[]> {
  let q = sb.from('contract_templates').select('*').eq('user_id', userId)
  if (!opts?.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q.order('name')
  if (error) throw new Error(error.message)
  return (data as ContractTemplate[]) || []
}

/** The signatures behind a set of contracts, for `signed` on the view. */
export async function contractSignatures(
  sb: SupabaseClient, requestIds: string[],
): Promise<DocumentSignature[]> {
  const ids = requestIds.filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await sb
    .from('document_signatures').select('*').in('request_id', ids)
  if (error) throw new Error(error.message)
  return (data as DocumentSignature[]) || []
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface NewContractInput {
  userId: string
  template?: ContractTemplate | null
  customerId: string
  propertyId?: string | null
  jobId?: string | null
  quoteId?: string | null
  jobRecurrenceId?: string | null
  serviceTemplateId?: string | null
  title: string
  contractType: string | null
  effectiveDate: string | null
  endDate: string | null
  renewalNoticeDays: number | null
  signatureRequired: boolean
}

/**
 * Create a DRAFT. No document exists yet — the artifact is only minted when the
 * owner sends, so a draft can be edited freely without anything immutable
 * hanging off it.
 *
 * ⭐ `template_name` is COPIED here, exactly the way job_forms copies its
 * template name: renaming or deleting the template later must never restate what
 * this contract was made from.
 */
export async function createContract(
  sb: SupabaseClient, input: NewContractInput,
): Promise<{ contract?: ContractRecord; error?: string }> {
  const { data, error } = await sb.from('contracts').insert({
    user_id: input.userId,
    template_id: input.template?.id ?? null,
    template_name: input.template?.name ?? null,
    customer_id: input.customerId,
    property_id: input.propertyId ?? null,
    job_id: input.jobId ?? null,
    quote_id: input.quoteId ?? null,
    job_recurrence_id: input.jobRecurrenceId ?? null,
    service_template_id: input.serviceTemplateId ?? null,
    title: input.title.trim(),
    contract_type: input.contractType,
    status: 'draft',
    signature_required: input.signatureRequired,
    effective_date: input.effectiveDate,
    end_date: input.endDate,
    renewal_notice_days: input.renewalNoticeDays,
    created_by: input.userId,
  }).select(SELECT).single()
  // The database raises readable messages for every refusal here (foreign
  // customer, foreign recurrence, term out of order) — surface them rather than
  // replacing them with something generic.
  if (error || !data) return { error: error?.message ?? 'Could not create the contract.' }
  return { contract: data as ContractRecord }
}

/**
 * SEND — the moment the agreement becomes a thing that exists outside EdgeHQ.
 *
 * ⭐⭐ This is the whole document-generation adapter, and it creates NOTHING of
 * its own: it renders the text, hands it to Session 74's `uploadDocument`, and
 * records which document + version the contract now IS. Session 74's own
 * immutability triggers do the rest — from here on the bytes cannot change, so
 * a later template edit cannot rewrite what was sent.
 *
 * The document is created with `customer` visibility against the CUSTOMER entity
 * so Session 74's portal projection can show it. It is deliberately not attached
 * to the job even when a job is linked: the agreement is with the customer, and
 * a job-linked document would become visible to the crew on that visit.
 */
export async function sendContract(
  sb: SupabaseClient,
  opts: {
    userId: string
    contract: ContractRecord
    template: ContractTemplate | null
    vars: ContractVars
    body: string
    statement: string
    purpose: SignaturePurpose
  },
): Promise<{ error?: string; documentId?: string; versionId?: string }> {
  if (opts.contract.status !== 'draft') {
    return { error: 'Only a draft contract can be sent.' }
  }
  // ⭐ The document states the term, so the term must exist before it is written.
  // The database enforces this too; saying it here names the actual problem.
  if (!opts.contract.effective_date) {
    return { error: 'Set the effective date before sending — the agreement states it.' }
  }

  const text = contractText(opts.contract.title, opts.contract.contract_type, opts.body, opts.vars)
  const file = contractFile(opts.contract.title, text)

  const up = await uploadDocument(sb, {
    userId: opts.userId,
    entity: { kind: 'customer', id: opts.contract.customer_id },
    file,
    name: opts.contract.title,
    category: opts.contract.contract_type || 'Contract',
    visibility: 'customer',
  })
  if (up.error || !up.document) return { error: up.error ?? 'Could not create the document.' }

  const version = up.document.current
  if (!version) return { error: 'The document was created without a version.' }

  // The signature request is Session 74's, pinned to this exact version.
  let requestId: string | null = null
  if (opts.contract.signature_required) {
    const req = await requestSignature(sb, {
      documentId: up.document.id,
      versionId: version.id,
      customerId: opts.contract.customer_id,
      statement: opts.statement,
      purpose: opts.purpose,
      requestedBy: opts.userId,
    })
    if (req.error || !req.request) return { error: req.error ?? 'Could not request the signature.' }
    requestId = req.request.id
  }

  const { error } = await sb.from('contracts').update({
    status: 'sent',
    document_id: up.document.id,
    document_version_id: version.id,
    signature_request_id: requestId,
    sent_at: new Date().toISOString(),
  }).eq('id', opts.contract.id)
  if (error) return { error: error.message }

  return { documentId: up.document.id, versionId: version.id }
}

/**
 * ACTIVATE. The database refuses this unless the acceptance condition is met, so
 * this is not the gate — it is the request to walk through it. A contract that
 * requires a signature becomes active when the customer signs, never because a
 * screen said so.
 *
 * ⭐ It deliberately does NOT set the effective date. The term is fixed before
 * sending, because the document the customer signs states it; setting it here
 * would edit the term of an already-signed contract, which the database refuses
 * outright — and rightly, since the signed page would then disagree with the
 * record.
 */
export async function activateContract(
  sb: SupabaseClient, id: string,
): Promise<{ error?: string }> {
  const { error } = await sb.from('contracts')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('id', id)
  return error ? { error: error.message } : {}
}

export async function terminateContract(
  sb: SupabaseClient, id: string, reason: string,
): Promise<{ error?: string }> {
  const { error } = await sb.from('contracts').update({
    status: 'terminated',
    terminated_at: new Date().toISOString(),
    termination_reason: reason.trim() || null,
  }).eq('id', id)
  return error ? { error: error.message } : {}
}

/**
 * SUPERSEDE — replace an agreement without touching the old one.
 *
 * ⭐⭐ The previous contract is PRESERVED, signature and all, and simply points
 * forward. This is the answer to "the terms changed after signing": never an
 * edit, always a successor. The old row's guard trigger refuses the edit anyway,
 * so this is the only path that exists.
 *
 * ⛔ It deliberately does not touch `job_recurrence_id` on the old contract, and
 * it never changes a recurrence. Relinking the operational series is a separate,
 * explicit owner action through the recurrence engine.
 */
export async function supersedeContract(
  sb: SupabaseClient, oldId: string, newId: string,
): Promise<{ error?: string }> {
  const { error } = await sb.from('contracts')
    .update({ status: 'superseded', superseded_by_id: newId })
    .eq('id', oldId)
  return error ? { error: error.message } : {}
}

/** Replace a DRAFT's rendered body by adding a Session 74 version. Only ever
 *  reachable before sending — after that the artifact is frozen by S74. */
export async function addContractVersion(
  sb: SupabaseClient,
  opts: { userId: string; documentId: string; title: string; text: string; note?: string },
): Promise<{ version?: DocumentVersion; error?: string }> {
  return addVersion(sb, {
    userId: opts.userId,
    documentId: opts.documentId,
    file: contractFile(opts.title, opts.text),
    note: opts.note,
  })
}
