// GET  /api/v1/customers — list (newest first; ?limit ?offset ?since)
// POST /api/v1/customers — find-or-create ('write' scope). Dedup matches the
// intake doors (phone last-10 → exact email); `created` says which happened.
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, apiError } from '@/lib/integrations/apiAuth'
import { listHandler } from '@/lib/integrations/v1'
import { serializeEntity, SERIALIZED_FIELDS } from '@/lib/integrations/events'
import { findOrCreateCustomer } from '@/lib/integrations/inboundActions'

export const dynamic = 'force-dynamic'

export const GET = listHandler('customer')

export async function POST(req: NextRequest) {
  const { auth, fail } = await authenticateRequest(req, 'write')
  if (!auth) return fail!
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Body must be JSON.')
  }
  const str = (k: string) => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : null)
  const name = str('name')
  if (!name) return apiError(422, "'name' is required.")

  const found = await findOrCreateCustomer(auth.sb, auth.userId, {
    name, email: str('email'), phone: str('phone'), address: str('address'),
    city: str('city'), province: str('province'), postal_code: str('postal_code'),
    notes: str('notes'), source: str('source') ?? 'api',
  })
  if ('error' in found) return apiError(500, found.error)

  const { data } = await auth.sb.from('customers')
    .select(SERIALIZED_FIELDS.customer.join(', '))
    .eq('user_id', auth.userId).eq('id', found.id).single()
  return NextResponse.json(
    { data: serializeEntity('customer', (data ?? { id: found.id }) as unknown as Record<string, unknown>), created: !found.deduped },
    { status: found.deduped ? 200 : 201 },
  )
}
