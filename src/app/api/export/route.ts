import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAppRole } from '@/lib/crewAccess'
import { buildExportArchive } from '@/lib/export/build'
import { EXPORT_FORMAT_VERSION } from '@/lib/export/manifest'

// node:zlib and Buffer — this cannot run at the edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Building a large account's archive is a lot of sequential reads. The platform
// cap applies regardless; this asks for the headroom it allows.
export const maxDuration = 300

// ── Take your data with you ──────────────────────────────────────────────────
// THE door for "give me my business's records". One request in, one .zip out.
//
// SECURITY SHAPE, in order:
//   1. There must be a session.                                          (401)
//   2. current_app_role() must say 'owner' — asked of the DATABASE, not of a
//      cookie or a prop. A crew member is signed into the same app and must
//      never be able to pull the owner's entire customer book; they hold no
//      table grants at all, so this is the second lock, not the only one. (403)
//   3. Everything read is filtered by THAT session's user id. The route accepts
//      no body, no query string and no business identifier — there is no input
//      to tamper with, so "don't trust a client-supplied business id" is true
//      here by construction rather than by review.
//   4. Reads run on the caller's own user-scoped client, so RLS
//      (auth.uid() = user_id) independently blocks any row that is not theirs.
//      Two gates, either of which alone is sufficient.
//
// POST rather than GET on purpose: a full data export is an action, not a page.
// POST keeps it off browser history and prefetchers, and makes the client await
// the finished bytes before it offers a download — which is what stops the UI
// saying "ready" before anything exists.

export async function POST() {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Please sign in to export your data.' }, { status: 401 })
  }

  const role = await resolveAppRole(supabase)
  if (role !== 'owner') {
    return NextResponse.json(
      { error: 'Only the business owner can export the business\'s data.' },
      { status: 403 },
    )
  }

  // Used for the filename and the README heading only — never as a filter.
  const { data: settings } = await supabase
    .from('business_settings')
    .select('company_name')
    .eq('user_id', user.id)
    .maybeSingle()

  const result = await buildExportArchive(supabase, user.id, {
    companyName: settings?.company_name ?? null,
  })

  if (!result.ok) {
    // Nothing has been sent yet, so a failure is still a status code and a
    // sentence — never a 200 carrying half an archive.
    const status = result.code === 'too_large' ? 413 : 500
    return NextResponse.json({ error: result.message, code: result.code }, { status })
  }

  // ── The record that this happened ─────────────────────────────────────────
  // Written before the bytes go out, with the user id from the session (RLS
  // checks it again on insert). Deliberately NOT fatal: the archive is already
  // built and correct, and refusing somebody their own data because a log row
  // failed would be the wrong trade for a feature whose subject is trust.
  const { error: auditError } = await supabase.from('data_exports').insert({
    user_id: user.id,
    format_version: EXPORT_FORMAT_VERSION,
    total_rows: result.totalRows,
    bytes: result.archive.length,
    files: result.files,
  })
  if (auditError) console.error('[export] audit record failed:', auditError.message)

  // The filename is built from a slug of [a-z0-9-] plus an ISO date, so it
  // cannot carry a quote or a newline into the header. Asserted, not assumed.
  const safeName = /^[a-z0-9.\-]+$/.test(result.filename) ? result.filename : 'edgequote-export.zip'

  // Streamed rather than returned as one buffer: a buffered response is capped
  // at a few megabytes on the hosting platform, and a real account's archive can
  // exceed that. The archive is COMPLETE before this stream is created, so
  // streaming costs nothing in honesty — there is no failure left to hit.
  const archive = result.archive
  const CHUNK = 256 * 1024
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < archive.length; i += CHUNK) {
        controller.enqueue(new Uint8Array(archive.subarray(i, Math.min(i + CHUNK, archive.length))))
      }
      controller.close()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(archive.length),
      // What the archive actually contains, so the screen can report the real
      // number instead of an optimistic one it made up before the read.
      'X-Export-Rows': String(result.totalRows),
      // A file of every customer you have must not sit in a shared cache.
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
