import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { consumeTokenIntakeLimit } from '@/lib/publicIntakeSecurity'
import {
  CUSTOMER_UPLOAD_BUCKET, customerUploadRef, inspectCustomerUploadBuckets,
  selectCustomerUploadTarget,
} from '@/lib/customerUploadPhotos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FILE_BYTES = 12 * 1024 * 1024
const TYPES = new Map([
  ['image/jpeg', 'jpg'], ['image/jpg', 'jpg'], ['image/png', 'png'],
  ['image/webp', 'webp'], ['image/heic', 'heic'], ['image/heif', 'heif'],
])

function magicMatches(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/jpeg' || type === 'image/jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/png') return bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
  if (type === 'image/webp') return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  if (type === 'image/heic' || type === 'image/heif') return new TextDecoder().decode(bytes.slice(4, 12)).includes('ftyp')
  return false
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    } catch { return NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  const length = Number(req.headers.get('content-length') || 0)
  if (length > MAX_FILE_BYTES + 1024 * 1024) return NextResponse.json({ error: 'request too large' }, { status: 413 })
  const form = await req.formData().catch(() => null)
  const token = String(form?.get('token') || '').trim()
  const file = form?.get('photo')
  if (!token || !(file instanceof File)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!TYPES.has(file.type) || file.size < 1 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'invalid image' }, { status: 400 })
  }
  const rate = await consumeTokenIntakeLimit(req, token, 'portal-photo', 18)
  if (rate === 'limited') return NextResponse.json({ error: 'too many uploads' }, { status: 429 })
  if (rate === 'unavailable') return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })

  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })
  const { data: portal } = await admin.from('customer_portal_tokens')
    .select('user_id, customer_id').eq('token', token).eq('revoked', false).maybeSingle()
  const userId = typeof portal?.user_id === 'string' ? portal.user_id : ''
  if (!userId) return NextResponse.json({ error: 'portal unavailable' }, { status: 404 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!magicMatches(bytes, file.type)) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
  const buckets = await inspectCustomerUploadBuckets(admin)
  const target = buckets && selectCustomerUploadTarget(buckets, file.type)
  if (!target) return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })

  const batchId = crypto.randomUUID()
  const fileId = crypto.randomUUID()
  const suffix = `${batchId}/${fileId}.${TYPES.get(file.type)!}`
  const path = target.mode === 'private' ? `${userId}/portal/${suffix}` : `portal/${suffix}`
  const { error } = await admin.storage.from(target.bucket)
    .upload(path, bytes, { contentType: file.type, upsert: false })
  if (error) return NextResponse.json({ error: 'upload failed' }, { status: 502 })
  if (target.mode === 'legacy') {
    return NextResponse.json({ ok: true, ref: path }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const ref = customerUploadRef(path)
  if (!ref) {
    await admin.storage.from(CUSTOMER_UPLOAD_BUCKET).remove([path])
    return NextResponse.json({ error: 'upload failed' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, ref }, { headers: { 'Cache-Control': 'no-store' } })
}
