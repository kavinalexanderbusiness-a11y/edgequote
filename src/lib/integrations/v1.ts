// Shared handlers for the /api/v1 resource routes — one behavior, four
// resources. Every read: key-authed ('read' scope), owner-scoped explicitly
// (admin client bypasses RLS), newest-first, ?limit/?offset/?since, plus
// per-resource equality filters. Responses use the SAME field sets as the
// webhook payloads (SERIALIZED_FIELDS), so the API and events describe
// entities identically.

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { authenticateRequest, listParams, listEnvelope, apiError } from './apiAuth'
import { SERIALIZED_FIELDS, serializeEntity, type IntegrationEntity } from './events'

const TABLES: Record<IntegrationEntity, string> = {
  customer: 'customers',
  quote: 'quotes',
  job: 'jobs',
  invoice: 'invoices',
  payment: 'payments',
  request: 'service_requests',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function listHandler(entity: IntegrationEntity, filters: string[] = []) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const { auth, fail } = await authenticateRequest(req, 'read')
    if (!auth) return fail!
    const { limit, offset, since } = listParams(req)
    let q = auth.sb.from(TABLES[entity])
      .select(SERIALIZED_FIELDS[entity].join(', '))
      .eq('user_id', auth.userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit) // limit+1 rows → has_more
    if (since) q = q.gte('created_at', since)
    for (const f of filters) {
      const v = req.nextUrl.searchParams.get(f)
      if (v) q = q.eq(f, v)
    }
    const { data, error } = await q
    if (error) return apiError(500, error.message)
    const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => serializeEntity(entity, r))
    return NextResponse.json(listEnvelope(rows, limit))
  }
}

export function itemHandler(entity: IntegrationEntity) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
    const { auth, fail } = await authenticateRequest(req, 'read')
    if (!auth) return fail!
    const { id } = await ctx.params
    if (!UUID_RE.test(id)) return apiError(404, 'Not found.')
    const { data, error } = await auth.sb.from(TABLES[entity])
      .select(SERIALIZED_FIELDS[entity].join(', '))
      .eq('user_id', auth.userId).eq('id', id).maybeSingle()
    if (error) return apiError(500, error.message)
    if (!data) return apiError(404, 'Not found.')
    return NextResponse.json({ data: serializeEntity(entity, data as unknown as Record<string, unknown>) })
  }
}
