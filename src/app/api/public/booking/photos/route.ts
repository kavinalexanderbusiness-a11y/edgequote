import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { consumeTokenIntakeLimit } from '@/lib/publicIntakeSecurity'
import {
  CUSTOMER_UPLOAD_BUCKET,
  LEGACY_CUSTOMER_UPLOAD_BUCKET,
  customerUploadRef,
  inspectCustomerUploadBuckets,
  selectCustomerUploadTarget,
} from '@/lib/customerUploadPhotos'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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
      if (new URL(origin).origin !== new URL(req.url).origin) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
    } catch {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_FILE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'request too large' }, { status: 413 })
  }
  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })
  const form = await req.formData().catch(() => null)
  const token = String(form?.get('token') || '').trim()
  const file = form?.get('photo')
  if (!token || !(file instanceof File)) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  if (!TYPES.has(file.type) || file.size < 1 || file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'invalid image' }, { status: 400 })
  }

  const { data: settings } = await admin.from('business_settings')
    .select('user_id').eq('booking_token', token).eq('booking_enabled', true).maybeSingle()
  const userId = typeof settings?.user_id === 'string' ? settings.user_id : ''
  if (!userId) return NextResponse.json({ error: 'booking unavailable' }, { status: 404 })

  const rate = await consumeTokenIntakeLimit(req, token, 'booking-photo', 18)
  if (rate === 'limited') return NextResponse.json({ error: 'too many uploads' }, { status: 429 })
  if (rate === 'unavailable') return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!magicMatches(bytes, file.type)) return NextResponse.json({ error: 'invalid image' }, { status: 400 })
  const ext = TYPES.get(file.type)!
  const buckets = await inspectCustomerUploadBuckets(admin)
  const target = buckets && selectCustomerUploadTarget(buckets, file.type)
  if (!target) return NextResponse.json({ error: 'upload unavailable' }, { status: 503 })

  const path = `${userId}/booking/${crypto.randomUUID()}.${ext}`
  const { error } = await admin.storage.from(target.bucket)
    .upload(path, bytes, { contentType: file.type, upsert: false })
  if (error) return NextResponse.json({ error: 'upload failed' }, { status: 502 })

  // Compatibility release: before the private bucket exists, preserve the old
  // durable public-URL contract. Both old clients (`url`) and the new client
  // (`ref` + `previewUrl`) can consume this response. Once customer-uploads
  // exists, selectCustomerUploadTarget never falls back to this branch.
  if (target.mode === 'legacy') {
    const url = admin.storage.from(LEGACY_CUSTOMER_UPLOAD_BUCKET).getPublicUrl(path).data.publicUrl
    return NextResponse.json(
      { ok: true, url, ref: url, previewUrl: url },
      { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    )
  }

  const ref = customerUploadRef(path)
  if (!ref) {
    await admin.storage.from(CUSTOMER_UPLOAD_BUCKET).remove([path])
    return NextResponse.json({ error: 'upload failed' }, { status: 502 })
  }
  // A short-lived preview lets the customer verify the selected image without
  // turning its permanent database reference into a bearer URL.
  const { data: preview, error: signError } = await admin.storage.from(CUSTOMER_UPLOAD_BUCKET)
    .createSignedUrl(path, 15 * 60)
  if (signError || !preview?.signedUrl) {
    await admin.storage.from(CUSTOMER_UPLOAD_BUCKET).remove([path])
    return NextResponse.json({ error: 'upload failed' }, { status: 502 })
  }
  return NextResponse.json(
    // `url` carries the durable ref during the rolling client cutover. A cached
    // old client may show no thumbnail, but it still persists the correct private
    // reference instead of an expiring signed URL or a public object URL.
    { ok: true, url: ref, ref, previewUrl: preview.signedUrl },
    { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  )
}
