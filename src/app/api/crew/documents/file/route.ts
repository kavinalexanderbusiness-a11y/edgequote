import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveAppRole } from '@/lib/crewAccess'
import { DOCUMENTS_BUCKET } from '@/lib/documents'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f-]{36}$/i

// ── A worker opens a document attached to their visit ────────────────────────
//
// Same shape as /api/crew/media, and a server route for the same two reasons:
// a crew session holds NO table grants (Crew Mode's founding rule), and the
// `documents` bucket is PRIVATE with no crew storage policy.
//
// ⭐ WHY NO CREW STORAGE POLICY — the reasoning /api/crew/media already settled:
// a storage policy is evaluated per OBJECT, so it would have to re-derive "is
// this worker assigned to that visit" by parsing a job id out of a path string.
// That assignment check already exists in SQL, once, inside crew_document_file.
// A second copy written against a split path is a second chance to get it wrong.
//
// ⭐ THE AUTHORIZATION IS ASKED UNDER THE WORKER'S OWN IDENTITY. The RPC is
// called with the SESSION client, so crew_employer() and crew_crew_id() resolve
// from the caller's JWT — a deactivated or unlinked worker gets nothing, valid
// token and all. Only the storage read uses the service role, and only for the
// path the database returned.
//
// ⛔ Job-scoped only. There is no business-wide document browser for workers,
// and 'customer'-visibility documents are unreachable here by design: a worker
// sees what was shared TO THE WORK, not the customer's copy.
export async function GET(req: NextRequest) {
  const documentId = req.nextUrl.searchParams.get('document') || ''
  if (!UUID.test(documentId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })

  // Asked of the DATABASE, not inferred from a cookie or a route prefix.
  const role = await resolveAppRole(supabase)
  if (role !== 'crew') return NextResponse.json({ error: 'not allowed' }, { status: 403 })

  const { data, error } = await supabase.rpc('crew_document_file', { p_document_id: documentId })
  if (error) {
    return NextResponse.json({ error: "We couldn't reach the server. Try again." }, { status: 502 })
  }

  const result = data as { ok?: boolean; storage_path?: string; file_name?: string } | null
  if (!result?.ok || !result.storage_path) {
    // 'not_authorized' and 'not_found' collapse to one answer on purpose: which
    // one it was would tell a worker whether a document they cannot open exists.
    return NextResponse.json({ error: 'That document is not available.' }, { status: 404 })
  }

  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const { data: signed } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(result.storage_path, 60, { download: result.file_name })

  if (!signed?.signedUrl) {
    return NextResponse.json({ error: 'That document is not available.' }, { status: 404 })
  }
  return NextResponse.redirect(signed.signedUrl)
}
