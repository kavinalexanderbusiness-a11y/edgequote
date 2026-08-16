import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { DOCUMENTS_BUCKET } from '@/lib/documents'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f-]{36}$/i

// ── A customer opens a document they were sent ───────────────────────────────
//
// Public, token-scoped. It has to be a server route for one reason: the
// `documents` bucket is PRIVATE and carries no anon storage policy, so a signed
// URL cannot be minted client-side. The portal LIST is a plain client-side RPC
// (portal_get_documents) exactly like portal_get_messages — only the file needs
// a server.
//
// ⭐ THE CALLER NAMES A DOCUMENT, NEVER A PATH. `portal_document_file` returns
// the storage path only after proving, in SQL, that this token's customer is the
// one the document resolves to, that it is shared with the customer, and that it
// is not archived. The path this route signs is the path the DATABASE chose, so
// a crafted path — another tenant's object, another customer's permit, a
// signature image — never enters the flow at all.
//
// ⛔ Deliberately no path, bucket or tenant id in the query string. The only
// two things a client sends are a token it already holds and a document id, and
// neither is trusted: both are filter inputs to the RPC, not instructions.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || ''
  const documentId = req.nextUrl.searchParams.get('document') || ''
  if (!token || !UUID.test(documentId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  // Asked as anon, which is what a portal visitor actually is. The RPC is
  // SECURITY DEFINER and re-scopes by the token it was handed.
  const anon = createClient(url, anonKey)
  const { data, error } = await anon.rpc('portal_document_file', {
    p_token: token,
    p_document_id: documentId,
  })

  // ⭐ A failed read is not "no such document". Saying 404 when the database
  // never answered would tell a customer their permit is gone when the truth is
  // that we could not look.
  if (error) {
    return NextResponse.json({ error: "We couldn't reach the server. Try again." }, { status: 502 })
  }
  if (!data) {
    return NextResponse.json({ error: 'This document is not available.' }, { status: 404 })
  }

  const file = data as { storage_path: string; file_name: string; mime: string | null }

  const admin = createAdminClient()
  if (!admin) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  // Short-lived and single-purpose. `download` makes the browser save it under
  // the name the owner uploaded rather than the random storage key.
  const { data: signed } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(file.storage_path, 60, { download: file.file_name })

  if (!signed?.signedUrl) {
    return NextResponse.json({ error: 'This document is not available.' }, { status: 404 })
  }
  return NextResponse.redirect(signed.signedUrl)
}
