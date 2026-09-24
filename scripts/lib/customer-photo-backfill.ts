import { createHash } from 'node:crypto'

export const SOURCE_BUCKET = 'booking-uploads'
export const TARGET_BUCKET = 'customer-uploads'
export const PRIVATE_PREFIX = 'customer-upload:'
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const PORTAL_PATH = new RegExp(`^portal/(${UUID})/(${UUID})\\.(jpg|jpeg|png|webp|heic|heif)$`, 'i')
const SAFE_EXT = /^(jpg|jpeg|png|webp|heic|heif)$/i

export type Surface = 'website' | 'quote' | 'portal'

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A deterministic RFC-4122-shaped v5 UUID, derived from content, for resumable paths. */
export function uuidFromHash(hash: string): string {
  const h = hash.toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(32, '0').slice(0, 32).split('')
  h[12] = '5'
  h[16] = ['8', '9', 'a', 'b'][parseInt(h[16] || '0', 16) % 4]
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export function sourcePathFromPublicUrl(value: unknown, supabaseUrl: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const candidate = new URL(value.trim())
    const configured = new URL(supabaseUrl)
    if (candidate.protocol !== 'https:' || candidate.hostname !== configured.hostname) return null
    const prefix = `/storage/v1/object/public/${SOURCE_BUCKET}/`
    if (!candidate.pathname.startsWith(prefix)) return null
    const path = decodeURIComponent(candidate.pathname.slice(prefix.length)).replace(/^\/+/, '')
    if (!path || path.includes('..') || path.includes('\\') || path.split('/').some(p => !p)) return null
    return path
  } catch { return null }
}

export function sourcePathForSurface(opts: { value: unknown; surface: Surface; supabaseUrl: string; bookingToken?: string }): string | null {
  if (opts.surface === 'portal') {
    if (typeof opts.value !== 'string') return null
    const path = opts.value.trim().replace(/^\/+/, '')
    return PORTAL_PATH.test(path) ? path : null
  }
  const path = sourcePathFromPublicUrl(opts.value, opts.supabaseUrl)
  if (!path || !opts.bookingToken || !path.startsWith(`${opts.bookingToken}/`)) return null
  return path
}

function sourceExt(path: string, contentType = ''): string | null {
  const byType: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  }
  const mime = contentType.toLowerCase().split(';')[0].trim()
  if (byType[mime]) return byType[mime]
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || ''
  return SAFE_EXT.test(ext) ? ext : null
}

export function targetForBytes(opts: { ownerId: string; surface: Surface; sourcePath: string; bytes: Uint8Array; contentType?: string }): { path: string; ref: string; hash: string; size: number; contentType: string } | null {
  const hash = sha256(opts.bytes)
  const objectId = uuidFromHash(hash)
  const ext = sourceExt(opts.sourcePath, opts.contentType)
  if (!ext || !new RegExp(`^${UUID}$`, 'i').test(opts.ownerId)) return null
  let path: string
  if (opts.surface === 'portal') {
    const m = opts.sourcePath.match(PORTAL_PATH)
    if (!m) return null
    path = `${opts.ownerId}/portal/${m[1]}/${m[2]}.${ext}`
  } else {
    path = `${opts.ownerId}/${opts.surface === 'website' ? 'website' : 'booking'}/${objectId}.${ext}`
  }
  return { path, ref: `${PRIVATE_PREFIX}${path}`, hash, size: opts.bytes.byteLength, contentType: opts.contentType || `image/${ext === 'jpg' ? 'jpeg' : ext}` }
}

export function replaceExact(values: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(values)) return values
  return values.map(value => typeof value === 'string' && replacements.has(value) ? replacements.get(value)! : value)
}

export function rewriteWebsiteSubmission(raw: Record<string, unknown>, replacements: ReadonlyMap<string, string>, recovered: ReadonlyMap<number, string>): Record<string, unknown> {
  const next = { ...raw }
  const photos = Array.isArray(raw.photos) ? replaceExact(raw.photos, replacements) as unknown[] : []
  const pending = Array.isArray(raw.photos_unprocessed) ? raw.photos_unprocessed : []
  const kept: unknown[] = []
  for (let i = 0; i < pending.length; i++) {
    const ref = recovered.get(i)
    if (ref) photos.push(ref)
    else kept.push(pending[i])
  }
  if (Array.isArray(raw.photos) || recovered.size) next.photos = photos
  if (kept.length) next.photos_unprocessed = kept
  else delete next.photos_unprocessed
  const priorFailures = Number(raw.photos_failed)
  if (Number.isFinite(priorFailures)) {
    const remaining = Math.max(0, priorFailures - recovered.size)
    if (remaining) next.photos_failed = remaining
    else delete next.photos_failed
  }
  return next
}

export function rewriteWebsiteSubmissionWithInline(
  raw: Record<string, unknown>,
  replacements: ReadonlyMap<string, string>,
  recoveredPending: ReadonlyMap<number, string>,
  recoveredPhotos: ReadonlyMap<number, string>,
): Record<string, unknown> {
  const next = rewriteWebsiteSubmission(raw, replacements, recoveredPending)
  if (!Array.isArray(next.photos)) return next
  next.photos = next.photos.map((value, index) => recoveredPhotos.get(index) || value)
  return next
}

export function pgArrayLiteral(values: string[]): string {
  return `{${values.map(v => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
