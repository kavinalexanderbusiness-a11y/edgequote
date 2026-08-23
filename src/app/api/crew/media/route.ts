import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  assignedVisitFilter, authorizeWorkerVisit, resolveWorker,
  WORKER_DENIAL_MESSAGE, WORKER_DENIAL_STATUS,
} from '@/lib/workerAccess'
import {
  CREW_MEDIA_ACCEPT, CREW_MEDIA_BUCKET, CREW_MEDIA_MAX_BYTES, kindOf, sizeLabel, type CrewMedia,
} from '@/lib/crewMedia'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

/** Shape-checked before either id reaches the database, so a bad value is a bad
 *  request rather than a 500 from a failed cast. */
const UUID = /^[0-9a-f-]{36}$/i

// ── A worker opens the work instructions ─────────────────────────────────────
// THE crew-authenticated read door for reference media, and the reason it has to
// be a server route:
//
//   1. A crew session holds NO table grants at all — Crew Mode's founding rule.
//      So `crew_media` cannot be queried client-side even to learn that a file
//      exists.
//   2. The `crew-media` bucket is PRIVATE and carries no crew storage policy.
//      So a signed URL cannot be minted client-side either.
//
// ⭐ WHY NO CREW STORAGE POLICY. A storage policy is evaluated per OBJECT, so it
// would have to re-derive "is this worker assigned to that visit" by parsing a
// job id out of the object's path. That assignment check already exists, once,
// below — and in /api/crew/photos, and in crew_day, and in
// crew_set_visit_status. A fifth copy written in a different language against a
// string-split path is a fifth chance to get it wrong. The URL is signed only
// after the SAME four questions the photo-upload door already asks.
//
// SECURITY SHAPE, in the same order as /api/crew/photos:
//   1. There must be a session.                                          (401)
//   2. current_app_role() must say 'crew' — asked of the DATABASE.       (403)
//   3. The technician row is resolved by auth_user_id with the SAME predicate
//      crew_technician_id() enforces in SQL: linked AND is_active AND NOT
//      archived. A worker deactivated mid-shift fails HERE, unexpired JWT and
//      all — the roster switches are the access control.                 (403)
//   4. The job must belong to that technician's EMPLOYER and CREW. The client
//      names a job id and NOTHING else; the owner identity used to read the
//      catalogue comes from the verified technician row, never from the request.
//                                                                        (404)
//
// ⭐ THE CLIENT NEVER NAMES A FILE. It cannot ask for a media id, a storage path
// or a bucket key — there is no parameter for one. It names a VISIT, and the
// server returns the media that visit has. So a copied id from another business
// (or another crew's job) has nowhere to be pasted: the only reachable rows are
// the ones the assignment already proved. This is the rule the portal token
// follows too — the server derives the allowed records.
//
// ⭐ TWO QUESTIONS, ONE DOOR, AND WHY THEY ARE SEPARATE.
//   ?date=YYYY-MM-DD → COUNTS for every stop that day. No URLs, nothing signed.
//                      This is what the day view asks so a stop card can show
//                      "2 photos · 1 video" without a request per stop.
//   ?jobId=<uuid>    → the media for ONE visit, with freshly signed URLs.
//                      Asked when the worker actually opens the instructions.
//
// Signing at day-load instead would be both wasteful and WRONG: a signature
// minted at 7am is dead by the time the truck reaches the eighth stop, and the
// worker would meet a broken video with no way to refresh it. Signing at the
// moment of opening is the only version where the link is alive when it is used.
//
// URLs are signed for five minutes. Long enough to watch a two-minute clip on a
// slow tether, short enough that a URL pasted into a group chat is dead before
// it is read. A copied link is NOT permanent access.

