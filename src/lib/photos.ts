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

// List photos for a single visit (when jobId is given) or for the whole
// property (its full visual service history). Newest first.
export async function listPhotos(
  supabase: SupabaseClient,
  userId: string,
  scope: { jobId?: string | null; propertyId?: string | null },
): Promise<JobPhotoView[]> {
  let q = supabase.from('job_photos').select('*').eq('user_id', userId)
  if (scope.jobId) q = q.eq('job_id', scope.jobId)
  else if (scope.propertyId) q = q.eq('property_id', scope.propertyId)
  else return []
  const { data } = await q.order('taken_at', { ascending: false })
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
export async function uploadPhoto(
  supabase: SupabaseClient,
  opts: {
    userId: string
    file: File
    propertyId: string | null
    jobId?: string | null
    customerId?: string | null
    kind: PhotoKind
    caption?: string | null
    // Offline support: a STABLE client-generated id makes the storage path
    // deterministic, so replaying a queued upload can never create a second file
    // or catalogue row (idempotent). `takenAt` preserves the capture time even when
    // the photo syncs hours later. Both optional → the online path is unchanged.
    uploadId?: string
    takenAt?: string
  },
): Promise<JobPhotoView | null> {
  // Deterministic name from the stable uploadId (or a fresh stamp for the online path).
  const key = opts.uploadId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const path = `${opts.userId}/${opts.propertyId ?? 'unassigned'}/${key}.jpg`

  // Idempotency (replay / multi-tab): if this exact object is already catalogued,
  // return it instead of uploading again. The path is derived from uploadId, so this
  // dedupes on storage_path with no schema change.
  if (opts.uploadId) {
    const { data: existing } = await supabase.from('job_photos').select('*')
      .eq('user_id', opts.userId).eq('storage_path', path).maybeSingle()
    if (existing) return { ...(existing as JobPhoto), url: publicUrl(supabase, path) }
  }

  const blob = await downscale(opts.file)
  const { error: upErr } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { upsert: !!opts.uploadId, contentType: 'image/jpeg' })
  if (upErr) return null

  const row = {
    user_id: opts.userId,
    job_id: opts.jobId ?? null,
    property_id: opts.propertyId,
    customer_id: opts.customerId ?? null,
    storage_path: path,
    kind: opts.kind,
    caption: opts.caption ?? null,
    ...(opts.takenAt ? { taken_at: opts.takenAt } : {}),
  }
  const { data, error } = await supabase.from('job_photos').insert(row).select('*').single()
  if (error || !data) {
    // Roll back the orphaned file so storage never drifts from the catalogue.
    await supabase.storage.from(PHOTO_BUCKET).remove([path])
    return null
  }
  return { ...(data as JobPhoto), url: publicUrl(supabase, path) }
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
