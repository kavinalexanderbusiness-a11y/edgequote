import type { SupabaseClient } from '@supabase/supabase-js'

// ── Setup health — is this business fully set up? ────────────────────────────
// Purely DERIVED from data that already exists; there is no checklist table, no
// acknowledgment flags, nothing to keep in sync. Each item mirrors the exact
// gate some real consumer already applies — the item is "incomplete" precisely
// when that consumer is silently degrading, and the annotation on each check
// names the consumer. That's the discipline that keeps this from becoming a
// second copy of configuration logic: WE don't define "configured", the
// consuming feature does; this file just makes its silence visible.
//
// Deliberately NOT items, and why (each was considered):
//   Taxes/GST      gst_percent 0 is a legitimate deliberate choice (small-
//                  supplier rule in Canada) — indistinguishable from "never
//                  looked" without an acknowledgment flag, which would need new
//                  storage. Nagging the founding business about its correct 0%
//                  forever is worse than the item.
//   Modules        enabled_modules NULL means "all modules" and the module
//                  manager deliberately stores NULL for all-on — non-NULL is
//                  composition, not review. Same acknowledgment problem.
//   AI             configured by server env (API keys), not per-business data;
//                  a client checklist cannot see it and shouldn't guess.
//   Quote template a quote's services COME from service_templates — the
//                  catalogue items already cover it; a separate entity doesn't exist.
//   Automations    a null automations jsonb means "never saved" — but an owner who
//                  reviews the toggles and ACCEPTS the defaults writes nothing, so
//                  the item could never complete for them (it measures "modified",
//                  not "reviewed" — found in review). Same acknowledgment problem
//                  as taxes/modules; only real storage could fix it honestly.

export interface SetupSnapshot {
  companyName: string
  phone: string | null
  emailPrimary: string | null
  baseAddress: string | null
  baseLat: number | null
  baseLng: number | null
  logoUrl: string | null
  termsText: string | null
  etransferEmail: string | null
  bookingEnabled: boolean
  reviewUrl: string | null
  activeTemplateCount: number
  unpricedActiveTemplateCount: number
  /** A read failed; completion is unknowable. The card renders nothing. */
  readError?: string
}

export interface SetupItem {
  key: string
  label: string
  /** What silently degrades while this is incomplete — the consumer's behaviour,
   *  in the owner's words. Shown under the label. */
  why: string
  href: string
  done: boolean
}

export interface SetupHealth {
  items: SetupItem[]
  done: number
  total: number
  complete: boolean
}

const set = (v: string | null | undefined) => (v || '').trim() !== ''

