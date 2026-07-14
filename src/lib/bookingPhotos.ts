import type { JobPhotoView } from '@/lib/photos'

// ── Booking photos ───────────────────────────────────────────────────────────
// Customers attach photos during online booking (book/[token]); the files are
// uploaded to the `booking-uploads` bucket and their public URLs are stored on the
// resulting DRAFT QUOTE at quotes.lead_meta.photos (see submit_booking). This module
// reads those existing URLs and adapts them to JobPhotoView so they render through
// the SAME read-only gallery/lightbox the rest of the app uses — no copy, no second
// store: the public URL IS the source.

// Pull the photo URLs a booking attached from a quote's lead_meta blob.
export function extractBookingPhotos(leadMeta: unknown): string[] {
  if (!leadMeta || typeof leadMeta !== 'object') return []
  const photos = (leadMeta as Record<string, unknown>).photos
  if (!Array.isArray(photos)) return []
  return photos.filter((p): p is string => typeof p === 'string' && /^https?:\/\//i.test(p.trim()))
}

// Adapt raw public URLs to JobPhotoView so <JobPhotos initialPhotos> can render them.
// storage_path holds the public URL — thumbUrl() rewrites `/object/public/` storage
// URLs to the render endpoint, so booking-uploads thumbnails still get sized down.
export function bookingPhotoViews(urls: string[], takenAt?: string | null): JobPhotoView[] {
  const when = takenAt || ''
  return urls.map((url, i) => ({
    id: `booking-${i}-${url.slice(-24)}`,
    created_at: when,
    user_id: '',
    job_id: null,
    property_id: null,
    customer_id: null,
    storage_path: url,
    kind: 'general',
    caption: null,
    taken_at: when,
    url,
  }))
}

// Flatten every booking photo across a customer's quotes (newest quote first),
// each stamped with its quote's date. Deduped by URL.
export function bookingPhotosFromQuotes(quotes: { lead_meta?: unknown; created_at?: string | null }[]): JobPhotoView[] {
  const seen = new Set<string>()
  const out: JobPhotoView[] = []
  for (const q of quotes) {
    for (const url of extractBookingPhotos(q.lead_meta)) {
      if (seen.has(url)) continue
      seen.add(url)
      out.push(...bookingPhotoViews([url], q.created_at ?? null))
    }
  }
  return out
}
