import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import { PHOTO_BUCKET } from '@/lib/photos'
import { photoStoragePath, isValidPhotoToken } from '@/lib/field/photoIntent'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

// ── A worker photographs the job ─────────────────────────────────────────────
// THE crew-authenticated server boundary for photos, and the reason it must be
// a server route at all: the canonical uploader (lib/photos.uploadPhoto) runs
// as the signed-in user — storage path and catalogue row both carry THAT user's
// id. Run it in a crew session and the photo files under the WORKER's uid,
// where the owner's storage policies, gallery queries and marketing studio will
// never find it. A crew session also holds no table grants (deliberately — see
// crewAccess), so the catalogue insert cannot happen client-side at all.
//
// SECURITY SHAPE, same order as /api/crew/invite:
//   1. There must be a session.                                        (401)
//   2. current_app_role() must say 'crew' — asked of the DATABASE.     (403)
//   3. The technician row is resolved by auth_user_id with the SAME predicate
//      crew_technician_id() enforces in SQL: linked AND is_active AND NOT
//      archived. A deactivated worker fails HERE, mid-shift, unexpired JWT and
//      all — the roster switches are the access control.               (403)
//   4. The job must belong to that technician's EMPLOYER and CREW and not be
//      cancelled. Everything else about the photo's identity — owner, customer,
//      property — is derived from that verified row. The client names a job id
//      and nothing else; a crafted customer/property/user id in the form data
//      has nowhere to go because none is ever read.                    (404)
//
// The file itself: images only, capped, stored under the OWNER's id in the SAME
// bucket/path shape uploadPhoto uses, catalogued in job_photos with the SAME
// columns — so the owner's gallery, the customer portal and the before/after
// studio pick these up with zero extra wiring. A catalogue failure rolls the
// stored file back (uploadPhoto's own rule: storage never drifts from the
// catalogue).
//
// ⭐⭐ IDEMPOTENT UNDER RETRY (Field Reliability V1). The client mints an upload
// token when the camera returns the shot and reuses it for every retry of THAT
// shot; the object's path is derived from it (lib/field/photoIntent), so all
// attempts address the SAME object instead of a fresh random name each time.
// That closes the case this route could not previously survive: bytes land, the
// response dies in a dead zone, the worker taps Retry — and the customer's
// timeline ends up showing the same photo twice, with a second stored object
// nobody can account for.
//
// The retry path is also CHEAP, which matters more than it sounds: the row
// lookup happens BEFORE the bytes are read, so a retry on a marginal connection
// re-sends nothing at all when the first attempt actually landed. On a truck
// tethered to one bar that is the difference between a working Retry button and
// one that times out forever.
//
// A request without a token still works (an older client, mid-deploy) — it just
// gets the previous random-path behaviour, so a phone running yesterday's bundle
// keeps uploading rather than failing closed on a field it never learned to send.