/** PURE. Derive the checklist from a snapshot. */
export function deriveSetupHealth(s: SetupSnapshot): SetupHealth {
  const items: SetupItem[] = [
    {
      key: 'business_info',
      label: 'Business contact details',
      // Mirrors the identity every send path + PDF renders (lib/portalPdf,
      // lib/comms/templates): name, phone and reply email.
      why: 'Your name, phone and email appear on every message, quote and invoice.',
      href: '/dashboard/settings#business',
      done: set(s.companyName) && set(s.phone) && set(s.emailPrimary),
    },
    {
      key: 'home_base',
      label: 'Home base address',
      // The consumers (businessIntelligence / weatherImpact / routing / travel
      // fees) read base_lat/lng — but lat/lng are deliberately NOT part of this
      // predicate: the settings form nulls them on every save and pages
      // re-geocode lazily, so requiring them turns a self-healing transient into
      // a recurring nag that keeps resurrecting a dismissed card (found in
      // review). The owner-actionable fact is the ADDRESS; geocoding follows on
      // its own.
      why: 'Travel fees, routing and weather all measure from your home base.',
      href: '/dashboard/settings#business',
      done: set(s.baseAddress),
    },
    {
      key: 'logo',
      label: 'Company logo',
      // Mirrors portalPdf + the email renderer: absent logo = text-only branding.
      why: 'Shown on your quotes, invoices, emails and the customer portal.',
      href: '/dashboard/settings#business',
      done: set(s.logoUrl),
    },
    {
      key: 'services',
      label: 'Service catalogue',
      // Mirrors QuoteBuilder/JobForm/booking: with zero active templates there is
      // nothing to quote or book.
      why: 'Quotes, jobs and online booking all pick from your services.',
      href: '/dashboard/settings/templates',
      done: s.activeTemplateCount > 0,
    },
    {
      key: 'service_prices',
      label: 'Service prices',
      // Mirrors formatServicePrice: a 0-rate active template renders
      // "Starting from $0" wherever prices show.
      why: 'A service without a price shows customers “from $0”.',
      href: '/dashboard/settings/templates',
      done: s.activeTemplateCount > 0 && s.unpricedActiveTemplateCount === 0,
    },
    {
      key: 'terms',
      label: 'Quote & invoice terms',
      // Mirrors portalPdf: terms_text prints on documents; empty = none.
      why: 'Printed on every quote and invoice PDF.',
      href: '/dashboard/settings#business',
      done: set(s.termsText),
    },
    {
      key: 'etransfer',
      label: 'E-transfer details',
      // Mirrors PortalClient's exact gate ((etransfer_email || '').trim()):
      // while empty, the portal's Ways-to-Pay hides the e-transfer option.
      why: 'Until this is set, your customer portal doesn’t offer e-transfer.',
      href: '/dashboard/settings#pricing',
      done: set(s.etransferEmail),
    },
    {
      key: 'booking',
      label: 'Online booking',
      // Mirrors WebsiteIntegration/booking routes: the public funnel is off
      // until booking_enabled.
      why: 'Lets customers request work from your website, day or night.',
      href: '/dashboard/settings#booking',
      done: s.bookingEnabled,
    },
    {
      key: 'review_link',
      label: 'Review link',
      // Mirrors cron/notifications' gate (!(reviewUrl || '').trim() → skip):
      // review asks silently skip while unset.
      why: 'Review requests are silently skipped until customers have somewhere to go.',
      href: '/dashboard/settings#messaging',
      done: set(s.reviewUrl),
    },
  ]
  const done = items.filter(i => i.done).length
  return { items, done, total: items.length, complete: done === items.length }
}

/** Read the snapshot. On ANY read failure returns readError — the card renders
 *  nothing rather than a checklist of guesses (the seeding lesson: an uncertain
 *  read must never present as fact). */
export async function loadSetupSnapshot(supabase: SupabaseClient, userId: string): Promise<SetupSnapshot> {
  const [bizRes, tplRes, unpricedRes] = await Promise.all([
    supabase.from('business_settings')
      .select('company_name, phone, email_primary, base_address, base_lat, base_lng, logo_url, terms_text, etransfer_email, booking_enabled, review_url')
      .eq('user_id', userId).maybeSingle(),
    supabase.from('service_templates').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_active', true),
    supabase.from('service_templates').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_active', true).lte('default_rate', 0),
  ])
  const empty: SetupSnapshot = {
    companyName: '', phone: null, emailPrimary: null, baseAddress: null, baseLat: null, baseLng: null,
    logoUrl: null, termsText: null, etransferEmail: null, bookingEnabled: false, reviewUrl: null,
    activeTemplateCount: 0, unpricedActiveTemplateCount: 0,
  }
  // Gate on the ERROR OBJECT, not its message — an empty-string message must
  // still fail closed ("ANY read failure" means any).
  const readError = bizRes.error ? (bizRes.error.message || 'settings read failed')
    : tplRes.error ? (tplRes.error.message || 'template read failed')
    : unpricedRes.error ? (unpricedRes.error.message || 'template read failed')
    : (tplRes.count == null || unpricedRes.count == null ? 'template counts unavailable' : undefined)
  if (readError) return { ...empty, readError }
  const b = bizRes.data as {
    company_name: string; phone: string | null; email_primary: string | null; base_address: string | null
    base_lat: number | null; base_lng: number | null; logo_url: string | null; terms_text: string | null
    etransfer_email: string | null; booking_enabled: boolean | null; review_url: string | null
  } | null
  if (!b) return empty // no row yet — genuinely everything to do
  return {
    companyName: b.company_name || '',
    phone: b.phone, emailPrimary: b.email_primary,
    baseAddress: b.base_address, baseLat: b.base_lat, baseLng: b.base_lng,
    logoUrl: b.logo_url, termsText: b.terms_text,
    etransferEmail: b.etransfer_email,
    bookingEnabled: !!b.booking_enabled,
    reviewUrl: b.review_url,
    activeTemplateCount: tplRes.count ?? 0,
    unpricedActiveTemplateCount: unpricedRes.count ?? 0,
  }
}