const SIGNED_URL_SECONDS = 300

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  // ⛔ No separate role check. The canonical resolver below asks the stronger
  // question — an ACTIVE roster row for this session — and answers it once.

  const jobId = req.nextUrl.searchParams.get('jobId') || ''
  const date = req.nextUrl.searchParams.get('date') || ''
  const wantSummary = !jobId
  // Shape-check before either reaches the database: a bad value is a bad
  // request, not a 500 from a failed cast.
  if (wantSummary) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }
  } else if (!UUID.test(jobId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const admin = createAdminClient()
  // No service key configured → this door cannot verify anything, so it stays
  // shut. Never fall back to a weaker check. (The invite/photo routes' contract.)
  if (!admin) return NextResponse.json({ error: 'Work instructions aren’t available right now.' }, { status: 503 })

  // 3 — ⭐ who is this worker, per the roster switches, through THE canonical
  // resolver (lib/workerAccess). Fails closed on any error: "couldn't check" is
  // never "checked out fine". ⭐ A crewless worker is NO LONGER refused here —
  // being assigned by name is a complete assignment, and turning them away at
  // step 3 was what hid their own work instructions from them.
  const resolved = await resolveWorker(admin, user.id)
  if (!resolved.ok) {
    return NextResponse.json(
      { error: WORKER_DENIAL_MESSAGE[resolved.denial] },
      { status: WORKER_DENIAL_STATUS[resolved.denial] },
    )
  }
  const t = resolved.worker

  // ── The day summary: how much is attached to each of TODAY's stops ─────────
  // Scoped by the same employer + crew the stop list itself is scoped by, so a
  // count can only ever describe a visit this worker is already assigned to.
  // ⛔ No paths, no URLs, nothing signed — a count is not a key.
  if (wantSummary) {
    // ⚠️ `message_id is null` is load-bearing HERE TOO. This count drives the
    // "2 photos · 1 video" label on the WORK INSTRUCTIONS disclosure; without
    // the filter, a photo somebody sent in the conversation would inflate it,
    // and a worker would open the instructions looking for a file that the
    // instructions do not contain.
    //
    // ⭐ TWO STEPS, ON PURPOSE. The assignment predicate is an OR across two
    // columns, and expressing that against an EMBEDDED table is both awkward and
    // easy to get subtly wrong. So: resolve THIS worker's visits for the day
    // first (tenant predicate + assignedVisitFilter — the same canonical
    // predicate), then count only within those ids. A visit that failed the
    // first query cannot be counted by the second.
    const { data: dayJobs, error: dayJobErr } = await admin.from('jobs')
      .select('id')
      .eq('user_id', t.employerId)
      .eq('scheduled_date', date)
      .or(assignedVisitFilter(t))
    if (dayJobErr) return NextResponse.json({ error: 'Couldn’t check for work instructions.' }, { status: 502 })
    const myJobIds = ((dayJobs || []) as { id: string }[]).map(r => r.id)
    if (myJobIds.length === 0) return NextResponse.json({ ok: true, counts: {} })

    const { data: dayRows, error: dayErr } = await admin.from('crew_media')
      .select('job_id, kind')
      .is('message_id', null)
      .eq('user_id', t.employerId)
      .in('job_id', myJobIds)
    if (dayErr) return NextResponse.json({ error: 'Couldn’t check for work instructions.' }, { status: 502 })

    const counts: Record<string, { photos: number; videos: number }> = {}
    for (const r of (dayRows || []) as unknown as { job_id: string; kind: string }[]) {
      const c = (counts[r.job_id] ||= { photos: 0, videos: 0 })
      if (r.kind === 'video') c.videos++
      else c.photos++
    }
    return NextResponse.json({ ok: true, counts })
  }

  // 4 — the visit, proven to be this crew's work.
  //
  // ⚠️ CANCELLED IS NOT EXCLUDED HERE, and that is deliberate — it is the one
  // place this route differs from the photo door. crew_day deliberately still
  // SHOWS a cancelled stop (so a visit the office killed at 10am becomes a
  // visible "don't go" line rather than vanishing), and a worker who taps it
  // must get the same honest empty state as any other stop, not an error that
  // looks like a permissions failure. Reading instructions changes nothing;
  // WRITING to a cancelled visit is what the other doors refuse.
  const auth = await authorizeWorkerVisit(admin, user.id, jobId)
  if (!auth.ok) {
    return NextResponse.json(
      { error: WORKER_DENIAL_MESSAGE[auth.denial] },
      { status: WORKER_DENIAL_STATUS[auth.denial] },
    )
  }
  const j = { id: auth.visit.jobId, user_id: auth.visit.employerId }

  // The catalogue, scoped by BOTH the visit and its owner. job_id alone would be
  // enough given the check above; carrying user_id too means a future bug that
  // widened the job lookup still cannot cross a tenant boundary here.
  // ⭐ message_id RIDES ALONG SO THE TWO KINDS NEVER RENDER AS EACH OTHER.
  // NULL is what this table has always held: reference material the OFFICE
  // attached to the visit, shown under the work instructions. Non-null is an
  // attachment on one thing somebody said in the conversation. Same bucket, same
  // ceiling, same MIME allowlist, same signing — one door, because a second
  // private bucket would have been a second set of all four to keep in step.
  // The CLIENT filters; the server signs everything this visit is allowed.
  const { data: rows, error: rowsErr } = await admin.from('crew_media')
    .select('id, job_id, message_id, kind, mime, size_bytes, caption, created_at, storage_path')
    .eq('job_id', j.id).eq('user_id', j.user_id)
    .order('created_at', { ascending: true })
  if (rowsErr) return NextResponse.json({ error: 'Couldn’t load the work instructions — try again.' }, { status: 502 })

  const media = (rows || []) as Pick<CrewMedia,
    'id' | 'job_id' | 'message_id' | 'kind' | 'mime' | 'size_bytes' | 'caption' | 'created_at' | 'storage_path'>[]
  if (!media.length) return NextResponse.json({ ok: true, media: [] })

  const { data: signed, error: signErr } = await admin.storage.from(CREW_MEDIA_BUCKET)
    .createSignedUrls(media.map(m => m.storage_path), SIGNED_URL_SECONDS)
  if (signErr) {
    // The catalogue read fine but the files are unreachable. Say exactly that —
    // "there are 2 files and they wouldn't open" is a different fact from
    // "there are no instructions", and a worker must not act on the second when
    // the first is true.
    return NextResponse.json({ error: 'Your instructions are attached but wouldn’t open — try again.' }, { status: 502 })
  }
  // ⚠️ MATCHED BY POSITION, WITH path AS THE FALLBACK — not the other way round.
  // createSignedUrls returns one entry per requested path, in order. Keying a Map
  // on the returned `path` assumes it echoes the input byte-for-byte; if it ever
  // came back normalised (a leading slash, the bucket prefixed, URL-encoded), the
  // lookup would miss on EVERY row and the worker would be told each of their
  // instructions "wouldn't open" — a total, silent failure that looks exactly
  // like a storage outage. Order is the contract that cannot drift, and the path
  // check below is kept as a second chance rather than the only one.
  const signedList = signed || []
  const byPath = new Map(signedList.map(s => [s.path, s.signedUrl]))
  const urlFor = (path: string, i: number): string | null =>
    signedList[i]?.signedUrl ?? byPath.get(path) ?? null

  return NextResponse.json({
    ok: true,
    // ⛔ storage_path is NOT echoed back. The worker needs something to PLAY, not
    // the object's address — and a path is the one string that would still mean
    // something after the signature expired.
    media: media.map((m, i) => ({
      id: m.id,
      message_id: m.message_id ?? null,
      kind: m.kind,
      mime: m.mime,
      size_bytes: m.size_bytes,
      caption: m.caption,
      created_at: m.created_at,
      url: urlFor(m.storage_path, i),
    })),
    expires_in: SIGNED_URL_SECONDS,
  })
}

// ── A worker attaches a photo to something they said ─────────────────────────
// POST is the WRITE half of the same door, and it asks the SAME four questions
// in the SAME order as the GET above and as /api/crew/photos. It exists for the
// same reason that route does: a crew session holds no table grants and no
// storage grants, so neither the object nor the catalogue row can be written
// client-side, and the file must be filed under the OWNER's identity or the
// owner's own gallery and policies will never find it.
//
// ⭐ THE MESSAGE MUST ALREADY EXIST, AND IT MUST BE THIS CREW'S OWN MESSAGE.
// The client posts the message first (through crew_post_message, which proves
// assignment in SQL) and then attaches to the id it got back. So this route
// re-proves BOTH: the visit is this crew's work, AND the message belongs to that
// visit. A message id from another business, or from another visit, matches
// nothing — there is no way to hang a file off somebody else's conversation.
//
// ⛔ NOT PROOF OF WORK. This lands in crew_media (private bucket, signed URLs,
// no customer surface), never in job_photos (public bucket, rendered in the
// portal). A photo of an empty pallet sent to the office is not evidence for the
// customer, and the two must not share a table — see lib/crewMedia.

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  // ⛔ No separate role check — the canonical door below is the stronger one.

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  const jobId = String(form.get('jobId') || '')
  const messageId = String(form.get('messageId') || '')
  const file = form.get('file')
  if (!UUID.test(jobId) || !UUID.test(messageId) || !(file instanceof File)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  // Checked here so a 50 MB upload is refused before the bytes are stored. The
  // bucket enforces both again — that is the copy that actually guarantees it,
  // because a crafted request cannot talk past storage itself.
  const kind = kindOf(file.type)
  if (!kind) return NextResponse.json({ error: 'Attach a photo or a video.' }, { status: 415 })
  if (!(CREW_MEDIA_ACCEPT.split(',') as string[]).includes(file.type)) {
    return NextResponse.json({ error: 'That file type isn’t accepted — use MP4 video, or a JPEG/PNG photo.' }, { status: 415 })
  }
  if (file.size > CREW_MEDIA_MAX_BYTES) {
    return NextResponse.json({ error: `That file is too large — the limit is ${sizeLabel(CREW_MEDIA_MAX_BYTES)}.` }, { status: 413 })
  }

  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'Attachments aren’t available right now.' }, { status: 503 })

  // ⭐ THE canonical door — active worker, this worker's tenant, then crew OR
  // by-name assignment. One call, the same answer every other worker door gives.
  const auth = await authorizeWorkerVisit(admin, user.id, jobId)
  if (!auth.ok) {
    return NextResponse.json(
      { error: WORKER_DENIAL_MESSAGE[auth.denial] },
      { status: WORKER_DENIAL_STATUS[auth.denial] },
    )
  }
  const t = auth.worker
  const j = { id: auth.visit.jobId, user_id: auth.visit.employerId }

  // The message, proven to be on THAT visit and in THAT business. Both columns
  // carried, so a future bug that widened one still cannot cross the other.
  const { data: msg, error: msgErr } = await admin.from('crew_messages')
    .select('id')
    .eq('id', messageId).eq('job_id', j.id).eq('user_id', j.user_id)
    .maybeSingle()
  if (msgErr) return NextResponse.json({ error: 'Couldn’t check that message — try again.' }, { status: 502 })
  if (!msg) return NextResponse.json({ error: 'That message isn’t on this visit.' }, { status: 404 })

  // Store, then catalogue — and roll the object back if the row fails, so
  // storage never drifts from the catalogue (lib/crewMedia + uploadPhoto's rule:
  // a stored object with no row is invisible to the product and still occupies
  // the business's storage behind a signable path).
  const dot = file.name.lastIndexOf('.')
  const rawExt = dot > 0 ? file.name.slice(dot + 1) : ''
  const ext = /^[a-zA-Z0-9]{1,5}$/.test(rawExt) ? rawExt.toLowerCase() : (kind === 'video' ? 'mp4' : 'jpg')
  const path = `${j.user_id}/${j.id}/${crypto.randomUUID()}.${ext}`

  const bytes = Buffer.from(await file.arrayBuffer())
  const { error: upErr } = await admin.storage.from(CREW_MEDIA_BUCKET)
    .upload(path, bytes, { upsert: false, contentType: file.type || undefined })
  if (upErr) {
    const m = upErr.message || ''
    if (/exceeded|too large|maximum/i.test(m)) {
      return NextResponse.json({ error: `That file is too large — the limit is ${sizeLabel(CREW_MEDIA_MAX_BYTES)}.` }, { status: 413 })
    }
    return NextResponse.json({ error: 'The file didn’t upload — check your signal and try again.' }, { status: 502 })
  }

  const { data: row, error: rowErr } = await admin.from('crew_media').insert({
    // ⭐ Every identity here comes from the VERIFIED job row, never from the
    // form. The client named a visit and a message; it named no owner.
    user_id: j.user_id,
    job_id: j.id,
    message_id: messageId,
    storage_path: path,
    kind,
    mime: file.type || null,
    size_bytes: file.size ?? null,
    created_by: user.id,
  }).select('id').single()
  if (rowErr || !row) {
    await admin.storage.from(CREW_MEDIA_BUCKET).remove([path])
    return NextResponse.json({ error: 'The file uploaded but didn’t attach — try again.' }, { status: 502 })
  }

  // ⛔ No URL is returned. The client re-asks the GET above, which is the one
  // place that mints a signature — so there is exactly one signing path to audit
  // and a fresh 5-minute window rather than one that started at upload time.
  return NextResponse.json({ ok: true, id: (row as { id: string }).id })
}
