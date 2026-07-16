// DELETE /api/v1/hooks/:id — unsubscribe (Zapier calls this on Zap turn-off).
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, apiError } from '@/lib/integrations/apiAuth'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { auth, fail } = await authenticateRequest(req, 'write')
  if (!auth) return fail!
  const { id } = await ctx.params
  const { data, error } = await auth.sb.from('webhook_endpoints')
    .delete().eq('user_id', auth.userId).eq('id', id).select('id')
  if (error) return apiError(500, error.message)
  if (!data || data.length === 0) return apiError(404, 'Not found.')
  return NextResponse.json({ deleted: true })
}
