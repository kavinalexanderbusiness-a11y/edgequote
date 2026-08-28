import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendEmail, commsEnabled } from '@/lib/comms/send'
import { sanitizeSourceInput } from '@/lib/attribution'

// ── Shared lead intake ───────────────────────────────────────────────────────
// THE single server-side door for turning ANY external submission (website
// contact / quote / booking forms, Formspree, a generic webhook, future
// integrations) into a customer + property + lead inside EdgeHQ. Every source
// funnels through the SAME submit_website_lead pipeline (dedup customer by
// phone→email→address, create/match property, write the lead, thread it into
// Messages, notify the owner) — only the `source` (acquisition_source) differs.
// No business logic is duplicated here; this just normalizes + forwards.

export interface IntakeResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

// ── Customer photos attached to a website lead ───────────────────────────────
// THE marketing site posts its photos INLINE as base64 objects
// (`photos: [{ base64, contentType, filename }]`) — it does not upload them
// anywhere itself. That payload was persisted verbatim into
// `website_leads.raw_submission`, so the bytes were technically kept, in a form
// NOTHING reads: every photo surface in the app looks for the canonical contract
// the BOOKING door already established — `photos: string[]` of public URLs
// (quotes.lead_meta.photos → lib/bookingPhotos.extractBookingPhotos → JobPhotos).
// That mismatch is why 17 real customer photos across 9 leads were invisible in
// the CRM and absent from the owner email, while raw_submission grew to 4 MB.
//
// So: decode → upload to the SAME `booking-uploads` bucket the booking door uses
// → rewrite `payload.photos` to the URL array BEFORE the RPC writes
// raw_submission. No new bucket, no new column, no second gallery, no migration —
// the existing canonical representation, reached from the second door.
export interface InlinePhoto { base64: string; contentType: string; filename: string }

// Matches the booking door's cap (BookingClient allows 6); the site's own "up to
// 5" is stricter, so this only ever bounds a malformed or hostile payload.
export const MAX_LEAD_PHOTOS = 6
// A public endpoint: bound one photo's decoded size so a giant paste can't be used
// to hammer storage. Comfortably above a phone photo.
export const MAX_LEAD_PHOTO_BYTES = 12 * 1024 * 1024

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
}

/**
 * Split a submission's `photos` into the inline base64 items we must upload and
 * the entries that are ALREADY canonical URLs (a future site version, or a
 * re-submission) which pass through untouched. Anything malformed is COUNTED, never
 * silently dropped — a lost photo the owner never hears about is the bug this fixes.
 */
export function extractInlinePhotos(payload: Record<string, unknown>): {
  inline: InlinePhoto[]; alreadyUrls: string[]; rejected: number
} {
  const raw = payload.photos
  if (!Array.isArray(raw)) return { inline: [], alreadyUrls: [], rejected: 0 }
  const inline: InlinePhoto[] = []
  const alreadyUrls: string[] = []
  let rejected = 0
  for (const item of raw) {
    // Already canonical — leave it exactly as it is.
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item.trim())) alreadyUrls.push(item.trim())
      else rejected++
      continue
    }
    if (inline.length + alreadyUrls.length >= MAX_LEAD_PHOTOS) { rejected++; continue }
    if (!item || typeof item !== 'object') { rejected++; continue }
    const o = item as Record<string, unknown>
    const b64 = typeof o.base64 === 'string' ? o.base64.trim() : ''
    if (!b64) { rejected++; continue }
    const ct = typeof o.contentType === 'string' && o.contentType.toLowerCase().startsWith('image/')
      ? o.contentType.toLowerCase() : 'image/jpeg'
    const fn = typeof o.filename === 'string' && o.filename.trim() ? o.filename.trim() : 'photo'
    inline.push({ base64: b64, contentType: ct, filename: fn })
  }
  return { inline, alreadyUrls, rejected }
}

/**
 * Decode one inline photo to bytes. Tolerates a `data:image/jpeg;base64,…` prefix
 * (the prefix's own type wins, since that's what the browser stamped) as well as a
 * bare base64 body, which is what the live site sends. Returns null when the value
 * isn't decodable or busts the size cap — the caller counts that as a failure
 * rather than pretending the photo never existed.
 */
