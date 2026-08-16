import type { SupabaseClient } from '@supabase/supabase-js'

// ── Documents: the ONE place that knows the bucket ───────────────────────────
//
// Mirrors lib/equipmentDocs deliberately — same private-bucket shape, same
// owner-scoped path rule, same "remove the object if the row didn't land"
// discipline. Components call these; they never build a path or mint a URL, so
// the `<user_id>/…` rule the storage policies enforce cannot be broken from a
// component by accident.
//
// ⛔ NOT a second file subsystem. Photos stay in lib/photos (job-photos, PUBLIC,
// proof of work). Crew reference media stays in lib/crewMedia. Receipts stay in
// lib/accounting/receipts. This is the durable-paperwork lane: the permit, the
// warranty, the signed authorization — files a business must still be able to
// produce in a year.
//
// ⭐ THE BOUNDARY WITH FORMS (Session 69): Forms owns what happened during the
// visit — checklist items, per-field answers, their photos. Documents owns the
// durable FILE and the signed acknowledgement. If a form must one day produce a
// permanent artefact, it renders a file and creates a `documents` row; it never
// stores answers here, and nothing here knows what a checklist item is.

export const DOCUMENTS_BUCKET = 'documents'

/** Matches the bucket's own file_size_limit (25 MiB). Checked before upload so
 *  an oversize file is a clear message, not an opaque storage error. */
export const DOCUMENT_MAX_BYTES = 26214400

export const DOCUMENT_ACCEPT = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export type DocumentVisibility = 'internal' | 'worker' | 'customer'

export type SignaturePurpose =
  | 'work_authorization'
  | 'customer_acknowledgement'
  | 'completion_acknowledgement'

/** The four records a document can belong to. Exactly one, enforced by the
 *  documents_one_entity CHECK — this type is the app-side mirror of it. */
export type DocumentEntity =
  | { kind: 'customer'; id: string }
  | { kind: 'property'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'equipment'; id: string }

export interface DocumentVersion {
  id: string
  document_id: string
  version_no: number
  storage_path: string
  file_name: string
  mime: string | null
  size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string
  replaced_note: string | null
}

export interface DocumentSignature {
  id: string
  document_id: string
  version_id: string
  customer_id: string
  signer_name: string
  statement: string
  purpose: SignaturePurpose
  source: 'portal' | 'dashboard'
  signed_at: string
}

export interface DocumentSignatureRequest {
  id: string
  document_id: string
  version_id: string
  customer_id: string
  statement: string
  purpose: SignaturePurpose
  requested_at: string
  cancelled_at: string | null
}

export interface DocumentRecord {
  id: string
  user_id: string
  name: string
  category: string | null
  customer_id: string | null
  property_id: string | null
  job_id: string | null
  equipment_id: string | null
  visibility: DocumentVisibility
  archived_at: string | null
  created_at: string
  document_versions?: DocumentVersion[]
  document_signature_requests?: DocumentSignatureRequest[]
  document_signatures?: DocumentSignature[]
}

/** What the owner surface actually renders: the record plus the derived facts. */
export interface DocumentView extends DocumentRecord {
  current: DocumentVersion | null
  signature: DocumentSignature | null
  openRequest: DocumentSignatureRequest | null
  /** True once anything has been signed — the UI uses this to explain why
   *  content can no longer be swapped, rather than silently disabling a control. */
  frozen: boolean
}

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Suggestions, never a closed list: `category` is free text in the schema
// because EdgeHQ serves whatever trade the owner runs, and an enum of lawn-care
// paperwork would be wrong for an electrician on day one.
export const DOCUMENT_CATEGORIES = [
  'Work authorization',
  'Permit',
  'Inspection report',
  'Warranty',
  'Site document',
  'Completion acknowledgement',
  'Customer document',
  'Equipment documentation',
  'Insurance',
  'Other',
] as const

export const VISIBILITY_LABEL: Record<DocumentVisibility, string> = {
  internal: 'Internal only',
  worker: 'Visible to the crew',
  customer: 'Shared with the customer',
}

/** Plain-language, so an owner choosing a level knows exactly who gains sight. */
export const VISIBILITY_HELP: Record<DocumentVisibility, string> = {
  internal: 'Only you can see this. Nobody else in the product can reach it.',
  worker: 'The crew assigned to this visit can open it on their phone.',
  customer: 'The customer can view and download it from their portal.',
}

