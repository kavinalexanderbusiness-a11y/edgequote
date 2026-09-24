import { createHash, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { resolveWebsiteLeadSite } from '@/lib/publicIntakeSecurity'
import { createAdminClient } from '@/lib/supabase/admin'
import { logSafeServerError, logSecurityEvent } from '@/lib/serverError'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 5

const SITE_ID = 'edge-property-services-yyc'
const MAX_BODY_BYTES = 512
const HEX_SHA256 = /^[a-f0-9]{64}$/

function authorized(req: NextRequest): boolean {
  const expected = (process.env.EDGE_ESTIMATOR_GATE_SECRET || '').trim()
  const header = req.headers.get('authorization') || ''
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (expected.length < 32 || !supplied) return false
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}

function responseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  }
}

export async function POST(req: NextRequest) {
  const headers = responseHeaders()
  if (!authorized(req)) {
    logSecurityEvent('estimator_gate_rejected', { reason: 'authorization' })
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers })
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }
  const declaredLength = Number(req.headers.get('content-length') || 0)
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'request too large' }, { status: 413, headers })
  }
  const text = await req.text().catch(() => '')
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }
  const body = (() => { try { return JSON.parse(text) as unknown } catch { return null } })()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }
  const keys = Object.keys(body)
  const fingerprint = (body as { fingerprint?: unknown }).fingerprint
  if (keys.length !== 1 || keys[0] !== 'fingerprint' || typeof fingerprint !== 'string' || !HEX_SHA256.test(fingerprint)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }

  const site = await resolveWebsiteLeadSite(SITE_ID)
  const admin = createAdminClient()
  if (!site || !admin) {
    logSafeServerError('estimator_gate.configuration_unavailable', null)
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers })
  }

  const globalFingerprint = createHash('sha256').update(`${SITE_ID}:global`).digest('hex')
  const perIp = await admin.rpc('consume_public_intake_rate_limit', {
    p_token: site.token,
    p_ip_hash: fingerprint,
    p_scope: 'lawn-estimator-ip',
    p_limit: 12,
    p_window_seconds: 3600,
  })
  if (perIp.error || typeof perIp.data !== 'boolean') {
    logSafeServerError('estimator_gate.rate_limit_unavailable', perIp.error)
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers })
  }
  // Check the per-IP bucket first so one abusive address cannot consume every
  // slot in the site-wide City-data budget after it is already blocked.
  if (!perIp.data) {
    logSecurityEvent('estimator_gate_rate_limited', { scope: 'ip' })
    return NextResponse.json(
      { allowed: false },
      { status: 429, headers: { ...headers, 'Retry-After': '3600' } },
    )
  }
  const global = await admin.rpc('consume_public_intake_rate_limit', {
    p_token: site.token,
    p_ip_hash: globalFingerprint,
    p_scope: 'lawn-estimator-global',
    p_limit: 100,
    p_window_seconds: 3600,
  })
  if (global.error || typeof global.data !== 'boolean') {
    logSafeServerError('estimator_gate.rate_limit_unavailable', global.error)
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers })
  }
  if (!global.data) {
    logSecurityEvent('estimator_gate_rate_limited', { scope: 'global' })
    return NextResponse.json(
      { allowed: false },
      { status: 429, headers: { ...headers, 'Retry-After': '3600' } },
    )
  }
  return NextResponse.json({ allowed: true }, { status: 200, headers })
}
