import type { SupabaseClient } from '@supabase/supabase-js'

// ── Crew reference media ─────────────────────────────────────────────────────
// The photos and video the office sends TO the field: what a worker needs to
// see BEFORE and DURING the work. "This gate." "Mulch to here, not up the
// siding." "Don't prune this one."
//
// ⛔ NOT PROOF OF WORK. job_photos + the PUBLIC job-photos bucket are the record
// of work DONE, and some of it is meant for the customer (the portal and the
// PDFs render it). This runs the other way: material that no customer ever
// receives. Same storage technology, different table, different bucket —
// because the two have OPPOSITE privacy defaults.
//
// ⭐ WHY A SEPARATE, PRIVATE BUCKET AND NOT job-photos.
// job-photos is public:true. Every object in it is readable by anyone holding
// the URL — no session, no expiry, forever. That is a working choice for a
// photo of a finished lawn and a disqualifying one for a video of a customer's
// side gate: it would make the URL itself the permission, and a URL gets
// forwarded, pasted and logged. crew-media is private, so the ONLY way in is a
// short-lived signed URL minted against a proven identity.
//
// ⭐ TWO DOORS, ONE AUTHORIZATION EACH — mirroring the rest of Crew Mode.
//   OWNER  → this module, running as the owner's own session. The storage
//            policies (foldername[1] = auth.uid()) and the crew_media RLS
//            policy (auth.uid() = user_id) are the boundary, exactly as they
//            are for equipment-docs and expense-receipts.
//   CREW   → /api/crew/media. A crew session holds NO table grants and no
//            storage grants at all (Crew Mode's founding rule), so a worker
//            cannot read the catalogue or mint a URL client-side even in
//            principle. That route proves the assignment, then signs.

import type { NoteAudience } from '@/lib/noteScope'

export const CREW_MEDIA_BUCKET = 'crew-media'

/** ⭐ The whole table is one audience. There is no per-row visibility switch,
 *  and adding one would be a control whose only use is to leak. */
export const CREW_MEDIA_AUDIENCE: NoteAudience = 'crew'

export type CrewMediaKind = 'photo' | 'video'

export interface CrewMedia {
  id: string
  user_id: string
  job_id: string
  storage_path: string
  kind: CrewMediaKind
  mime: string | null
  size_bytes: number | null
  caption: string | null
  created_by: string | null
  created_at: string
}

// ── Limits ───────────────────────────────────────────────────────────────────
// Enforced in THREE places on purpose, because each catches a different caller:
// the bucket (storage itself — a crafted request cannot talk past it), the
// server route (so a crew upload is rejected before bytes are stored), and the
// picker below (so the owner is told before a 90 MB file crawls up a phone
// tether). The bucket is the one that actually guarantees it.
export const CREW_MEDIA_MAX_BYTES = 50 * 1024 * 1024   // matches storage.buckets.file_size_limit

export const CREW_MEDIA_IMAGE_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
] as const
export const CREW_MEDIA_VIDEO_MIME = [
  'video/mp4', 'video/quicktime', 'video/webm',
] as const
export const CREW_MEDIA_ACCEPT = [...CREW_MEDIA_IMAGE_MIME, ...CREW_MEDIA_VIDEO_MIME].join(',')

