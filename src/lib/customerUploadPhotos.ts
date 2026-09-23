import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Future customer-supplied quote photos live in a private bucket. The database
 * stores this durable, non-secret reference; browsers and email never receive a
 * permanent object URL.
 */
export const CUSTOMER_UPLOAD_BUCKET = 'customer-uploads'
export const LEGACY_CUSTOMER_UPLOAD_BUCKET = 'booking-uploads'
export const CUSTOMER_UPLOAD_REF_PREFIX = 'customer-upload:'
export const CUSTOMER_UPLOAD_SIGNED_SECONDS = 300

export interface CustomerUploadBucketInfo {
  id?: string | null
  name?: string | null
  public?: boolean | null
  allowed_mime_types?: string[] | null
}

export type CustomerUploadTarget = {
  bucket: typeof CUSTOMER_UPLOAD_BUCKET | typeof LEGACY_CUSTOMER_UPLOAD_BUCKET
  mode: 'private' | 'legacy'
}

/**
 * Choose the customer-photo store from storage's own committed bucket catalog.
 *
 * Before the private-storage migration, only the legacy public bucket exists.
 * After it, the private bucket's presence is the cutover marker. A malformed or
 * public customer-uploads bucket is never treated as usable, and we never fall
 * back when it exists: configuration drift must fail closed instead of silently
 * publishing a new customer photo.
 *
 * The final migration also makes booking-uploads image-write-ineligible. Checking
 * its MIME allowlist means a deleted/private-bucket regression remains closed even
 * though the historical public bucket still exists for reads.
 */
export function selectCustomerUploadTarget(
  buckets: CustomerUploadBucketInfo[],
  contentType: string,
): CustomerUploadTarget | null {
  const byName = (name: string) => buckets.find(bucket => bucket.id === name || bucket.name === name)
  const allows = (bucket: CustomerUploadBucketInfo, type: string) => {
    const types = bucket.allowed_mime_types
    return !Array.isArray(types) || types.includes(type)
  }
  const privateBucket = byName(CUSTOMER_UPLOAD_BUCKET)
  if (privateBucket) {
    return privateBucket.public === false && allows(privateBucket, contentType)
      ? { bucket: CUSTOMER_UPLOAD_BUCKET, mode: 'private' }
      : null
  }
  const legacy = byName(LEGACY_CUSTOMER_UPLOAD_BUCKET)
  return legacy?.public === true && allows(legacy, contentType)
    ? { bucket: LEGACY_CUSTOMER_UPLOAD_BUCKET, mode: 'legacy' }
    : null
}

/** A failed bucket-catalog read is never evidence that the migration is absent. */
export async function inspectCustomerUploadBuckets(
  admin: SupabaseClient,
): Promise<CustomerUploadBucketInfo[] | null> {
  const { data, error } = await admin.storage.listBuckets()
  return error || !Array.isArray(data) ? null : data
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const PATH = new RegExp(
  `^(${UUID})/(?:(booking|website)/(${UUID})|(portal)/(${UUID})/(${UUID}))\\.(jpg|jpeg|png|webp|heic|heif)$`,
  'i',
)

export function customerUploadRef(path: string): string | null {
  const clean = path.trim().replace(/^\/+/, '')
  return PATH.test(clean) ? `${CUSTOMER_UPLOAD_REF_PREFIX}${clean}` : null
}

export function customerUploadPath(ref: string): string | null {
  const clean = ref.trim()
  if (!clean.startsWith(CUSTOMER_UPLOAD_REF_PREFIX)) return null
  const path = clean.slice(CUSTOMER_UPLOAD_REF_PREFIX.length)
  return PATH.test(path) ? path : null
}

export function customerUploadOwnerId(ref: string): string | null {
  const path = customerUploadPath(ref)
  return path ? path.split('/')[0] : null
}

/**
 * Compatibility for records created before private customer storage. Only the
 * former Supabase booking bucket is accepted: an arbitrary remote URL in public
 * lead data must not become a tracking pixel in the owner's browser.
 */
export function safeLegacyCustomerPhotoUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:') return null
    const configured = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (configured && new URL(configured).hostname !== url.hostname) return null
    if (!configured && !url.hostname.endsWith('.supabase.co')) return null
    if (!url.pathname.startsWith(`/storage/v1/object/public/${LEGACY_CUSTOMER_UPLOAD_BUCKET}/`)) return null
    return url.toString()
  } catch {
    return null
  }
}

export function customerPhotoReference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const privatePath = customerUploadPath(value)
  if (privatePath) return `${CUSTOMER_UPLOAD_REF_PREFIX}${privatePath}`
  return safeLegacyCustomerPhotoUrl(value)
}

/** Authenticated owner-reader URL. The route verifies session + tenant path and
 * then redirects to a five-minute Supabase signature. */
export function customerPhotoDisplayUrl(ref: string): string {
  const path = customerUploadPath(ref)
  return path ? `/api/customer-photos/file?ref=${encodeURIComponent(ref)}` : (safeLegacyCustomerPhotoUrl(ref) || '')
}

/** Resolve links for a one-time owner email. Legacy public URLs pass through;
 * private references are signed in one request and expire quickly. */
export async function signedCustomerPhotoUrls(
  admin: SupabaseClient,
  refs: unknown,
  ownerId: string,
  seconds = 60 * 60,
): Promise<string[]> {
  if (!Array.isArray(refs)) return []
  const values = refs.map(customerPhotoReference).filter((v): v is string => !!v)
  const legacy = values.filter(v => !!safeLegacyCustomerPhotoUrl(v))
  const paths = values
    .map(v => ({ ref: v, path: customerUploadPath(v) }))
    .filter((x): x is { ref: string; path: string } => !!x.path && x.path.split('/')[0] === ownerId)
  if (!paths.length) return legacy
  const { data, error } = await admin.storage.from(CUSTOMER_UPLOAD_BUCKET)
    .createSignedUrls(paths.map(x => x.path), seconds)
  if (error) return legacy
  const signed = (data || []).map(x => x.signedUrl).filter((v): v is string => typeof v === 'string' && !!v)
  return [...legacy, ...signed]
}