export function decodeInlinePhoto(p: InlinePhoto): { bytes: Buffer; contentType: string; ext: string } | null {
  let body = p.base64
  let contentType = p.contentType
  if (body.startsWith('data:')) {
    const comma = body.indexOf(',')
    if (comma < 0) return null
    const header = body.slice(5, comma)
    const declared = header.split(';')[0].trim().toLowerCase()
    if (declared.startsWith('image/')) contentType = declared
    body = body.slice(comma + 1)
  }
  const cleaned = body.replace(/\s+/g, '')
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null
  let bytes: Buffer
  try { bytes = Buffer.from(cleaned, 'base64') } catch { return null }
  if (bytes.length === 0 || bytes.length > MAX_LEAD_PHOTO_BYTES) return null
  const fromName = (p.filename.match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toLowerCase()
  const ext = EXT_BY_TYPE[contentType] || (fromName && /^[a-z0-9]+$/.test(fromName) ? fromName : 'jpg')
  return { bytes, contentType, ext }
}

/**
 * Fold upload results back into the payload the RPC will persist.
 *
 * Success → `photos` becomes the canonical URL array, so every existing reader
 * (LeadSummary, the owner email, JobPhotos) finds it without knowing this door
 * exists. Failure → the ORIGINAL base64 is preserved under `photos_unprocessed`
 * and counted in `photos_failed`, so a network blip can never be mistaken for
 * "the customer attached nothing": the bytes are still recoverable and both the
 * owner email and the CRM say so out loud.
 */
export function applyPhotoResults(
  payload: Record<string, unknown>,
  r: { urls: string[]; failed: InlinePhoto[]; rejected: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload }
  const lost = r.failed.length + r.rejected
  if (!Array.isArray(payload.photos)) return out   // nothing to rewrite
  out.photos = r.urls
  if (lost > 0) {
    out.photos_failed = lost
    if (r.failed.length > 0) out.photos_unprocessed = r.failed
  } else {
    delete out.photos_failed
    delete out.photos_unprocessed
  }
  return out
}

// Flatten a Formspree submission. Formspree posts the form fields as top-level
// JSON; some setups nest them under `data`/`fields`. Field-name aliases
// (firstName/first_name, address/serviceAddress, …) are resolved INSIDE the RPC,
// so we only need to surface the right object here.
export function normalizeFormspree(body: Record<string, unknown>): Record<string, unknown> {
  const nested = (body.data && typeof body.data === 'object')
    ? body.data
    : (body.fields && typeof body.fields === 'object') ? body.fields : null
  const out: Record<string, unknown> = nested ? { ...(nested as Record<string, unknown>) } : { ...body }
  delete out.token; delete out._token; delete out.source
  // Formspree metadata we never want to persist as lead fields.
  delete out._gotcha; delete out._subject; delete out._replyto
  return out
}

// Submit a normalized lead through the shared pipeline. `source` becomes the
// customer's acquisition_source (e.g. 'Website', 'Formspree', 'Website Booking').
export async function submitLead(opts: {
  token: string
  source?: string
  payload: Record<string, unknown>
}): Promise<IntakeResult> {
  const token = (opts.token || '').trim()
  if (!token) return { ok: false, status: 400, body: { error: 'missing token' } }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return { ok: false, status: 500, body: { error: 'intake not configured' } }

  const anon = createClient(url, key)

  // Materialize inline photos into the canonical URL contract BEFORE the RPC runs —
  // the RPC is the only writer of website_leads.raw_submission (anon cannot UPDATE
  // it afterwards), so this is the one point where the payload can still be fixed.
  // Uploads use the SAME anon client and the SAME public `booking-uploads` bucket as
  // the booking door, whose INSERT policy already covers {anon, authenticated}.
  const { inline, alreadyUrls, rejected } = extractInlinePhotos(opts.payload)
  let payload = opts.payload
  let photoReport: { received: number; stored: number; failed: number } | null = null
  if (inline.length > 0 || alreadyUrls.length > 0 || rejected > 0) {
    const up = inline.length > 0 ? await uploadLeadPhotos(anon, token, inline) : { urls: [], failed: [] }
    payload = applyPhotoResults(opts.payload, {
      urls: [...alreadyUrls, ...up.urls], failed: up.failed, rejected,
    })
    photoReport = {
      received: inline.length + alreadyUrls.length + rejected,
      stored: alreadyUrls.length + up.urls.length,
      failed: up.failed.length + rejected,
    }
    if (photoReport.failed > 0) {
      console.error(`[intake] ${photoReport.failed} of ${photoReport.received} lead photo(s) could not be stored; originals preserved in raw_submission.photos_unprocessed`)
    }
  }

  // ── Automatic acquisition evidence, in strength order ──────────────────────
  // Mirrors the booking door's rule (hear_about → utm_source → door label), so
  // the two public doors cannot disagree about what counts as evidence:
  //   1. The customer's own words — a hear_about answer on the form.
  //   2. utm_source off the link that brought them (a form arriving via a
  //      Facebook ad should not report as generic "Website").
  //   3. The door label ('Website' / 'Formspree' / caller-supplied) — the floor,
  //      so a lead-door customer is never source-less.
  // No new storage: the full payload (raw utm and all) is already persisted
  // verbatim in website_leads.raw_submission. As of 2026-08-11 the live marketing
  // site sends NO attribution keys (0 of 18 leads ever) — this is the door being
  // ready for them, and /api/intake callers can pass them today.
  const saidSource = sanitizeSourceInput(leadField(payload, ['hear_about', 'hearAbout', 'how_did_you_hear', 'howDidYouHear']))
  const utmSource = sanitizeSourceInput(leadField(payload, ['utm_source', 'utmSource']))

  const { data, error } = await anon.rpc('submit_website_lead', {
    p_token: token,
    p_payload: payload,
    // `source` becomes customers.acquisition_source, and /api/intake is CORS-open
    // and unauthenticated with `source` read straight from the request body — so
    // this is an untrusted-input boundary, not a formatting nicety. THE bound lives
    // in lib/attribution and is mirrored by sanitize_source_input in SQL, which is
    // the copy that actually holds: this RPC is granted to `anon` and can be called
    // without going through any route here.
    p_source: saidSource || utmSource || sanitizeSourceInput(opts.source) || 'Website',
  })

  if (error) {
    console.error('[intake] rpc error:', error.message)
    return { ok: false, status: 502, body: { error: 'Could not submit your request. Please try again.' } }
  }
  if (!data) return { ok: false, status: 404, body: { error: 'This form is not currently accepting submissions.' } }

  const result = data as { error?: string; lead_id?: string; customer_id?: string; source?: string }
  if (result.error === 'rate_limited') {
    return { ok: false, status: 429, body: { error: 'Too many requests — please try again shortly.' } }
  }

  // Best-effort owner alert email — the lead is already saved + threaded into
  // Messages, so a failed (or unconfigured) email never loses the lead. The
  // requested SERVICE leads the subject and the field list, so the owner knows
  // what the customer wants before they even open the app. Note it gets the
  // REWRITTEN payload, so its photo links are the canonical stored URLs.
  try { await emailOwnerAboutLead(anon, token, opts.source || 'Website', payload) } catch { /* never block intake */ }

  // The lead is saved either way — never fail a real submission over a photo. But
  // the response states the photo outcome explicitly, so the caller can tell the
  // customer the truth instead of a blanket success. Callers that ignore it are no
  // worse off than before; the owner still learns of any loss via the email + CRM.
  const photos = photoReport
    ? { photos: photoReport, ...(photoReport.failed > 0 ? { warning: `${photoReport.failed} photo(s) could not be stored` } : {}) }
    : {}
  return { ok: true, status: 200, body: { ok: true, ...result, ...photos } }
}

// Upload decoded photos to the booking-uploads bucket, mirroring the booking door's
// path convention (`<token>/<uuid>-<safe-name>`). Per-photo try/catch: one bad file
// can never abort the batch or throw out of intake — it is reported as failed so the
// caller preserves its bytes and says so.
async function uploadLeadPhotos(
  anon: SupabaseClient, token: string, photos: InlinePhoto[],
): Promise<{ urls: string[]; failed: InlinePhoto[] }> {
  const urls: string[] = []
  const failed: InlinePhoto[] = []
  for (const p of photos) {
    try {
      const decoded = decodeInlinePhoto(p)
      if (!decoded) { failed.push(p); continue }
      const safe = p.filename.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-60) || 'photo'
      const base = safe.replace(/\.[a-z0-9]{2,5}$/i, '')
      const path = `${token}/${crypto.randomUUID()}-${base}.${decoded.ext}`
      const { error } = await anon.storage.from('booking-uploads')
        .upload(path, decoded.bytes, { contentType: decoded.contentType, upsert: false })
      if (error) { failed.push(p); continue }
      urls.push(anon.storage.from('booking-uploads').getPublicUrl(path).data.publicUrl)
    } catch { failed.push(p) }
  }
  return { urls, failed }
}

