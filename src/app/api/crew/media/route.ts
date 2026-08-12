import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import { CREW_MEDIA_BUCKET, type CrewMedia } from '@/lib/crewMedia'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

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

  const role = await resolveAppRole(supabase)
  if (role !== 'crew') {
    return NextResponse.json({ error: 'Only crew members read work instructions here.' }, { status: 403 })
  }

  const jobId = req.nextUrl.searchParams.get('jobId') || ''
  const date = req.nextUrl.searchParams.get('date') || ''
  const wantSummary = !jobId
  // Shape-check before either reaches the database: a bad value is a bad
  // request, not a 500 from a failed cast.
  if (wantSummary) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }
  } else if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const admin = createAdminClient()
  // No service key configured → this door cannot verify anything, so it stays
  // shut. Never fall back to a weaker check. (The invite/photo routes' contract.)
  if (!admin) return NextResponse.json({ error: 'Work instructions aren’t available right now.' }, { status: 503 })

  // 3 — who is this worker, per the roster switches. Fails closed on any error:
  // "couldn't check" must never be treated as "checked out fine".
  const { data: tech, error: techErr } = await admin.from('technicians')
    .select('id, user_id, crew_id')
    .eq('auth_user_id', user.id).eq('is_active', true).is('archived_at', null)
    .maybeSingle()
  if (techErr) return NextResponse.json({ error: 'Couldn’t verify your crew access — try again.' }, { status: 502 })
  const t = tech as { id: string; user_id: string; crew_id: string | null } | null
  if (!t || !t.crew_id) return NextResponse.json({ error: 'Your account is no longer active on a crew.' }, { status: 403 })

  // ── The day summary: how much is attached to each of TODAY's stops ─────────
  // Scoped by the same employer + crew the stop list itself is scoped by, so a
  // count can only ever describe a visit this worker is already assigned to.
  // ⛔ No paths, no URLs, nothing signed — a count is not a key.
  if (wantSummary) {
    const { data: dayRows, error: dayErr } = await admin.from('crew_media')
      .select('job_id, kind, jobs!inner(id, user_id, crew_id, scheduled_date)')
      .eq('user_id', t.user_id)
      .eq('jobs.user_id', t.user_id)
      .eq('jobs.crew_id', t.crew_id)
      .eq('jobs.scheduled_date', date)
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
  const { data: job, error: jobErr } = await admin.from('jobs')
    .select('id, user_id')
    .eq('id', jobId).eq('user_id', t.user_id).eq('crew_id', t.crew_id)
    .maybeSingle()
  if (jobErr) return NextResponse.json({ error: 'Couldn’t check that visit — try again.' }, { status: 502 })
  const j = job as { id: string; user_id: string } | null
  if (!j) return NextResponse.json({ error: 'That visit isn’t on your board.' }, { status: 404 })

  // The catalogue, scoped by BOTH the visit and its owner. job_id alone would be
  // enough given the check above; carrying user_id too means a future bug that
  // widened the job lookup still cannot cross a tenant boundary here.
  const { data: rows, error: rowsErr } = await admin.from('crew_media')
    .select('id, job_id, kind, mime, size_bytes, caption, created_at, storage_path')
    .eq('job_id', j.id).eq('user_id', j.user_id)
    .order('created_at', { ascending: true })
  if (rowsErr) return NextResponse.json({ error: 'Couldn’t load the work instructions — try again.' }, { status: 502 })

  const media = (rows || []) as Pick<CrewMedia,
    'id' | 'job_id' | 'kind' | 'mime' | 'size_bytes' | 'caption' | 'created_at' | 'storage_path'>[]
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
  const urlByPath = new Map((signed || []).map(s => [s.path, s.signedUrl]))

  return NextResponse.json({
    ok: true,
    // ⛔ storage_path is NOT echoed back. The worker needs something to PLAY, not
    // the object's address — and a path is the one string that would still mean
    // something after the signature expired.
    media: media.map(m => ({
      id: m.id,
      kind: m.kind,
      mime: m.mime,
      size_bytes: m.size_bytes,
      caption: m.caption,
      created_at: m.created_at,
      url: urlByPath.get(m.storage_path) ?? null,
    })),
    expires_in: SIGNED_URL_SECONDS,
  })
}