/** Bytes → the words a person uses. */
export function sizeLabel(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function kindOf(mime: string | null | undefined): CrewMediaKind | null {
  if (!mime) return null
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'photo'
  return null
}

/**
 * ⚠️ THE COMPATIBILITY TRUTH, STATED RATHER THAN ASSUMED.
 * An iPhone records .mov (video/quicktime) and, since iOS 11, usually encodes
 * it as HEVC. Safari and iOS play that; Chrome and Firefox on Windows and
 * Android frequently do not, and what they show is a black box with a spinner —
 * which reads to a worker as "the app is broken", not "this codec".
 *
 * V1 does NOT transcode (that is a service, not a feature, and out of scope for
 * this session). So it does the honest thing instead: accept the file, warn the
 * owner at the moment they pick it, and have the player report a decode failure
 * as a decode failure with a working download link. Nobody is promised
 * universal playback, and nobody is left staring at a black box.
 */
export function playbackCaveat(mime: string | null | undefined): string | null {
  if (mime === 'video/quicktime') {
    return 'MOV files don’t play in every browser. MP4 plays everywhere — convert it if the crew reports a problem.'
  }
  if (mime === 'image/heic' || mime === 'image/heif') {
    return 'HEIC photos don’t display in most browsers. JPEG or PNG is safer.'
  }
  if (mime === 'video/webm') {
    return 'WEBM doesn’t play on iPhones. MP4 plays everywhere.'
  }
  return null
}

/** …/<owner_user_id>/<job_id>/<random>.<ext> — the shape the storage policies
 *  expect, and the reason the first segment IS the tenant boundary. */
function mediaPath(userId: string, jobId: string, file: File): string {
  const dot = file.name.lastIndexOf('.')
  const raw = dot > 0 ? file.name.slice(dot + 1) : ''
  const ext = /^[a-zA-Z0-9]{1,5}$/.test(raw) ? raw.toLowerCase() : (file.type.startsWith('video/') ? 'mp4' : 'jpg')
  return `${userId}/${jobId}/${crypto.randomUUID()}.${ext}`
}

/** The catalogue for one visit, oldest first — reference material reads as a
 *  sequence ("gate, then the bed, then the shrub"), not a newest-first feed. */
export async function listCrewMedia(
  supabase: SupabaseClient, userId: string, jobId: string,
): Promise<{ media: CrewMedia[]; error: boolean }> {
  const { data, error } = await supabase.from('crew_media').select('*')
    .eq('user_id', userId).eq('job_id', jobId)
    .order('created_at', { ascending: true })
  // An empty list and a failed read are different facts and must not collapse:
  // "no instructions" is a statement about the visit, "couldn't load" is not.
  return { media: (data as CrewMedia[]) || [], error: !!error }
}

/** Short-lived signed URL. The bucket is private, so this is the only way in —
 *  ⛔ never getPublicUrl, which would make the link itself the permission. */
export async function signedMediaUrl(
  supabase: SupabaseClient, path: string, seconds = 300,
): Promise<string | null> {
  const { data } = await supabase.storage.from(CREW_MEDIA_BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}

export interface UploadCrewMediaResult {
  media?: CrewMedia
  /** Owner-facing, already a sentence. Present iff the upload did NOT land. */
  error?: string
}

/**
 * Store the object, then catalogue it. Two phases, and the rollback matters:
 * a stored object with no row is invisible to the product but still occupies
 * the business's storage AND still exists behind a signable path — so a failed
 * catalogue write removes the file rather than leaving it. (uploadPhoto's rule,
 * for the same reason.)
 *
 * ⛔ Never reports success it did not get. Every failing branch returns a
 * message; the caller keeps the file in hand and offers Retry.
 */
export async function uploadCrewMedia(
  supabase: SupabaseClient,
  opts: { userId: string; jobId: string; file: File; caption?: string | null; uploadedBy?: string | null },
): Promise<UploadCrewMediaResult> {
  const kind = kindOf(opts.file.type)
  if (!kind) return { error: 'That file type can’t be attached — use a photo or a video.' }
  if (opts.file.size > CREW_MEDIA_MAX_BYTES) {
    return { error: `That file is ${sizeLabel(opts.file.size)} — the limit is ${sizeLabel(CREW_MEDIA_MAX_BYTES)}. Trim the video and try again.` }
  }

  const path = mediaPath(opts.userId, opts.jobId, opts.file)
  const { error: upErr } = await supabase.storage.from(CREW_MEDIA_BUCKET)
    .upload(path, opts.file, { upsert: false, contentType: opts.file.type || undefined })
  if (upErr) {
    // Storage's own ceiling and MIME allowlist surface here. Say which.
    const m = upErr.message || ''
    if (/exceeded|too large|maximum/i.test(m)) {
      return { error: `That file is too large — the limit is ${sizeLabel(CREW_MEDIA_MAX_BYTES)}.` }
    }
    if (/mime|not allowed|invalid/i.test(m)) {
      return { error: 'That file type isn’t accepted — use MP4 video, or a JPEG/PNG photo.' }
    }
    return { error: 'The file didn’t upload — check your connection and try again.' }
  }

  const { data, error } = await supabase.from('crew_media').insert({
    user_id: opts.userId,
    job_id: opts.jobId,
    storage_path: path,
    kind,
    mime: opts.file.type || null,
    size_bytes: opts.file.size ?? null,
    caption: opts.caption?.trim() || null,
    created_by: opts.uploadedBy ?? null,
  }).select('*').single()

  if (error || !data) {
    await supabase.storage.from(CREW_MEDIA_BUCKET).remove([path])
    return { error: 'The file uploaded but didn’t save to the visit — try again.' }
  }
  return { media: data as CrewMedia }
}

/**
 * Remove the row, then the object.
 *
 * Row FIRST: once it is gone the file is gone from the product's point of view,
 * and a failed object removal only leaks storage. The reverse order strands a
 * row pointing at nothing, which renders as a permanently broken tile on the
 * worker's phone that no retry can clear. (deletePhoto's rule.)
 *
 * ⭐ Deleting reference media touches NOTHING else: crew_media has no inbound
 * references, and job_photos / completion records / the customer timeline are
 * separate rows on separate tables. Removing "the gate video" from Tuesday's
 * visit cannot alter what Monday's visit recorded.
 */
export async function deleteCrewMedia(
  supabase: SupabaseClient, media: Pick<CrewMedia, 'id' | 'storage_path'>,
): Promise<{ error?: string }> {
  const { error } = await supabase.from('crew_media').delete().eq('id', media.id)
  if (error) return { error: 'Couldn’t remove that file — try again.' }
  await supabase.storage.from(CREW_MEDIA_BUCKET).remove([media.storage_path])
  return {}
}
