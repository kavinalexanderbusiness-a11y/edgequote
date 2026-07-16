// GET /api/v1/me — key introspection. Zapier/Make use this as the
// "test authentication" call; the label shown is the business name.
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/integrations/apiAuth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { auth, fail } = await authenticateRequest(req, 'read')
  if (!auth) return fail!
  const { data } = await auth.sb.from('business_settings')
    .select('company_name').eq('user_id', auth.userId).maybeSingle()
  return NextResponse.json({
    ok: true,
    business_name: data?.company_name ?? null,
    key_name: auth.keyName,
    scopes: auth.scopes,
  })
}
