import { createAdminClient } from '@/lib/supabase/admin'
import { PHOTO_BUCKET } from '@/lib/photos'

// ── Website-lead photo ingestion (server-only) ───────────────────────────────
// A website lead can arrive with photos (image URLs or data: URIs in the payload).
// The anon submission can't write to the owner's private storage, so this runs
// server-side with the SERVICE ROLE and funnels them into the SAME photo engine
// the rest of the app uses: the public `job-photos` bucket + the `job_photos`
// catalogue, linked to the lead's customer_id + property_id (job_id stays null).
// That means the photos show up automatically on the property gallery / customer
// profile and are preserved when the lead becomes a quote — no second system.
//
// NEVER import this into client code (the admin key bypasses RLS).

const MAX_PHOTOS = 12
const MAX_BYTES = 15 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12000
const POOL = 4

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
}

interface NormPhoto { url: string; caption: string | null; takenAt: string | null }

// Accept `photos` as an array of URL/data-URI strings OR objects {url|dataUrl|src,
// caption?, takenAt?}. Anything else is ignored. Capped so a hostile payload can't
// make us fetch hundreds of URLs.
function normalizePhotos(input: unknown): NormPhoto[] {
  if (!Array.isArray(input)) return []
  const out: NormPhoto[] = []
  for (const item of input) {
    let url = '', caption: string | null = null, takenAt: string | null = null
    if (typeof item === 'string') url = item.trim()
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      url = String(o.url || o.dataUrl || o.src || o.href || '').trim()
      caption = typeof o.caption === 'string' ? (o.caption.trim() || null) : null
      takenAt = typeof o.takenAt === 'string' ? o.takenAt : typeof o.taken_at === 'string' ? (o.taken_at as string) : null
    }
    if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) out.push({ url, caption, takenAt })
    if (out.length >= MAX_PHOTOS) break
  }
  return out
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const ab = await res.arrayBuffer()
    if (ab.byteLength === 0 || ab.byteLength > MAX_BYTES) return null
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const contentType = ct.startsWith('image/') ? ct : 'image/jpeg'
    return { bytes: Buffer.from(ab), contentType }
  } catch { return null }
}

// Run tasks with a small concurrency cap (server-side — no browser connection cap,
// but keep it modest so one lead doesn't stampede storage).
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Ingest a lead's photos. Best-effort and self-contained: any failure is swallowed
// so it can NEVER fail the lead itself (the lead + notification already committed
// in submit_website_lead). Returns how many photos were stored.
export async function ingestLeadPhotos(opts: {
  token: string
  customerId: string
  propertyId?: string | null
  conversationId?: string | null
  photos: unknown
}): Promise<{ count: number }> {
  const photos = normalizePhotos(opts.photos)
  if (!photos.length || !opts.customerId) return { count: 0 }

  const admin = createAdminClient()
  if (!admin) { console.error('[leadPhotos] service role not configured — skipping ingest'); return { count: 0 } }

  try {
    // Resolve the owner from the booking token (never trust a user_id from the wire).
    const { data: biz } = await admin.from('business_settings')
      .select('user_id').eq('booking_token', (opts.token || '').trim()).maybeSingle()
    const userId = (biz as { user_id?: string } | null)?.user_id
    if (!userId) return { count: 0 }

    const propertyId = opts.propertyId ?? null
    const rand = () => Math.random().toString(36).slice(2, 8)

    const paths = (await pooled(photos, POOL, async (p) => {
      const img = await fetchImage(p.url)
      if (!img) return null
      const ext = EXT_BY_TYPE[img.contentType] || 'jpg'
      const path = `${userId}/${propertyId || 'lead'}/${Date.now()}-${rand()}.${ext}`
      const up = await admin.storage.from(PHOTO_BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: false })
      if (up.error) return null
      const row: Record<string, unknown> = {
        user_id: userId, customer_id: opts.customerId, property_id: propertyId, job_id: null,
        storage_path: path, kind: 'general', caption: p.caption,
      }
      if (p.takenAt) row.taken_at = p.takenAt
      const ins = await admin.from('job_photos').insert(row)
      if (ins.error) { await admin.storage.from(PHOTO_BUCKET).remove([path]); return null }
      return path
    })).filter((x): x is string => !!x)

    if (paths.length === 0) return { count: 0 }

    // Post a "Customer uploaded X photos" event into the conversation, carrying the
    // storage paths in meta so the thread can render thumbnails. suppress_notification
    // stops it double-notifying the owner (the lead notification already fired, with
    // the count baked into its summary).
    let convo = opts.conversationId ?? null
    if (!convo) {
      const { data: c } = await admin.from('conversations')
        .select('id').eq('user_id', userId).eq('customer_id', opts.customerId).limit(1).maybeSingle()
      convo = (c as { id?: string } | null)?.id ?? null
    }
    if (convo) {
      const n = paths.length
      await admin.from('messages').insert({
        user_id: userId, conversation_id: convo, customer_id: opts.customerId,
        direction: 'inbound', channel: 'portal', status: 'received',
        body: `Customer uploaded ${n} photo${n === 1 ? '' : 's'}`,
        meta: { kind: 'lead_photos', paths, suppress_notification: true },
      })
    }

    return { count: paths.length }
  } catch (e) {
    console.error('[leadPhotos] ingest failed:', e instanceof Error ? e.message : e)
    return { count: 0 }
  }
}