export const PURPOSE_LABEL: Record<SignaturePurpose, string> = {
  work_authorization: 'Work authorization',
  customer_acknowledgement: 'Customer acknowledgement',
  completion_acknowledgement: 'Completion acknowledgement',
}

/** Starting wording for the sentence the customer agrees to. The owner edits it
 *  — the statement is the MEANING of the signature, so it must be theirs, not a
 *  phrase the product put in their mouth. */
export const PURPOSE_STATEMENT: Record<SignaturePurpose, string> = {
  work_authorization:
    'I authorize the work described in this document to be carried out at my property.',
  customer_acknowledgement:
    'I confirm that I have received and read this document.',
  completion_acknowledgement:
    'I confirm that the work described in this document has been completed to my satisfaction.',
}

// ── Paths ────────────────────────────────────────────────────────────────────
// ⭐ The first segment IS the tenant uid. That is the whole storage policy, so
// it is built here once and never assembled in a component.

function safeName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80) || 'file'
}

export function documentPath(userId: string, documentId: string, fileName: string): string {
  return `${userId}/${documentId}/${crypto.randomUUID()}-${safeName(fileName)}`
}

/** Signature marks live beside the document they belong to, behind the same
 *  private door. Never inline in a row, never in audit metadata. */
export function signaturePath(userId: string, documentId: string, requestId: string): string {
  return `${userId}/${documentId}/signatures/${requestId}-${crypto.randomUUID()}.png`
}

// ── Derivation ───────────────────────────────────────────────────────────────

/** Highest version_no wins. The schema stores no current_version_id on purpose:
 *  a derived answer cannot drift out of sync with the rows it points at. */
export function currentVersion(versions: DocumentVersion[] | undefined): DocumentVersion | null {
  if (!versions || versions.length === 0) return null
  return versions.reduce((a, b) => (b.version_no > a.version_no ? b : a))
}

export function toView(row: DocumentRecord): DocumentView {
  const current = currentVersion(row.document_versions)
  const signatures = row.document_signatures ?? []
  // The signature that matters is the newest one recorded.
  const signature = signatures.length
    ? signatures.reduce((a, b) => (b.signed_at > a.signed_at ? b : a))
    : null
  const signedRequestIds = new Set(signatures.map(s => (s as { request_id?: string }).request_id))
  const openRequest = (row.document_signature_requests ?? []).find(
    r => !r.cancelled_at && !signedRequestIds.has(r.id),
  ) ?? null
  return { ...row, current, signature, openRequest, frozen: signatures.length > 0 }
}

const SELECT =
  '*, document_versions(*), document_signature_requests(*), document_signatures(*)'

