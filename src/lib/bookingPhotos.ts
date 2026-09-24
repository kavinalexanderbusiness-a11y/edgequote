import type { JobPhotoView } from '@/lib/photos'
import { customerPhotoDisplayUrl, customerPhotoReference } from '@/lib/customerUploadPhotos'

// Customer quote photos are stored as durable private references. Historical
// booking-uploads public URLs remain readable while a production backfill is
// performed, but arbitrary remote URLs are rejected so a public form cannot add
// a tracking pixel to the owner's dashboard.
export function extractBookingPhotos(leadMeta: unknown): string[] {
  if (!leadMeta || typeof leadMeta !== 'object') return []
  const photos = (leadMeta as Record<string, unknown>).photos
  if (!Array.isArray(photos)) return []
  return photos.map(customerPhotoReference).filter((p): p is string => !!p)
}

// Private references point at a session-authenticated proxy which produces a
// fresh five-minute signature. Historical safe URLs stay unchanged.
export function bookingPhotoViews(refs: string[], takenAt?: string | null): JobPhotoView[] {
  const when = takenAt || ''
  return refs.map<JobPhotoView>((ref, i) => ({
    id: `booking-${i}-${ref.slice(-24)}`,
    created_at: when,
    user_id: '',
    job_id: null,
    property_id: null,
    customer_id: null,
    storage_path: ref,
    kind: 'general',
    caption: null,
    taken_at: when,
    url: customerPhotoDisplayUrl(ref),
  })).filter(p => !!p.url)
}

export function bookingPhotosFromQuotes(quotes: { lead_meta?: unknown; created_at?: string | null }[]): JobPhotoView[] {
  const seen = new Set<string>()
  const out: JobPhotoView[] = []
  for (const q of quotes) {
    for (const ref of extractBookingPhotos(q.lead_meta)) {
      if (seen.has(ref)) continue
      seen.add(ref)
      out.push(...bookingPhotoViews([ref], q.created_at ?? null))
    }
  }
  return out
}
