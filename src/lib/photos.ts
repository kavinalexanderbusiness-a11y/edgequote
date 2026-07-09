import type { SupabaseClient } from '@supabase/supabase-js'
import { JobPhoto, PhotoKind } from '@/types'

// ── Job / property photos engine ──────────────────────────────────────────
// ONE storage pattern (mirrors the Settings logo upload): files go in the
// public `job-photos` bucket under <user_id>/<property_id>/<name>; the
// job_photos table is the catalogue. Public bucket → a plain getPublicUrl is
// enough to render (and could be dropped into a PDF later). Writes are still
// owner-scoped by the storage policies (first path segment = uploader's id).

export const PHOTO_BUCKET = 'job-photos'

// A catalogue row plus its resolved public URL (the bucket is public, so this
// is a cheap synchronous lookup — we never store the URL in the DB, only the
// path, so the bucket can be renamed/migrated without a data backfill).
export interface JobPhotoView extends JobPhoto {
  url: string
}

function publicUrl(supabase: SupabaseClient, path: string): string {
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

function withUrl(supabase: SupabaseClient, rows: JobPhoto[]): JobPhotoView[] {
  return rows.map(r => ({ ...r, url: publicUrl(supabase, r.storage_path) }))
}

// A single gallery never needs a property's/job's ENTIRE history — cap it so a
// property with hundreds of visits can't pull thousands of rows into one gallery.
const GALLERY_LIMIT = 300

// List photos for a single visit (when jobId is given) or for the whole
// property (its full visual service history). Newest first, bounded.
export async function listPhotos(
  supabase: SupabaseClient,
  userId: string,
  scope: { jobId?: string | null; propertyId?: string | null },
): Promise<JobPhotoView[]> {
  let q = supabase.from('job_photos').select('*').eq('user_id', userId)
  if (scope.jobId) q = q.eq('job_id', scope.jobId)
  else if (scope.propertyId) q = q.eq('property_id', scope.propertyId)
  else return []
  const { data } = await q.order('taken_at', { ascending: false }).limit(GALLERY_LIMIT)
  return withUrl(supabase, (data as JobPhoto[]) || [])
}

// Downscale a phone photo before upload so the gallery loads fast and storage
// stays small. Falls back to the original file on any failure (unsupported
// format, no canvas, etc.) — never blocks an upload over a resize hiccup.
async function downscale(file: File, maxDim = 1600, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/') || typeof document === 'undefined') return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) { bitmap.close?.(); return file } // already small enough
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close?.(); return file }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality))
    return blob || file
  } catch {
    return file
  }
}

// Upload one photo: resize → store in the bucket → catalogue row. Returns the
// new row (with URL) so the caller can prepend it optimistically.
export interface UploadPhotoOpts {
  userId: string
  file: File
  propertyId: string | null
  jobId?: string | null
  customerId?: string | null
  kind: PhotoKind
  caption?: string | null
  takenAt?: string | null      // ISO capture time (from EXIF) — drives before/after ordering
  contentHash?: string | null  // visual hash (lib/dedup) — durable duplicate detection
  // Offline replay support: a STABLE client-generated id makes the storage path
  // deterministic, so replaying a queued upload can't create a second file/row.
  uploadId?: string
  // Fresh online capture (brand-new uploadId) → skip the pre-upload dedup SELECT.
  skipExistingCheck?: boolean
}

export async function uploadPhoto(
  supabase: SupabaseClient,
  opts: UploadPhotoOpts,
): Promise<JobPhotoView | null> {
  // Deterministic name from the stable uploadId (or a fresh stamp for the online path).
  const key = opts.uploadId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const path = `${opts.userId}/${opts.propertyId ?? 'unassigned'}/${key}.jpg`

  // Idempotency (replay / multi-tab): if this exact object is already catalogued,
  // return it instead of uploading again. The path is derived from uploadId, so this
  // dedupes on storage_path with no schema change. Skipped on a fresh online capture
  // (the id is new → nothing to find) so the common path is one round-trip lighter.
  if (opts.uploadId && !opts.skipExistingCheck) {
    const { data: existing } = await supabase.from('job_photos').select('*')
      .eq('user_id', opts.userId).eq('storage_path', path).maybeSingle()
    if (existing) return { ...(existing as JobPhoto), url: publicUrl(supabase, path) }
  }

  const blob = await downscale(opts.file)
  const { error: upErr } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { upsert: !!opts.uploadId, contentType: 'image/jpeg' })
  if (upErr) return null

  const row: Record<string, unknown> = {
    user_id: opts.userId,
    job_id: opts.jobId ?? null,
    property_id: opts.propertyId,
    customer_id: opts.customerId ?? null,
    storage_path: path,
    kind: opts.kind,
    caption: opts.caption ?? null,
    ...(opts.takenAt ? { taken_at: opts.takenAt } : {}),
  }
  // Stamp the real capture time so the Studio's "earliest before / latest after"
  // ordering is honest (defaults to now() when EXIF is absent).
  if (opts.takenAt) row.taken_at = opts.takenAt
  if (opts.contentHash) row.content_hash = opts.contentHash
  let { data, error } = await supabase.from('job_photos').insert(row).select('*').single()
  // content_hash is from the 2026-07-02 migration — retry without it when the
  // column doesn't exist yet (dedup degrades to session-only, upload still works).
  if (error && opts.contentHash && /content_hash/i.test(error.message || '')) {
    delete row.content_hash
    ;({ data, error } = await supabase.from('job_photos').insert(row).select('*').single())
  }
  if (error || !data) {
    // Roll back the orphaned file so storage never drifts from the catalogue.
    await supabase.storage.from(PHOTO_BUCKET).remove([path])
    return null
  }
  return { ...(data as JobPhoto), url: publicUrl(supabase, path) }
}

// Upload many photos AT ONCE (parallel) — each compresses + catalogues independently
// via uploadPhoto, so one slow/failed file never blocks the others. Returns the rows
// that succeeded (nulls dropped), preserving input order for the successes.
export async function uploadPhotos(
  supabase: SupabaseClient,
  items: UploadPhotoOpts[],
): Promise<(JobPhotoView | null)[]> {
  return Promise.all(items.map(it => uploadPhoto(supabase, it)))
}

// Update a photo's caption or before/after tag. Returns whether the write landed so
// the caller can roll back an optimistic UI change on failure.
export async function updatePhoto(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<JobPhoto, 'kind' | 'caption'>>,
): Promise<boolean> {
  const { error } = await supabase.from('job_photos').update(patch).eq('id', id)
  return !error
}

// Delete a photo — removes both the catalogue row and the stored file. Returns whether
// the catalogue delete succeeded (the file is only removed once the row is gone).
export async function deletePhoto(supabase: SupabaseClient, photo: JobPhoto): Promise<boolean> {
  const { error } = await supabase.from('job_photos').delete().eq('id', photo.id)
  if (error) return false
  await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path])
  return true
}
