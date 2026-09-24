import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  CUSTOMER_UPLOAD_BUCKET,
  CUSTOMER_UPLOAD_SIGNED_SECONDS,
  customerUploadOwnerId,
  customerUploadPath,
} from '@/lib/customerUploadPhotos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } })

  const ref = req.nextUrl.searchParams.get('ref') || ''
  const path = customerUploadPath(ref)
  if (!path || customerUploadOwnerId(ref) !== user.id) {
    return new NextResponse('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }

  const admin = createAdminClient()
  if (!admin) return new NextResponse('unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  const { data, error } = await admin.storage.from(CUSTOMER_UPLOAD_BUCKET)
    .createSignedUrl(path, CUSTOMER_UPLOAD_SIGNED_SECONDS)
  if (error || !data?.signedUrl) {
    return new NextResponse('unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.redirect(data.signedUrl, {
    status: 307,
    headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
  })
}