const MAX_BYTES = 8 * 1024 * 1024   // client downscales to ~300KB; this is the abuse cap
const KINDS = new Set(['before', 'after'])
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const role = await resolveAppRole(supabase)
  if (role !== 'crew') return NextResponse.json({ error: 'Only crew members can add job photos here.' }, { status: 403 })

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const jobId = String(form.get('jobId') || '')
  const kind = String(form.get('kind') || 'after')
  const file = form.get('file')
  if (!jobId || !(file instanceof File)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!KINDS.has(kind)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // The retry identity. ⛔ Refused rather than sanitised when malformed: a token
  // we rewrote would address a different object than the first attempt wrote,
  // silently restoring the duplicate this exists to prevent. It also lands in a
  // storage path, so the character class is a boundary, not a style preference.
  const rawToken = String(form.get('uploadToken') || '')
  if (rawToken && !isValidPhotoToken(rawToken)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const token = rawToken || null
  if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'Only photos can be uploaded.' }, { status: 415 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That photo is too large — try again (it should shrink automatically).' }, { status: 413 })

  const admin = createAdminClient()
  // No service key configured → this door cannot verify anything, so it stays
  // shut (the invite route's contract). Never fall back to a weaker check.
  if (!admin) return NextResponse.json({ error: 'Photo upload isn’t available right now.' }, { status: 503 })

  // 3 — who is this worker, per the roster switches. Fails closed on any error:
  // "couldn't check" must never be treated as "checked out fine".
  const { data: tech, error: techErr } = await admin.from('technicians')
    .select('id, user_id, crew_id')
    .eq('auth_user_id', user.id).eq('is_active', true).is('archived_at', null)
    .maybeSingle()
  if (techErr) return NextResponse.json({ error: 'Couldn’t verify your crew access — try again.' }, { status: 502 })
  const t = tech as { id: string; user_id: string; crew_id: string | null } | null
  if (!t || !t.crew_id) return NextResponse.json({ error: 'Your account is no longer active on a crew.' }, { status: 403 })

  // 4 — the job, proven to be this crew's work. customer/property identity comes
  // from THIS row, never from the client.
  const { data: job, error: jobErr } = await admin.from('jobs')
    .select('id, user_id, crew_id, customer_id, property_id, status')
    .eq('id', jobId).eq('user_id', t.user_id).eq('crew_id', t.crew_id)
    .neq('status', 'cancelled')
    .maybeSingle()
  if (jobErr) return NextResponse.json({ error: 'Couldn’t check that visit — try again.' }, { status: 502 })
  const j = job as { id: string; user_id: string; customer_id: string | null; property_id: string | null } | null
  if (!j) return NextResponse.json({ error: 'That visit isn’t on your board.' }, { status: 404 })

  // Store + catalogue, exactly the canonical shapes (uploadPhoto's path and row).
  const contentType = file.type
  const ext = EXT[contentType] || 'jpg'
  // ⭐ Derived from the client's token when it sent one, so every retry of this
  // shot addresses the same object. Without a token, the old random name — which
  // means a retry can duplicate, exactly as before. That is the compatibility
  // cost of not making the field mandatory, and it is bounded to old clients.
  const path = token
    ? photoStoragePath(j.user_id, j.property_id, j.id, token, ext)
    : `${j.user_id}/${j.property_id ?? 'unassigned'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  // ⭐⭐ THE RETRY SHORT-CIRCUIT, before a single byte is read. If this exact shot
  // was already catalogued, the previous attempt succeeded and only its response
  // was lost — so the honest answer is the row we already have. Returning the
  // SAME id/url a first success would have returned is what lets the client
  // treat a retry and an original as indistinguishable.
  if (token) {
    const { data: prior, error: priorErr } = await admin.from('job_photos')
      .select('id').eq('user_id', j.user_id).eq('storage_path', path).maybeSingle()
    // ⚠️ A failed lookup is NOT "no prior row" — treating it as one would upload
    // again and re-insert. Refuse instead; the worker's Retry is still there and
    // the shot is still in hand.
    if (priorErr) return NextResponse.json({ error: 'Couldn’t check that photo — try again.' }, { status: 502 })
    if (prior) {
      const { data: had } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(path)
      return NextResponse.json({ ok: true, id: (prior as { id: string }).id, url: had.publicUrl, deduped: true })
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage.from(PHOTO_BUCKET)
    .upload(path, bytes, { upsert: false, contentType })
  if (upErr) {
    // ⭐ `upsert: false` makes storage itself the atomic guard: a second writer to
    // the same path is REFUSED. Reaching here with an already-exists error means
    // a previous attempt's bytes landed but its catalogue row did not (the row
    // lookup above just missed) — so the object is right where it should be and
    // the only thing left to do is catalogue it. Any other storage error is a
    // real failure.
    const already = /exist|duplicate|conflict/i.test(upErr.message || '')
    if (!already) return NextResponse.json({ error: 'The photo didn’t upload — check your signal and try again.' }, { status: 502 })
  }

  const { data: row, error: rowErr } = await admin.from('job_photos').insert({
    user_id: j.user_id,
    job_id: j.id,
    property_id: j.property_id,
    customer_id: j.customer_id,
    storage_path: path,
    kind,
  }).select('id').single()
  if (rowErr || !row) {
    await admin.storage.from(PHOTO_BUCKET).remove([path])
    return NextResponse.json({ error: 'The photo didn’t save — try again.' }, { status: 502 })
  }

  const { data: pub } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return NextResponse.json({ ok: true, id: (row as { id: string }).id, url: pub.publicUrl })
}