function entityColumn(kind: DocumentEntity['kind']): string {
  return `${kind}_id`
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Every document filed against one record. Archived rows are included and
 *  flagged — the owner keeps their history; only the portal and crew lose sight
 *  of an archived document. */
export async function listDocuments(
  sb: SupabaseClient,
  userId: string,
  entity: DocumentEntity,
): Promise<DocumentView[]> {
  const { data, error } = await sb
    .from('documents')
    .select(SELECT)
    .eq('user_id', userId)
    .eq(entityColumn(entity.kind), entity.id)
    .order('created_at', { ascending: false })
  // ⭐ A failed read is NOT an empty list. Callers distinguish so a surface can
  // say "couldn't load" instead of inventing "no documents" — the false-all-clear
  // rule this codebase learned the hard way.
  if (error) throw new Error(error.message)
  return ((data as DocumentRecord[]) || []).map(toView)
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function uploadDocument(
  sb: SupabaseClient,
  opts: {
    userId: string
    entity: DocumentEntity
    file: File
    name: string
    category: string | null
    visibility: DocumentVisibility
  },
): Promise<{ document?: DocumentView; error?: string }> {
  const guard = fileProblem(opts.file)
  if (guard) return { error: guard }

  const { data: doc, error: docErr } = await sb
    .from('documents')
    .insert({
      user_id: opts.userId,
      name: opts.name.trim() || opts.file.name,
      category: opts.category,
      visibility: opts.visibility,
      created_by: opts.userId,
      [entityColumn(opts.entity.kind)]: opts.entity.id,
    })
    .select('id')
    .single()
  if (docErr || !doc) return { error: docErr?.message ?? 'Could not create the document.' }

  const documentId = (doc as { id: string }).id
  const added = await addVersion(sb, { userId: opts.userId, documentId, file: opts.file })
  if (added.error) {
    // The document row would otherwise exist with no content at all — a ghost in
    // every list that can never be opened.
    await sb.from('documents').delete().eq('id', documentId)
    return { error: added.error }
  }

  const { data: full } = await sb.from('documents').select(SELECT).eq('id', documentId).single()
  return { document: full ? toView(full as DocumentRecord) : undefined }
}

/** Replacing content is ALWAYS a new version — the schema refuses anything else,
 *  and this is the only path that exists to add one. */
export async function addVersion(
  sb: SupabaseClient,
  opts: { userId: string; documentId: string; file: File; note?: string },
): Promise<{ version?: DocumentVersion; error?: string }> {
  const guard = fileProblem(opts.file)
  if (guard) return { error: guard }

  const path = documentPath(opts.userId, opts.documentId, opts.file.name)
  const { error: upErr } = await sb.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, opts.file, { upsert: false, contentType: opts.file.type || undefined })
  if (upErr) return { error: upErr.message }

  const { data, error } = await sb
    .from('document_versions')
    .insert({
      document_id: opts.documentId,
      // user_id and version_no are assigned by the database — see
      // document_versions_assign_no. Two racing uploads cannot collide on a
      // number neither of them computed.
      storage_path: path,
      file_name: opts.file.name,
      mime: opts.file.type || null,
      size_bytes: opts.file.size ?? null,
      uploaded_by: opts.userId,
      replaced_note: opts.note ?? null,
    })
    .select('*')
    .single()

  if (error || !data) {
    // Never leave an orphan object behind if the row didn't land — an orphaned
    // private file is a privacy liability, not clutter.
    await sb.storage.from(DOCUMENTS_BUCKET).remove([path])
    return { error: error?.message ?? 'Could not save the document.' }
  }
  return { version: data as DocumentVersion }
}

/** Short-lived signed URL. The bucket is private, so this is the only way in. */
export async function signedDocumentUrl(
  sb: SupabaseClient,
  storagePath: string,
  seconds = 60,
): Promise<string | null> {
  const { data } = await sb.storage.from(DOCUMENTS_BUCKET).createSignedUrl(storagePath, seconds)
  return data?.signedUrl ?? null
}

export async function setVisibility(
  sb: SupabaseClient,
  documentId: string,
  visibility: DocumentVisibility,
): Promise<{ error?: string }> {
  const { error } = await sb.from('documents').update({ visibility }).eq('id', documentId)
  return error ? { error: error.message } : {}
}

/** Archiving is not deletion. A signed document must stay retrievable forever;
 *  archiving only removes it from the portal and the crew phone. */
export async function setArchived(
  sb: SupabaseClient,
  documentId: string,
  archived: boolean,
): Promise<{ error?: string }> {
  const { error } = await sb
    .from('documents')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', documentId)
  return error ? { error: error.message } : {}
}

export async function requestSignature(
  sb: SupabaseClient,
  opts: {
    documentId: string
    versionId: string
    customerId: string
    statement: string
    purpose: SignaturePurpose
    requestedBy: string
  },
): Promise<{ request?: DocumentSignatureRequest; error?: string }> {
  const { data, error } = await sb
    .from('document_signature_requests')
    .insert({
      document_id: opts.documentId,
      version_id: opts.versionId,
      customer_id: opts.customerId,
      statement: opts.statement.trim(),
      purpose: opts.purpose,
      requested_by: opts.requestedBy,
    })
    .select('*')
    .single()
  // The database raises readable messages for every refusal here (not shared with
  // the customer, wrong customer, archived, stale version) — surface them rather
  // than replacing them with a generic failure.
  if (error || !data) return { error: error?.message ?? 'Could not request the signature.' }
  return { request: data as DocumentSignatureRequest }
}

export async function cancelSignatureRequest(
  sb: SupabaseClient,
  requestId: string,
): Promise<{ error?: string }> {
  const { error } = await sb
    .from('document_signature_requests')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', requestId)
  return error ? { error: error.message } : {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileProblem(file: File): string | null {
  if (!file.size) return 'That file is empty.'
  if (file.size > DOCUMENT_MAX_BYTES) {
    return `That file is ${sizeLabel(file.size)}. The limit is ${sizeLabel(DOCUMENT_MAX_BYTES)}.`
  }
  // The bucket enforces this too; checking here turns a storage error into a
  // sentence that names the actual problem.
  if (file.type && !(DOCUMENT_ACCEPT as readonly string[]).includes(file.type)) {
    return 'That file type is not supported. Use a PDF, an image, or an Office document.'
  }
  return null
}

export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
