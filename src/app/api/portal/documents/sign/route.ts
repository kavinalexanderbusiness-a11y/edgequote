import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { DOCUMENTS_BUCKET, signaturePath } from '@/lib/documents'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f-]{36}$/i
/** A drawn mark is a small PNG. Anything larger is not a signature. */
const MAX_SIGNATURE_BYTES = 512 * 1024

// ── A customer signs ─────────────────────────────────────────────────────────
//
// TWO PHASES, because a file has to be written to storage between them:
//
//   1. portal_signature_target — may this token's customer sign this document,
//      and if so, WHICH request and WHICH version? Asked before a single byte is
//      written, so a forged token never causes a storage write.
//   2. portal_sign_document — records the acknowledgement, RE-PROVING every one
//      of those questions from scratch. Nothing learned in phase 1 is trusted in
//      phase 2; the route carries no authority between them.
//
// ⭐ IDENTITY COMES FROM THE TOKEN, NOT THE PAYLOAD. `signer_name` is what the
// person typed — a display identity, evidence of intent. The customer_id the
// record actually rests on is resolved by the database from the portal token.
// A client cannot nominate whose signature this is.
//
// ⭐ REPLAY IS REFUSED BY THE DATABASE. One request can be satisfied exactly
// once (document_signatures_one_per_request). A resent request — double tap,
// retry, deliberate replay — comes back `already_signed` from a unique
// violation, not from app-layer politeness that a race could slip past.
//
// ⛔ THE MARK IS NEVER STORED INLINE. It goes to the PRIVATE bucket under the
// tenant's own folder, and only its path is recorded. It is never returned by
// any list projection, and it must never be written into audit metadata when
// Session 68's trail lands.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const documentId = String(body.documentId || '')
  const signerName = String(body.signerName || '').trim()
  const dataUrl = typeof body.signature === 'string' ? body.signature : ''

  if (!token || !UUID.test(documentId)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  if (signerName.length < 1 || signerName.length > 120) {
    return NextResponse.json({ error: 'Please type your full name.' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const anon = createClient(url, anonKey)

  // ── Phase 1 · may they? ────────────────────────────────────────────────────
  const { data: targetJson, error: targetErr } = await anon.rpc('portal_signature_target', {
    p_token: token,
    p_document_id: documentId,
  })
  if (targetErr) {
    return NextResponse.json({ error: "We couldn't reach the server. Try again." }, { status: 502 })
  }
  if (!targetJson) {
    // Covers every refusal the RPC folds together on purpose: wrong token, wrong
    // customer, not shared, archived, no open request, already signed, or the
    // owner replaced the file after asking. The customer is told the same thing
    // in each case — which of those is true is not a customer's business, and
    // distinguishing them would be an oracle.
    return NextResponse.json(
      { error: 'This document is not waiting for your signature.' },
      { status: 404 },
    )
  }
  const target = targetJson as {
    request_id: string
    version_id: string
    tenant_id: string
  }

  // ── The mark ───────────────────────────────────────────────────────────────
  let path: string | null = null
  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  if (dataUrl) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) {
      return NextResponse.json({ error: 'That signature could not be read.' }, { status: 400 })
    }
    const bytes = Buffer.from(m[1], 'base64')
    if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES) {
      return NextResponse.json({ error: 'That signature could not be read.' }, { status: 400 })
    }
    // The path is built from the TENANT the database named — never from anything
    // the client sent — so it always satisfies the owner-scoped folder rule and
    // can never land in another tenant's folder.
    path = signaturePath(target.tenant_id, documentId, target.request_id)
    const { error: upErr } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .upload(path, bytes, { contentType: 'image/png', upsert: false })
    if (upErr) {
      return NextResponse.json({ error: 'Could not save the signature. Try again.' }, { status: 500 })
    }
  }

  // ── Phase 2 · record it, re-proving everything ─────────────────────────────
  const { data: signedJson, error: signErr } = await anon.rpc('portal_sign_document', {
    p_token: token,
    p_document_id: documentId,
    p_request_id: target.request_id,
    p_signer_name: signerName,
    p_signature_path: path,
  })

  const result = signedJson as { ok?: boolean; reason?: string; signed_at?: string } | null

  if (signErr || !result?.ok) {
    // Never leave an orphan mark behind if the acknowledgement didn't land — an
    // orphaned signature image is a privacy liability with nothing to explain it.
    if (path) await admin.storage.from(DOCUMENTS_BUCKET).remove([path]).catch(() => {})
    if (result?.reason === 'already_signed') {
      return NextResponse.json({ error: 'This document has already been signed.' }, { status: 409 })
    }
    if (signErr) {
      return NextResponse.json({ error: "We couldn't reach the server. Try again." }, { status: 502 })
    }
    return NextResponse.json(
      { error: 'This document is not waiting for your signature.' },
      { status: 404 },
    )
  }

  return NextResponse.json({ ok: true, signed_at: result.signed_at })
}
