// /api/v1 request authentication — API key → owner, in one DB round trip.
//
// The key arrives as `Authorization: Bearer eq_live_…` (or `x-api-key`). We
// hash it and call authenticate_api_key(), a service-role-only RPC that looks
// the hash up, bumps usage, and enforces the fixed-window rate limit
// atomically. Routes then scope every query with .eq('user_id', auth.userId)
// — the admin client bypasses RLS, so the explicit scope is the tenancy wall.
//
// Server-only: imports the admin client. Never import from client code.

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { hashApiKey, isApiKeyShaped, type ApiScope } from './keys'

export interface ApiKeyAuth {
  sb: SupabaseClient
  userId: string
  keyId: string
  keyName: string
  scopes: string[]
}

export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

function bearerToken(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim()
  return (req.headers.get('x-api-key') ?? '').trim()
}

export async function authenticateRequest(
  req: NextRequest,
  requiredScope: ApiScope,
): Promise<{ auth?: ApiKeyAuth; fail?: NextResponse }> {
  const raw = bearerToken(req)
  if (!raw) return { fail: apiError(401, 'Missing API key. Send it as: Authorization: Bearer eq_live_…') }
  if (!isApiKeyShaped(raw)) return { fail: apiError(401, 'Invalid API key.') }

  const sb = createAdminClient()
  if (!sb) return { fail: apiError(500, 'API not configured on this deployment.') }

  const { data, error } = await sb.rpc('authenticate_api_key', { p_hash: hashApiKey(raw) })
  if (error) return { fail: apiError(500, 'Authentication failed.') }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return { fail: apiError(401, 'Invalid API key.') }
  if (row.rate_limited) return { fail: apiError(429, 'Rate limit exceeded (120 requests/minute). Slow down and retry.') }

  const scopes: string[] = row.key_scopes ?? []
  if (!scopes.includes(requiredScope)) {
    return { fail: apiError(403, `This key is missing the '${requiredScope}' scope.`) }
  }
  return {
    auth: { sb, userId: row.key_user_id, keyId: row.key_id, keyName: row.key_name, scopes },
  }
}

export interface ListParams {
  limit: number
  offset: number
  since: string | null
}

/** Shared list-query params: ?limit= (1–200, default 50), ?offset=, ?since= (ISO). */
export function listParams(req: NextRequest): ListParams {
  const q = req.nextUrl.searchParams
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50))
  const offset = Math.max(0, Number(q.get('offset')) || 0)
  const sinceRaw = q.get('since')
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null
  return { limit, offset, since }
}

/** Standard list envelope: fetch limit+1 rows and flag has_more. */
export function listEnvelope<T>(rows: T[], limit: number) {
  return { data: rows.slice(0, limit), has_more: rows.length > limit }
}
