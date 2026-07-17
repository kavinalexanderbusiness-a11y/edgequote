'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode, type ChangeEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import { pricingConfigFromSettings, pricingPackage } from '@/lib/pricing'
import { applyFeeRecovery } from '@/lib/invoiceTotals'
import { autoMeasureLawn, AutoMeasureResult, neighborhoodOf } from '@/lib/autoMeasure'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { AddressAutocomplete, ParsedAddress } from '@/components/ui/AddressAutocomplete'
import { Button } from '@/components/ui/Button'
import { formatCurrency, cn } from '@/lib/utils'
import { Leaf, Loader2, Undo2, Trash2, Check, ArrowRight, ArrowLeft, Ruler, CheckCircle2, Phone, Mail, Camera, MapPin, X } from 'lucide-react'

const STEP_LABELS: Record<string, string> = { address: 'Your address', measure: 'Confirm lawn size', plan: 'Choose a plan', contact: 'Your details' }

// ── Public instant-quote + booking funnel ───────────────────────────────────
// No login. A prospect enters their address, traces their lawn on satellite for
// an instant price from the owner's real pricing engine, picks a plan, and books
// — creating a customer + property + quote for the owner. Token-scoped RPCs.

export interface Biz {
  company_name: string | null; owner_name: string | null; logo_url: string | null
  phone: string | null; email_primary: string | null; website: string | null
  pricing_base_charge: number | null; pricing_mow_rate: number | null
  pricing_recommended_mult: number | null; pricing_premium_mult: number | null; pricing_travel_rate: number | null
  payment_fee_strategy: string | null; fee_recovery_percent: number | null; gst_percent: number | null
}

type Step = 'address' | 'measure' | 'plan' | 'contact' | 'done'
interface Plan { key: 'one_time' | 'weekly' | 'biweekly' | 'monthly'; label: string; price: number; annual?: number; recommended?: boolean }
// One row of the owner's catalog, as public_services returns it. Only the name is used here.
interface Svc { id: string; name: string }

const M2_TO_SQFT = 10.7639
const HEAR_OPTIONS = ['Website', 'Google Business Profile', 'QR code', 'Facebook', 'Nextdoor', 'Referral from a friend', 'Drove by / yard sign', 'Other']

