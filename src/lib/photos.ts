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

// A small server-rendered thumbnail for GRID tiles, via Supabase Storage image
// transforms (enabled on this project). A 480² tile is ~65KB vs ~1MB for the full
// image — so a 30-photo gallery pulls ~2MB instead of ~30MB. Rewrites a public object
// URL to the render endpoint; returns the URL unchanged if it isn't a storage URL, so
// callers can pass any candidate photo URL safely. Always keep the full `url` for the
// lightbox / export — thumbnails are display-only.
export function thumbUrl(url: string, w = 480, h = 480): string {
  if (!url || !url.includes('/storage/v1/object/public/')) return url
  const base = url.split('?')[0].replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
  return `${base}?width=${w}&height=${h}&resize=cover&quality=72`
}

function withUrl(supabase: SupabaseClient, rows: JobPhoto[]): JobPhotoView[] {
  return rows.map(r => ({ ...r, url: publicUrl(supabase, r.storage_path) }))
}

// List photos for a single visit (when jobId is given) or for the whole
// property (its full visual service history). Newest first. `limit` bounds the
// pull so a property with hundreds of photos doesn't fetch its entire history
// (and silently hit Supabase's 1000-row ceiling) on open.
export async function listPhotos(
  supabase: SupabaseClient,
  userId: string,
  scope: { jobId?: string | null; propertyId?: string | null; limit?: number },
): Promise<JobPhotoView[]> {
  let q = supabase.from('job_photos').select('*').eq('user_id', userId)
  if (scope.jobId) q = q.eq('job_id', scope.jobId)
  else if (scope.propertyId) q = q.eq('property_id', scope.propertyId)
  else return []
  q = q.order('taken_at', { ascending: false })
  if (scope.limit) q = q.limit(scope.limit)
  const { data } = await q
  return withUrl(supabase, (data as JobPhoto[]) || [])
}

// ONE batched read for many properties at once — so a list page (Properties)
// makes a single query instead of mounting N self-fetching galleries that each
// fire their own auth + list round-trip. Newest-first, capped per property.
export async function listPhotosForProperties(
  supabase: SupabaseClient,
  userId: string,
  propertyIds: string[],
  perProperty = 60, // matches a standalone gallery's fetch, so the card shows the real
                    // count + a working "Show more" instead of silently capping low
): Promise<Record<string, JobPhotoView[]>> {
  const out: Record<string, JobPhotoView[]> = {}
  if (!propertyIds.length) return out
  const { data } = await supabase.from('job_photos').select('*')
    .eq('user_id', userId).in('property_id', propertyIds)
    .order('taken_at', { ascending: false }).limit(1000)
  for (const r of withUrl(supabase, (data as JobPhoto[]) || [])) {
    const pid = r.property_id
    if (!pid) continue
    const bucket = (out[pid] ||= [])
    if (bucket.length < perProperty) bucket.push(r)
  }
  return out
}

// Downscale a phone photo before upload so the gallery loads fast and storage
// stays small. Falls back to the original file on any failure (unsupported
// format, no canvas, etc.) — never blocks an upload over a resize hiccup.
async function downscale(file: File, maxDim = 1600, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/') || typeof document === 'undefined') return file
  try {
    // `imageOrientation: 'from-image'` bakes the EXIF rotation into the bitmap BEFORE
    // the canvas re-encode (which drops EXIF) — otherwise portrait phone photos get
    // stored, shown, and exported (PDF / marketing) sideways.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
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
}

export async function uploadPhoto(
  supabase: SupabaseClient,
  opts: UploadPhotoOpts,
): Promise<JobPhotoView | null> {
  const blob = await downscale(opts.file)
  // downscale re-encodes to JPEG when it can; when it passes the original through
  // (already-small, or an undecodable format like HEIC), honour its real type so we
  // never store HEIC/PNG bytes under a .jpg name + image/jpeg (which renders broken).
  const contentType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg'
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[contentType] || 'jpg'
  // Stable-enough unique name without a server round-trip. Date.now()+random is
  // fine in app (client) code — the minifier-closure caveat is workflow-only.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const path = `${opts.userId}/${opts.propertyId ?? 'unassigned'}/${stamp}.${ext}`

  const { error: upErr } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { upsert: false, contentType })
  if (upErr) return null

  const row: Record<string, unknown> = {
    user_id: opts.userId,
    job_id: opts.jobId ?? null,
    property_id: opts.propertyId,
    customer_id: opts.customerId ?? null,
    storage_path: path,
    kind: opts.kind,
    caption: opts.caption ?? null,
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

// Upload many photos at once. Root cause of "uploads feel slow": callers used to
// `await uploadPhoto` in a for-loop, which serializes BOTH the CPU-bound resize
// and the network upload across every file, and shows nothing until the whole
// batch finishes. This runs a bounded worker pool (compression of the next file
// overlaps the upload of the current one) and calls onUploaded as EACH photo
// lands, so the gallery fills in progressively instead of freezing on a spinner.
// concurrency 3 = the sweet spot: overlaps CPU+network without thrashing the
// browser's ~6-connection cap or janking on parallel canvas encodes.
export async function uploadPhotos(
  supabase: SupabaseClient,
  files: File[],
  base: Omit<Parameters<typeof uploadPhoto>[1], 'file'>,
  opts?: { concurrency?: number; onUploaded?: (row: JobPhotoView, index: number) => void; onError?: (file: File, index: number) => void },
): Promise<JobPhotoView[]> {
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 3, files.length))
  const results: JobPhotoView[] = []
  let next = 0
  async function worker(): Promise<void> {
    while (next < files.length) {
      const i = next++
      const row = await uploadPhoto(supabase, { ...base, file: files[i] })
      if (row) { results.push(row); opts?.onUploaded?.(row, i) }
      else opts?.onError?.(files[i], i)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

// Update a photo's caption or before/after tag. Returns false on failure so the
// caller can roll back its optimistic edit instead of silently diverging.
export async function updatePhoto(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<JobPhoto, 'kind' | 'caption'>>,
): Promise<boolean> {
  const { error } = await supabase.from('job_photos').update(patch).eq('id', id)
  return !error
}

// Delete a photo — removes both the catalogue row and the stored file.
export async function deletePhoto(supabase: SupabaseClient, photo: JobPhoto): Promise<void> {
  await supabase.from('job_photos').delete().eq('id', photo.id)
  await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path])
}
