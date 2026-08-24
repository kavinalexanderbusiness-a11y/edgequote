import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeWorkerVisit, WORKER_DENIAL_MESSAGE, WORKER_DENIAL_STATUS } from '@/lib/workerAccess'
import { PHOTO_BUCKET } from '@/lib/photos'

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
// Online-only, like every crew write in V1 — the client reports a failed upload
// honestly instead of queueing it.

const MAX_BYTES = 8 * 1024 * 1024   // client downscales to ~300KB; this is the abuse cap
const KINDS = new Set(['before', 'after'])
// A checklist photo may also be 'general' — but ONLY when it names a form
// field, so the plain before/after capture keeps its two-value contract.
const FORM_KINDS = new Set(['before', 'after', 'general'])
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  // ⛔ No separate role check. The canonical door below asks the stronger
  // question — an ACTIVE roster row for this session — and answers it once.

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const jobId = String(form.get('jobId') || '')
  const kind = String(form.get('kind') || 'after')
  const file = form.get('file')
  // Optional checklist linkage: a photo-requirement field on this visit's form.
  // Both named or neither — half a link is a bad request.
  const formId = String(form.get('formId') || '')
  const fieldId = String(form.get('fieldId') || '')
  if ((formId && !fieldId) || (!formId && fieldId)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!jobId || !(file instanceof File)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!(formId ? FORM_KINDS : KINDS).has(kind)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'Only photos can be uploaded.' }, { status: 415 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That photo is too large — try again (it should shrink automatically).' }, { status: 413 })

  const admin = createAdminClient()
  // No service key configured → this door cannot verify anything, so it stays
  // shut (the invite route's contract). Never fall back to a weaker check.
  if (!admin) return NextResponse.json({ error: 'Photo upload isn’t available right now.' }, { status: 503 })

  // 3 + 4 — ⭐ THE canonical door (lib/workerAccess): an ACTIVE roster row, this
  // worker's tenant, then the S65 assignment predicate — crew OR by name. It
  // replaced a hand-rolled pair of lookups that asked `.eq('crew_id',
  // tech.crew_id)` and refused any crewless worker outright, so a by-name
  // assignee could not upload proof of their own work. Fails closed on any read
  // error: "couldn't check" is never "checked out fine".
  const auth = await authorizeWorkerVisit(admin, user.id, jobId)
  if (!auth.ok) {
    return NextResponse.json(
      { error: WORKER_DENIAL_MESSAGE[auth.denial] },
      { status: WORKER_DENIAL_STATUS[auth.denial] },
    )
  }

  // The columns this door needs. Re-read under the SAME verified employer id —
  // customer/property identity comes from THIS row, never from the client — and
  // cancelled work is excluded: called-off visits take no proof.
  const { data: job, error: jobErr } = await admin.from('jobs')
    .select('id, user_id, crew_id, customer_id, property_id, status')
    .eq('id', jobId).eq('user_id', auth.worker.employerId)
    .neq('status', 'cancelled')
    .maybeSingle()
  if (jobErr) return NextResponse.json({ error: 'Couldn’t check that visit — try again.' }, { status: 502 })
  const j = job as { id: string; user_id: string; customer_id: string | null; property_id: string | null; status: string } | null
  if (!j) return NextResponse.json({ error: WORKER_DENIAL_MESSAGE['not-assigned'] }, { status: 404 })

  // 5 (checklist photos only) — the named form must be THIS visit's, still
  // open, and the named field must be a photo requirement on its snapshot.
  // Checked BEFORE the upload so a bad link fails fast with nothing stored.
  if (formId) {
    if (j.status === 'completed') {
      return NextResponse.json({ error: 'This visit is finished — its checklist is frozen.' }, { status: 409 })
    }
    const { data: jf, error: jfErr } = await admin.from('job_forms')
      .select('id, fields')
      .eq('id', formId).eq('user_id', j.user_id).eq('job_id', j.id)
      .maybeSingle()
    if (jfErr) return NextResponse.json({ error: 'Couldn’t check that checklist — try again.' }, { status: 502 })
    const snapshot = (jf?.fields ?? null) as { id: string; type: string }[] | null
    const field = snapshot?.find(f => f.id === fieldId)
    if (!jf || !field) return NextResponse.json({ error: 'That checklist item isn’t on this visit.' }, { status: 404 })
    if (field.type !== 'photo') return NextResponse.json({ error: 'That checklist item doesn’t take photos.' }, { status: 400 })
  }

  // Store + catalogue, exactly the canonical shapes (uploadPhoto's path and row).
  const contentType = file.type
  const ext = EXT[contentType] || 'jpg'
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const path = `${j.user_id}/${j.property_id ?? 'unassigned'}/${stamp}.${ext}`

  const bytes = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage.from(PHOTO_BUCKET)
    .upload(path, bytes, { upsert: false, contentType })
  if (upErr) return NextResponse.json({ error: 'The photo didn’t upload — check your signal and try again.' }, { status: 502 })

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
  const photoId = (row as { id: string }).id

  // 6 (checklist photos only) — anchor the response and link the photo. The
  // LINK is the requirement: if any of this fails, the whole upload rolls back
  // and the client is told, so a dead zone can never tick the box — and no
  // orphaned photo poses as evidence that satisfied nothing.
  if (formId) {
    const linked = await (async () => {
      const { data: anchor, error: anchorErr } = await admin.from('job_form_responses')
        .upsert({
          user_id: j.user_id,
          form_id: formId,
          field_id: fieldId,
          answered_by: user.id,          // the WORKER answered — recorded, never inferred
          answered_role: 'crew',
          answered_at: new Date().toISOString(),
        }, { onConflict: 'form_id,field_id' })
        .select('id')
      const responseId = anchor?.[0]?.id as string | undefined
      if (anchorErr || !responseId) return false
      const { error: linkErr } = await admin.from('job_form_response_photos')
        .insert({ response_id: responseId, photo_id: photoId, user_id: j.user_id })
      return !linkErr
    })()
    if (!linked) {
      await admin.from('job_photos').delete().eq('id', photoId).eq('user_id', j.user_id)
      await admin.storage.from(PHOTO_BUCKET).remove([path])
      return NextResponse.json({ error: 'The photo didn’t attach to the checklist — try again.' }, { status: 502 })
    }
  }

  const { data: pub } = admin.storage.from(PHOTO_BUCKET).getPublicUrl(path)
  return NextResponse.json({ ok: true, id: photoId, url: pub.publicUrl })
}