// Resolve a lead field across the same aliases the RPC accepts. Exported so
// verify-lead-intake can pin the alias set — the snake_case/camelCase compatibility
// with the live marketing site is a real contract, not an incidental detail.
export function leadField(p: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

// HTML-escape lead-supplied text before it lands in the owner-alert email. This is an
// injection boundary: a lead's name/notes come from a PUBLIC form, so a `<script>` or
// `"><img onerror=…>` in that data must not render live in the owner's inbox. Exported
// so verify-lead-intake can pin it — a weakened escaper is a wrong VALUE tsc can't see.
export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c))

/**
 * Build the owner-alert email from a lead payload. Pure + exported so
 * verify-lead-intake can pin it — including that a lead's PHOTOS reach the owner,
 * which they never did before: the email listed eight text fields and no photos at
 * all, so a customer who attached four pictures of the job produced an email that
 * looked identical to one who attached none.
 *
 * Photos are rendered as the canonical public URLs (the same links the CRM gallery
 * opens) — an owner reading mail on a phone taps straight through to the picture.
 */
export function buildLeadEmail(source: string, p: Record<string, unknown>): { subject: string; html: string; text: string } {
  const service = leadField(p, ['requestedServices', 'services', 'service', 'serviceType', 'service_type'])
  const name = leadField(p, ['fullName', 'name']) || [leadField(p, ['firstName', 'first_name']), leadField(p, ['lastName', 'last_name'])].filter(Boolean).join(' ')
  const rows: [string, string][] = [
    ['Service', service || 'Not specified'],
    ['Name', name || '—'],
    ['Phone', leadField(p, ['phone', 'tel', 'telephone', 'mobile'])],
    ['Email', leadField(p, ['email'])],
    ['Address', leadField(p, ['address', 'serviceAddress', 'service_address'])],
    ['Budget', leadField(p, ['budget', 'budgetRange'])],
    ['Preferred schedule', leadField(p, ['preferredSchedule', 'preferred_schedule', 'schedule', 'timeline'])],
    ['Notes', leadField(p, ['notes', 'details', 'message', 'comments'])],
  ]
  const shown = rows.filter(([, v]) => v)

  // The canonical contract — the same `photos: string[]` of URLs the CRM reads.
  const photoUrls = Array.isArray(p.photos)
    ? p.photos.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u.trim())).map(u => u.trim())
    : []
  const failed = Number(p.photos_failed) || 0

  const photoHtml = photoUrls.length > 0
    ? `<p><b>📷 ${photoUrls.length} photo${photoUrls.length !== 1 ? 's' : ''} attached</b><br/>${
        photoUrls.map((u, i) => `<a href="${esc(u)}">Photo ${i + 1}</a>`).join(' · ')
      }</p>`
    : ''
  // Say it plainly when photos were lost: silence here is exactly how the customer's
  // pictures disappeared without anyone noticing.
  const failedHtml = failed > 0
    ? `<p style="color:#b45309"><b>⚠️ ${failed} photo${failed !== 1 ? 's' : ''} could not be stored.</b> The customer believes they sent ${failed === 1 ? 'it' : 'them'} — ask them to resend, or recover from the lead's raw submission.</p>`
    : ''

  const html = `<p>🌱 You have a new ${esc(source)} lead${service ? ` — <b>${esc(service)}</b>` : ''}.</p><ul>${
    shown.map(([k, v]) => `<li><b>${k}:</b> ${esc(v)}</li>`).join('')
  }</ul>${photoHtml}${failedHtml}<p>It's in your Messages inbox — reply or build a quote from the lead card.</p>`

  const photoText = photoUrls.length > 0 ? `\n${photoUrls.length} photo(s) attached:\n${photoUrls.join('\n')}` : ''
  const failedText = failed > 0 ? `\n⚠️ ${failed} photo(s) could not be stored — ask the customer to resend.` : ''
  const text = `New ${source} lead${service ? ` — ${service}` : ''}\n${shown.map(([k, v]) => `${k}: ${v}`).join('\n')}${photoText}${failedText}\nIt's in your Messages inbox.`

  return {
    subject: `🌱 New ${source} lead${service ? ` — ${service}` : ''}${name ? ` from ${name}` : ''}`,
    html,
    text,
  }
}

async function emailOwnerAboutLead(anon: SupabaseClient, token: string, source: string, p: Record<string, unknown>): Promise<void> {
  if (!commsEnabled().email) return
  const { data } = await anon.rpc('get_booking_business', { p_token: token })
  const biz = data as { email_primary?: string | null; company_name?: string | null } | null
  if (!biz?.email_primary) return
  const { subject, html, text } = buildLeadEmail(source, p)
  await sendEmail(biz.email_primary, subject, html, text)
}