export function BookingClient({ token, initialBiz }: { token: string; initialBiz: Biz | null }) {
  const supabase = useMemo(() => createClient(), [])

  // Seeded from the server fetch → the funnel's first step renders instantly (no spinner).
  const [biz, setBiz] = useState<Biz | null>(initialBiz)
  const [loading, setLoading] = useState(initialBiz == null)
  const [step, setStep] = useState<Step>('address')
  // The owner's catalog — active service templates in the order they arranged them.
  // Names the service this booking creates (see bookedService). Never gates rendering.
  const [services, setServices] = useState<Svc[]>([])

  const [addressText, setAddressText] = useState('')
  const [parsed, setParsed] = useState<ParsedAddress | null>(null)
  const [sqft, setSqft] = useState(0)
  const [manualSqft, setManualSqft] = useState('')
  const [autoResult, setAutoResult] = useState<AutoMeasureResult | null | undefined>(undefined)
  const [measuring, setMeasuring] = useState(false)
  const [showTracer, setShowTracer] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [hearAbout, setHearAbout] = useState('')
  const [referralCode, setReferralCode] = useState('')
  const [photoUrls, setPhotoUrls] = useState<string[]>([])
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [utm, setUtm] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quoteNumber, setQuoteNumber] = useState<string | null>(null)
  // Messaging consent — service categories default ON (they asked us to come),
  // marketing defaults OFF (must be an explicit yes). Synced via booking_set_consent.
  const [consentPrefs, setConsentPrefs] = useState({ reminders: true, invoices: true, estimates: true, seasonal: true, marketing: false })

  // Server already provided initialBiz → no client fetch on first paint. Only fetch here
  // as a fallback (e.g. a direct client navigation where the server skipped it).
  useEffect(() => {
    if (initialBiz != null) return
    const run = async () => {
      const { data } = await supabase.rpc('get_booking_business', { p_token: token })
      setBiz((data as Biz | null) ?? null)
      setLoading(false)
    }
    run()
  }, [token, supabase, initialBiz])

  // The owner's service catalog, keyed on the SAME booking token. Its own fetch on
  // purpose — get_booking_business returns a flat business object this file destructures,
  // so the services can't ride along with it. This effect is NOT gated on initialBiz: the
  // server seeds the business, never the catalog. Strictly best-effort — an error, a bad
  // token or an empty catalog just leaves `services` empty, and nothing here touches
  // `loading`, so the funnel can never be blocked or delayed by it.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase.rpc('public_services', { p_token: token })
        if (cancelled) return
        const list = (data as { services?: Svc[] } | null)?.services
        setServices(Array.isArray(list) ? list : [])
      } catch { /* catalog is best-effort — the booking still goes through */ }
    })()
    return () => { cancelled = true }
  }, [token, supabase])

  // Capture attribution from the link: ?ref=CODE and ?utm_source/medium/campaign/term/content.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sp = new URLSearchParams(window.location.search)
    const u: Record<string, string> = {}
    for (const k of ['source', 'medium', 'campaign', 'term', 'content']) { const v = sp.get('utm_' + k); if (v) u[k] = v }
    setUtm(u)
    const ref = sp.get('ref'); if (ref) setReferralCode(ref)
  }, [])

  // Best-effort photo upload — a failed upload (e.g. bucket not yet created) never blocks the booking.
  async function addPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-picking the same file after a remove
    if (!files.length) return
    setUploadingPhotos(true); setPhotoError(null)
    const room = Math.max(0, 6 - photoUrls.length)
    const added: string[] = []
    let failed = 0
    for (const f of files.slice(0, room)) {
      const safe = f.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')
      const path = `${token}/${crypto.randomUUID()}-${safe}`
      const { error: upErr } = await supabase.storage.from('booking-uploads').upload(path, f, { upsert: false })
      if (!upErr) added.push(supabase.storage.from('booking-uploads').getPublicUrl(path).data.publicUrl)
      else failed++
    }
    setPhotoUrls(prev => [...prev, ...added])
    if (failed > 0) setPhotoError(`Couldn't upload ${failed} photo${failed !== 1 ? 's' : ''} — you can try again, or just skip it.`)
    else if (files.length > room) setPhotoError('You can attach up to 6 photos.')
    setUploadingPhotos(false)
  }
  function removePhoto(url: string) { setPhotoUrls(prev => prev.filter(u => u !== url)); setPhotoError(null) }

  // ── Pricing (owner's real engine, with fee recovery baked in for display) ──
  const plans: Plan[] = useMemo(() => {
    if (!biz || sqft <= 0) return []
    const cfg = pricingConfigFromSettings(biz)
    const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: 0 })
    const fee = { payment_fee_strategy: biz.payment_fee_strategy as never, fee_recovery_percent: biz.fee_recovery_percent }
    const out: Plan[] = [{ key: 'one_time', label: 'One-time visit', price: applyFeeRecovery(pkg.oneTime, fee) ?? pkg.oneTime }]
    for (const o of pkg.options) {
      out.push({
        key: o.cadence, label: o.cadence === 'weekly' ? 'Weekly' : o.cadence === 'biweekly' ? 'Bi-weekly' : 'Monthly',
        price: applyFeeRecovery(o.price, fee) ?? o.price, annual: o.annual, recommended: pkg.recommended.cadence === o.cadence,
      })
    }
    return out
  }, [biz, sqft])

  // ── Satellite lawn tracer ──
  const mapEl = useRef<HTMLDivElement>(null)
  const gmap = useRef<unknown>(null)
  const poly = useRef<unknown>(null)
  const pts = useRef<unknown[]>([])
  const [mapErr, setMapErr] = useState<string | null>(null)

  function recompute() {
    const g = (window as { google?: { maps: { geometry: { spherical: { computeArea: (p: unknown[]) => number } } } } }).google
    if (g && pts.current.length >= 3) setSqft(Math.round(g.maps.geometry.spherical.computeArea(pts.current) * M2_TO_SQFT))
    else setSqft(0)
  }
  function redraw() {
    const g = (window as { google?: { maps: { Polygon: new (o: unknown) => { setMap: (m: unknown) => void } } } }).google
    if (!g) return
    if (poly.current) (poly.current as { setMap: (m: unknown) => void }).setMap(null)
    poly.current = new g.maps.Polygon({ paths: pts.current, strokeColor: '#00C896', strokeWeight: 2, fillColor: '#00C896', fillOpacity: 0.3, map: gmap.current, clickable: false })
  }
  // Auto-measure: estimate the lawn the moment we have the address (default flow).
  useEffect(() => {
    if (step !== 'measure' || !parsed?.lat || !parsed?.lng || autoResult !== undefined) return
    setMeasuring(true)
    autoMeasureLawn(parsed.lat, parsed.lng)
      .then(r => { setAutoResult(r); if (r) { setSqft(r.sqft); setShowTracer(false) } else setShowTracer(true); setMeasuring(false) })
      .catch(() => { setAutoResult(null); setShowTracer(true); setMeasuring(false) })
  }, [step, parsed, autoResult])

  // Manual tracer — only mounts when redrawing (or when auto-measure found nothing).
  useEffect(() => {
    if (step !== 'measure' || !showTracer || !parsed?.lat || !parsed?.lng || !mapEl.current) return
    let cancelled = false
    ;(async () => {
      try {
        await loadGoogleMaps()
        if (cancelled) return
        const g = (window as { google: { maps: { Map: new (el: HTMLElement, o: unknown) => { addListener: (e: string, cb: (ev: { latLng: unknown }) => void) => void } } } }).google
        pts.current = []
        gmap.current = new g.maps.Map(mapEl.current as HTMLElement, {
          center: { lat: parsed.lat, lng: parsed.lng }, zoom: 20, mapTypeId: 'satellite', tilt: 0,
          disableDefaultUI: true, zoomControl: true, clickableIcons: false, disableDoubleClickZoom: true, gestureHandling: 'greedy',
        })
        ;(gmap.current as { addListener: (e: string, cb: (ev: { latLng: unknown }) => void) => void }).addListener('click', (ev: { latLng: unknown }) => {
          pts.current.push(ev.latLng); redraw(); recompute()
        })
      } catch { if (!cancelled) setMapErr('Map could not load — enter your approximate lawn size instead.') }
    })()
    return () => { cancelled = true }
  }, [step, parsed, showTracer])

  function undo() { pts.current.pop(); redraw(); recompute() }
  function clearTrace() { pts.current = []; redraw(); recompute() }

  // Read-only satellite preview for the property-confirmation card (the Weed-Man
  // moment: "this is your home"). Same Maps loader as the tracer — no second
  // imagery system — just non-interactive, marker on the rooftop.
  const previewEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (step !== 'measure' || showTracer || measuring || !parsed?.lat || !parsed?.lng || !previewEl.current) return
    let cancelled = false
    ;(async () => {
      try {
        await loadGoogleMaps()
        if (cancelled || !previewEl.current) return
        const g = (window as unknown as { google: { maps: { Map: new (el: HTMLElement, o: unknown) => unknown; Marker: new (o: unknown) => unknown } } }).google
        const m = new g.maps.Map(previewEl.current, {
          center: { lat: parsed.lat, lng: parsed.lng }, zoom: 19, mapTypeId: 'satellite', tilt: 0,
          disableDefaultUI: true, draggable: false, clickableIcons: false, keyboardShortcuts: false, gestureHandling: 'none',
        })
        new g.maps.Marker({ position: { lat: parsed.lat, lng: parsed.lng }, map: m })
      } catch { /* preview is decorative — the estimate card still works without it */ }
    })()
    return () => { cancelled = true }
  }, [step, parsed, showTracer, measuring])

  // The funnel measures an area and sells cadence plans; the SERVICE it books is
  // the owner's primary offering — their first active service template, in the
  // order they arranged. For this business that is "Lawn Mowing", so behaviour is
  // unchanged; a different trade now books THEIR service instead of ours.
  const bookedService = services[0]?.name ?? null

  async function submit() {
    if (!parsed || !plan || !name.trim() || !(email.trim() || phone.trim())) return
    setSubmitting(true); setError(null)
    const fee = { payment_fee_strategy: biz?.payment_fee_strategy as never, fee_recovery_percent: biz?.fee_recovery_percent }
    const cfg = pricingConfigFromSettings(biz)
    const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: 0 })
    const opt = (c: string) => pkg.options.find(o => o.cadence === c)?.price ?? 0
    const { data, error: rpcErr } = await supabase.rpc('submit_booking', {
      p_token: token, p_name: name.trim(), p_email: email.trim(), p_phone: phone.trim(),
      p_address: parsed.address || parsed.formatted, p_city: parsed.city, p_province: parsed.province, p_postal: parsed.postal,
      // Neutral literal, NOT null, when the catalog is empty: submit_booking itself does
      // coalesce(nullif(p_service_type, ''), 'Lawn Mowing'), so passing null or '' would let
      // the database re-impose the very default we're removing. Without changing the RPC,
      // an explicit label is the only way to say "they sell something, we don't know what".
      p_lat: parsed.lat, p_lng: parsed.lng, p_sqft: sqft, p_service_type: bookedService ?? 'Service',
      p_initial: applyFeeRecovery(pkg.oneTime, fee) ?? 0,
      p_weekly: applyFeeRecovery(opt('weekly'), fee) ?? 0,
      p_biweekly: applyFeeRecovery(opt('biweekly'), fee) ?? 0,
      p_monthly: applyFeeRecovery(opt('monthly'), fee) ?? 0,
      p_cadence: plan.label,
      p_notes: notes.trim() || null,
      p_hear_about: hearAbout || null,
      p_referral_code: referralCode.trim() || null,
      p_utm: Object.keys(utm).length ? utm : null,
      p_photos: photoUrls.length ? photoUrls : null,
    })
    setSubmitting(false)
    const res = data as { quote_number?: string; quote_id?: string } | null
    // "Something went wrong" at this exact moment reads as "did it save? will I be
    // double-booked if I retry?" — this returns before setStep('done'), so nothing was
    // submitted, and saying so is what makes retrying feel safe.
    if (rpcErr || !res?.quote_number) { setError(`That didn’t go through — nothing was submitted, so you won’t be double-booked. Please try once more${biz?.phone ? `, or call us at ${biz.phone} and we’ll take your details over the phone` : ''}.`); return }
    setQuoteNumber(res.quote_number)
    // Sync messaging consent into the customer record (best-effort). Channel
    // opt-in = they gave us that contact method + at least one category on.
    const anyOn = Object.values(consentPrefs).some(Boolean)
    supabase.rpc('booking_set_consent', {
      p_token: token, p_quote_id: res.quote_id ?? null,
      p_sms_opt_in: anyOn && !!phone.trim(), p_email_opt_in: anyOn && !!email.trim(),
      p_prefs: consentPrefs,
    }).then(() => {}, () => {})
    // Record auto vs accepted area so the estimate self-calibrates (best-effort).
    supabase.rpc('record_booking_measurement', {
      p_token: token, p_quote_id: res.quote_id ?? null, p_lat: parsed.lat, p_lng: parsed.lng,
      p_neighborhood: neighborhoodOf(parsed.postal, parsed.city, null),
      p_auto: autoResult?.sqft ?? null, p_accepted: sqft, p_building: autoResult?.buildingSqft ?? null, p_confidence: autoResult?.confidence ?? null,
    }).then(() => {}, () => {})
    // Best-effort owner alert AND the customer's confirmation (no-op if comms aren't
    // configured). The customer's contact details go with it so they get something in
    // writing — closing the tab must not leave them with nothing to prove they booked.
    fetch('/api/booking/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, name: name.trim(), address: parsed.formatted, service: bookedService ?? 'Service',
        cadence: plan.label, quoteNumber: res.quote_number,
        // The confirmation is sent to the customer submit_booking just created,
        // resolved server-side from this quote. Contact details and a consent
        // flag are deliberately NOT sent — the server must never take either
        // from the request body (this endpoint is public). See the route.
        quoteId: res.quote_id,
      }),
    }).catch(() => {})
    setStep('done')
  }

  if (loading) return (
    <Center>
      <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center mb-3"><Leaf className="w-5 h-5 text-accent-text" /></div>
      <p className="text-sm text-ink-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading your instant quote…</p>
    </Center>
  )
  if (!biz) return (
    <Center>
      <Leaf className="w-10 h-10 text-ink-faint mb-3" />
      <p className="text-lg font-semibold text-ink">This booking link isn’t active</p>
      <p className="text-sm text-ink-muted mt-1 max-w-xs">The link may be incorrect or no longer active. Please double-check it, or reach out to the company that sent it to you for a fresh one.</p>
    </Center>
  )

  const gst = Number(biz.gst_percent) || 0

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-6 pb-24">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {biz.logo_url ? <img src={biz.logo_url} alt="" className="h-10 w-auto object-contain" /> : <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent-text" /></div>}
          <div className="min-w-0">
            <p className="text-base font-bold text-ink truncate tracking-tight">{biz.company_name || 'Get an instant quote'}</p>
            <p className="text-xs text-ink-muted">Instant lawn-care quote · book in minutes</p>
          </div>
        </div>

        {/* Progress */}
        {step !== 'done' && (
          <div className="mb-4">
            <p className="text-[11px] font-medium text-ink-faint mb-1.5">Step {['address', 'measure', 'plan', 'contact'].indexOf(step) + 1} of 4 · {STEP_LABELS[step]}</p>
            <div className="flex items-center gap-1.5">
              {(['address', 'measure', 'plan', 'contact'] as Step[]).map((s, i) => (
                <div key={s} className={cn('h-1.5 flex-1 rounded-full transition-colors', ['address', 'measure', 'plan', 'contact'].indexOf(step) >= i ? 'bg-accent' : 'bg-border')} />
              ))}
            </div>
          </div>
        )}

        {/* STEP: address */}
        {step === 'address' && (
          <Section title="Where's your lawn?" sub="Enter your address to get an instant price.">
            <AddressAutocomplete label="Property address" value={addressText} onChange={setAddressText}
              onSelect={p => { setParsed(p); setAddressText(p.formatted); setAutoResult(undefined); setShowTracer(false); setSqft(0) }} placeholder="Start typing your address…" />
            <Button size="lg" className="w-full mt-4" disabled={!parsed?.lat} onClick={() => setStep('measure')}>
              Continue <ArrowRight className="w-4 h-4" />
            </Button>
          </Section>
        )}

        {/* STEP: measure — auto by default, with adjust + redraw */}
        {step === 'measure' && (
          <Section title="Confirm your property" sub="Here's what we found — check the photo, confirm the size, and you're one tap from your price.">
            {measuring ? (
              <div className="py-12 text-center text-sm text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Measuring your lawn from satellite…</div>
            ) : !showTracer && autoResult ? (
              <div className="space-y-3">
                {/* The property, from above — confirmation that we're quoting the right home */}
                <div className="rounded-card overflow-hidden border border-border-strong">
                  <div ref={previewEl} className="w-full h-56 bg-bg-tertiary" />
                  <div className="px-4 py-2.5 bg-bg-secondary border-t border-border flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-accent-text shrink-0" />
                    <p className="text-xs text-ink truncate">{parsed?.formatted || parsed?.address}</p>
                  </div>
                </div>
                <div className="rounded-card border border-accent/30 bg-accent/5 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink-muted flex items-center gap-2"><Ruler className="w-4 h-4 text-accent-text" /> Estimated lawn size</span>
                    <ConfidenceBadge confidence={autoResult.confidence} />
                  </div>
                  <div className="flex items-end gap-2 mt-2">
                    <input type="number" inputMode="numeric" value={sqft || ''} onChange={e => setSqft(Number(e.target.value) || 0)} aria-label="Lawn size in square feet"
                      className="w-32 bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-xl font-bold text-ink tabular-nums outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                    <span className="text-sm text-ink-muted pb-2">sq ft</span>
                  </div>
                  <p className="text-[11px] text-ink-faint mt-1">Not quite right? Edit the number, or measure it exactly on the map.</p>
                </div>
                <Button variant="secondary" className="w-full" onClick={() => setShowTracer(true)}><Ruler className="w-4 h-4" /> Measure again on the map</Button>
              </div>
            ) : mapErr && mapErr !== 'manual' ? (
              <div className="space-y-3">
                <p className="text-sm text-amber-400">{mapErr}</p>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Approximate lawn size (sq ft)</span>
                  <input type="number" inputMode="numeric" autoFocus value={manualSqft} onChange={e => { setManualSqft(e.target.value); setSqft(Number(e.target.value) || 0) }}
                    placeholder="e.g. 3000" className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                </label>
                <p className="text-[11px] text-ink-faint">Rough is fine — we&rsquo;ll confirm on site.</p>
              </div>
            ) : mapErr === 'manual' ? (
              <div className="space-y-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Approximate lawn size (sq ft)</span>
                  <input type="number" inputMode="numeric" autoFocus value={manualSqft} onChange={e => { setManualSqft(e.target.value); setSqft(Number(e.target.value) || 0) }}
                    placeholder="e.g. 3000" className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                </label>
                <p className="text-[11px] text-ink-faint">Rough is fine — we&rsquo;ll confirm on site.</p>
              </div>
            ) : (
              <>
                <div ref={mapEl} className="w-full h-72 rounded-xl overflow-hidden border border-border-strong bg-bg-tertiary" />
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-2 text-sm text-ink tabular-nums">
                    <Ruler className="w-4 h-4 text-accent-text" /> {sqft > 0 ? `${sqft.toLocaleString()} sq ft` : 'Tap 3+ corners to start'}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={undo} title="Undo last point"><Undo2 className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={clearTrace} title="Clear"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <button onClick={() => setMapErr('manual')} className="text-xs text-ink-faint hover:text-ink mt-2 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Enter size manually instead</button>
              </>
            )}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" aria-label="Back" onClick={() => setStep('address')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button size="lg" className="flex-1" disabled={sqft <= 0} onClick={() => setStep('plan')}>See my price <ArrowRight className="w-4 h-4" /></Button>
            </div>
          </Section>
        )}

        {/* STEP: plan */}
        {step === 'plan' && (
          <Section title="Your instant quote" sub={`${sqft.toLocaleString()} sq ft lawn · choose how often you'd like service.`}>
            <div className="space-y-2">
              {plans.map(p => (
                <button key={p.key} onClick={() => setPlan(p)}
                  className={cn('w-full text-left rounded-card border px-4 py-3 transition-all flex items-center justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    plan?.key === p.key ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40')}>
                  <div>
                    <p className="text-sm font-semibold text-ink flex items-center gap-2">{p.label}{p.recommended && <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">Best value</span>}</p>
                    {p.annual ? <p className="text-xs text-ink-faint mt-0.5 tabular-nums">{formatCurrency(p.price)}/visit · ~{formatCurrency(p.annual)}/season</p> : <p className="text-xs text-ink-faint mt-0.5">single visit</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-ink tabular-nums">{formatCurrency(p.price)}</p>
                    <p className="text-[10px] text-ink-faint">{p.key === 'one_time' ? 'one-time' : 'per visit'}</p>
                  </div>
                </button>
              ))}
            </div>
            {gst > 0 && <p className="text-[11px] text-ink-faint mt-2">Prices shown before {gst}% GST.</p>}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" aria-label="Back" onClick={() => setStep('measure')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button size="lg" className="flex-1" disabled={!plan} onClick={() => setStep('contact')}>Continue <ArrowRight className="w-4 h-4" /></Button>
            </div>
          </Section>
        )}

        {/* STEP: contact */}
        {step === 'contact' && (
          <Section title="Almost done" sub={`Just your details, then ${biz.company_name || 'we'} will confirm your price and schedule your first visit.`}>
            <form onSubmit={e => { e.preventDefault(); if (name.trim() && (email.trim() || phone.trim()) && !submitting) submit() }}>
            <div className="space-y-4">
              <Field label="Your name *" value={name} onChange={setName} placeholder="Jane Doe" autoFocus autoComplete="name" />
              <Field label="Email" value={email} onChange={setEmail} placeholder="jane@example.com" type="email" autoComplete="email" inputMode="email" />
              <Field label="Phone" value={phone} onChange={setPhone} placeholder="(403) 555-0100" type="tel" autoComplete="tel" inputMode="tel" />
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">How did you hear about us? <span className="font-normal text-ink-faint normal-case">(optional)</span></label>
                <select value={hearAbout} onChange={e => setHearAbout(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20">
                  <option value="">Select…</option>
                  {HEAR_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <Field label="Referral code" value={referralCode} onChange={setReferralCode} placeholder="e.g. JANE20" />
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Additional notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Gate code, dog in the yard, problem areas…"
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Photos <span className="font-normal text-ink-faint normal-case">(optional)</span></label>
                <p className="text-[11px] text-ink-faint -mt-0.5">Show us gates, slopes, or problem areas so we can quote accurately. Up to 6.</p>
                <label className={cn('inline-flex items-center gap-1.5 text-xs font-medium w-fit rounded-md focus-within:ring-2 focus-within:ring-accent/50', photoUrls.length >= 6 ? 'text-ink-faint cursor-not-allowed' : 'text-accent-text cursor-pointer')}>
                  {uploadingPhotos ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />} {uploadingPhotos ? 'Uploading…' : photoUrls.length >= 6 ? 'Maximum 6 photos added' : 'Add photos of your lawn'}
                  <input type="file" accept="image/*" multiple onChange={addPhotos} className="sr-only" disabled={uploadingPhotos || photoUrls.length >= 6} />
                </label>
                {photoUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {photoUrls.map(u => (
                      <div key={u} className="relative w-14 h-14 rounded-lg overflow-hidden border border-border-strong">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u} alt="Lawn photo" className="w-full h-full object-cover" />
                        <button type="button" onClick={() => removePhoto(u)} aria-label="Remove photo"
                          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><X className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                )}
                {photoError && <p className="text-[11px] text-amber-400">{photoError}</p>}
              </div>

              {/* Stay in the loop — synced straight into the business's messaging
                  preferences (channel opt-ins + per-category prefs). */}
              <div className="rounded-card border border-border bg-bg-secondary px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-ink-muted">Keep me updated by text & email about…</p>
                {([
                  ['reminders', 'Appointment reminders & service updates'],
                  ['estimates', 'My estimate & quotes'],
                  ['invoices', 'Invoices & receipts'],
                  ['seasonal', 'Seasonal reminders'],
                  ['marketing', 'Offers & news'],
                ] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2.5 text-sm text-ink cursor-pointer">
                    <input type="checkbox" checked={consentPrefs[k]} onChange={() => setConsentPrefs(p => ({ ...p, [k]: !p[k] }))}
                      className="w-4 h-4 rounded border-border-strong accent-accent shrink-0" />
                    {label}
                  </label>
                ))}
                {/* "your customer portal" — I've never logged into anything. Did I just
                    create an account? Describe it as the thing they'll receive, not a
                    place they're assumed to already know. */}
                <p className="text-[10px] text-ink-faint">Reply STOP to any text to opt out. Once you&rsquo;re booked we&rsquo;ll send you a private link where you can change these anytime.</p>
              </div>
            </div>
            {plan && (
              <div className="mt-4 rounded-card border border-border bg-bg-secondary px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-ink-muted">{plan.label}</span>
                <span className="text-base font-bold text-ink tabular-nums">{formatCurrency(plan.price)}{plan.key !== 'one_time' ? '/visit' : ''}</span>
              </div>
            )}
            <p className="text-[11px] text-ink-faint mt-2 text-center">No charge today — booking is free, and {biz.company_name || 'we'} will confirm your price with you first.{plan && plan.key !== 'one_time' ? ' Recurring plans can be changed or cancelled anytime.' : ''}</p>
            {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
            {name.trim() && !email.trim() && !phone.trim() && (
              <p className="text-xs text-ink-muted mt-3">Add an email or phone number so {biz.company_name || 'we'} can confirm your visit.</p>
            )}
            {/* Tell the customer exactly where their confirmation will arrive. */}
            {(email.trim() || phone.trim()) && (
              <p className="text-xs text-ink-muted mt-3 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                We&rsquo;ll confirm your visit by {phone.trim() && email.trim() ? 'text and email' : phone.trim() ? 'text' : 'email'}.
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" aria-label="Back" onClick={() => setStep('plan')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button size="lg" type="submit" className="flex-1" loading={submitting} disabled={!name.trim() || !(email.trim() || phone.trim())}>{submitting ? 'Booking your service…' : <>Book my service <Check className="w-4 h-4" /></>}</Button>
            </div>
            </form>
          </Section>
        )}

        {/* STEP: done */}
        {step === 'done' && (
          <div className="py-8 space-y-5">
            <div className="text-center space-y-2">
              <CheckCircle2 className="w-14 h-14 text-emerald-400 mx-auto" />
              <p className="text-xl font-bold text-ink">You’re all set! 🎉</p>
              <p className="text-sm text-ink-muted">Thanks, {name.split(' ')[0]} — here’s what you requested:</p>
            </div>

            {/* Order summary — echo the request back so the customer feels confident. */}
            <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border text-sm">
              {(parsed?.formatted || parsed?.address) && <SummaryRow label="Address" value={parsed.formatted || parsed.address || ''} />}
              {plan && <SummaryRow label="Plan" value={`${plan.label} · ${formatCurrency(plan.price)}${plan.key !== 'one_time' ? '/visit' : ''}`} />}
              {sqft > 0 && <SummaryRow label="Lawn size" value={`~${sqft.toLocaleString()} sq ft`} />}
              {quoteNumber && <SummaryRow label="Confirmation #" value={quoteNumber} />}
            </div>
            {/* A confirmation now really goes out (api/booking/notify sends the customer
                the booking_received template, not just the owner alert), so this can
                finally promise it. Email is the durable copy; SMS only with consent. */}
            {quoteNumber && (
              <p className="text-[11px] text-ink-faint text-center -mt-2">
                {email.trim()
                  ? <>We&rsquo;ve emailed this confirmation to <span className="text-ink-muted font-medium">{email.trim()}</span> so you have it in writing.</>
                  : <>That&rsquo;s your reference if you call or text us — your request is saved either way.</>}
              </p>
            )}

            {/* What happens next — the #1 anxiety point, answered with a concrete SLA. */}
            <div className="rounded-card border border-accent/25 bg-accent/[0.06] px-4 py-3.5">
              <p className="text-xs font-semibold text-ink mb-1.5">What happens next</p>
              <p className="text-xs text-ink-muted leading-relaxed">
                {biz.company_name || 'We'} will review your request and confirm your price and first visit — usually within one business day.{(email.trim() || phone.trim()) ? ` We’ll reach you by ${phone.trim() && email.trim() ? 'text and email' : phone.trim() ? 'text' : 'email'}.` : ''}
              </p>
            </div>

            {(biz.phone || biz.email_primary) && (
              <div className="text-center">
                <p className="text-xs text-ink-faint mb-1.5">Questions before then?</p>
                <div className="flex flex-col items-center gap-1.5">
                  {biz.phone && <a href={`tel:${biz.phone}`} className="text-sm text-accent-text flex items-center gap-1.5"><Phone className="w-4 h-4" /> {biz.phone}</a>}
                  {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="text-sm text-ink-muted flex items-center gap-1.5"><Mail className="w-4 h-4" /> {biz.email_primary}</a>}
                </div>
              </div>
            )}
          </div>
        )}

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
    </div>
  )
}

function Center({ children }: { children: ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center">{children}</div>
}
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <span className="text-ink-faint shrink-0">{label}</span>
      <span className="text-ink font-medium text-right min-w-0 break-words">{value}</span>
    </div>
  )
}
function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-bold text-ink tracking-tight">{title}</h1>
      {sub && <p className="text-sm text-ink-muted mt-1 mb-4 tabular-nums">{sub}</p>}
      {children}
    </div>
  )
}
function ConfidenceBadge({ confidence }: { confidence?: string }) {
  // Customer-facing: never tell a prospect their estimate is "low confidence" at the
  // conversion moment — the tiering below keeps that. But "Verified" claimed a human
  // checked this, and none did: it's a satellite measurement. If the price moves after
  // the first visit, a customer who was shown "Verified" reads the whole quote as bait.
  // Naming the source keeps the confidence signal ("Measured" > "Estimated") and is true.
  if (confidence === 'high') {
    return <span className="text-[10px] font-semibold uppercase tracking-[0.14em] rounded-full px-2 py-0.5 border text-emerald-400 border-emerald-500/30 bg-emerald-500/10">Measured from satellite</span>
  }
  return <span className="text-[10px] font-semibold uppercase tracking-[0.14em] rounded-full px-2 py-0.5 border text-ink-muted border-border bg-bg-tertiary">Estimated from satellite</span>
}
function Field({ label, value, onChange, placeholder, type, autoFocus, autoComplete, inputMode }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; autoFocus?: boolean
  autoComplete?: string; inputMode?: 'email' | 'tel' | 'text' | 'numeric'
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</span>
      <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        autoComplete={autoComplete} inputMode={inputMode}
        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
    </label>
  )
}
