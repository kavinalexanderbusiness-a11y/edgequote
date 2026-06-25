'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode, type ChangeEvent } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { pricingConfigFromSettings, pricingPackage } from '@/lib/pricing'
import { applyFeeRecovery } from '@/lib/invoiceTotals'
import { autoMeasureLawn, AutoMeasureResult, neighborhoodOf } from '@/lib/autoMeasure'
import { loadGoogleMaps } from '@/lib/googleMaps'
import { AddressAutocomplete, ParsedAddress } from '@/components/ui/AddressAutocomplete'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { BrandHeader } from '@/components/layout/BrandHeader'
import { formatCurrency, cn } from '@/lib/utils'
import { Leaf, Loader2, Undo2, Trash2, Check, ArrowRight, ArrowLeft, Ruler, CheckCircle2, Phone, Mail, Camera } from 'lucide-react'

// ── Public instant-quote + booking funnel ───────────────────────────────────
// No login. A prospect enters their address, traces their lawn on satellite for
// an instant price from the owner's real pricing engine, picks a plan, and books
// — creating a customer + property + quote for the owner. Token-scoped RPCs.

interface Biz {
  company_name: string | null; owner_name: string | null; logo_url: string | null
  phone: string | null; email_primary: string | null; website: string | null
  pricing_base_charge: number | null; pricing_mow_rate: number | null
  pricing_recommended_mult: number | null; pricing_premium_mult: number | null; pricing_travel_rate: number | null
  payment_fee_strategy: string | null; fee_recovery_percent: number | null; gst_percent: number | null
}

type Step = 'address' | 'measure' | 'plan' | 'contact' | 'done'
interface Plan { key: 'one_time' | 'weekly' | 'biweekly' | 'monthly'; label: string; price: number; annual?: number; recommended?: boolean }

const M2_TO_SQFT = 10.7639
const HEAR_OPTIONS = ['Website', 'Google Business Profile', 'QR code', 'Facebook', 'Nextdoor', 'Referral from a friend', 'Drove by / yard sign', 'Other']

export default function BookPage() {
  const params = useParams()
  const token = String(params?.token || '')
  const supabase = useMemo(() => createClient(), [])

  const [biz, setBiz] = useState<Biz | null>(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<Step>('address')

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
  const [utm, setUtm] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quoteNumber, setQuoteNumber] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('get_booking_business', { p_token: token })
      setBiz((data as Biz | null) ?? null)
      setLoading(false)
    })()
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
    if (!files.length) return
    setUploadingPhotos(true)
    const added: string[] = []
    for (const f of files.slice(0, 6)) {
      const safe = f.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')
      const path = `${token}/${crypto.randomUUID()}-${safe}`
      const { error: upErr } = await supabase.storage.from('booking-uploads').upload(path, f, { upsert: false })
      if (!upErr) added.push(supabase.storage.from('booking-uploads').getPublicUrl(path).data.publicUrl)
    }
    setPhotoUrls(prev => [...prev, ...added])
    setUploadingPhotos(false)
  }

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

  async function submit() {
    if (!parsed || !plan || !name.trim()) return
    setSubmitting(true); setError(null)
    const fee = { payment_fee_strategy: biz?.payment_fee_strategy as never, fee_recovery_percent: biz?.fee_recovery_percent }
    const cfg = pricingConfigFromSettings(biz)
    const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: 0 })
    const opt = (c: string) => pkg.options.find(o => o.cadence === c)?.price ?? 0
    const { data, error: rpcErr } = await supabase.rpc('submit_booking', {
      p_token: token, p_name: name.trim(), p_email: email.trim(), p_phone: phone.trim(),
      p_address: parsed.address || parsed.formatted, p_city: parsed.city, p_province: parsed.province, p_postal: parsed.postal,
      p_lat: parsed.lat, p_lng: parsed.lng, p_sqft: sqft, p_service_type: 'Lawn Mowing',
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
    if (rpcErr || !res?.quote_number) { setError('Something went wrong — please try again or call us.'); return }
    setQuoteNumber(res.quote_number)
    // Record auto vs accepted area so the estimate self-calibrates (best-effort).
    supabase.rpc('record_booking_measurement', {
      p_token: token, p_quote_id: res.quote_id ?? null, p_lat: parsed.lat, p_lng: parsed.lng,
      p_neighborhood: neighborhoodOf(parsed.postal, parsed.city, null),
      p_auto: autoResult?.sqft ?? null, p_accepted: sqft, p_building: autoResult?.buildingSqft ?? null, p_confidence: autoResult?.confidence ?? null,
    }).then(() => {}, () => {})
    // Best-effort owner alert (no-op if email isn't configured).
    fetch('/api/booking/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: name.trim(), address: parsed.formatted, cadence: plan.label, quoteNumber: res.quote_number }) }).catch(() => {})
    setStep('done')
  }

  if (loading) return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-48 w-full rounded-card" />
      </div>
    </div>
  )
  if (!biz) return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <EmptyState icon={Leaf} title="Booking isn’t available"
        description="This link may be inactive. Please contact the business directly." />
    </div>
  )

  const gst = Number(biz.gst_percent) || 0

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-6 pb-24">
        {/* Brand header */}
        <BrandHeader logoUrl={biz.logo_url} name={biz.company_name || 'Get an instant quote'} subtitle="Instant lawn-care quote · book in minutes" />

        {/* Progress */}
        {step !== 'done' && (
          <div className="flex items-center gap-1.5 mb-4">
            {(['address', 'measure', 'plan', 'contact'] as Step[]).map((s, i) => (
              <div key={s} className={cn('h-1.5 flex-1 rounded-full', ['address', 'measure', 'plan', 'contact'].indexOf(step) >= i ? 'bg-accent' : 'bg-border')} />
            ))}
          </div>
        )}

        {/* STEP: address */}
        {step === 'address' && (
          <Section title="Where's your lawn?" sub="Enter your address to get an instant price.">
            <AddressAutocomplete label="Property address" value={addressText} onChange={setAddressText}
              onSelect={p => { setParsed(p); setAddressText(p.formatted); setAutoResult(undefined); setShowTracer(false); setSqft(0) }} placeholder="Start typing your address…" />
            <Button className="w-full mt-4" disabled={!parsed?.lat} onClick={() => setStep('measure')}>
              Next <ArrowRight className="w-4 h-4" />
            </Button>
          </Section>
        )}

        {/* STEP: measure — auto by default, with adjust + redraw */}
        {step === 'measure' && (
          <Section title="Your lawn" sub="We measure it automatically — accept it, tweak the number, or redraw it exactly.">
            {measuring ? (
              <div className="py-12 text-center text-sm text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Measuring your lawn…</div>
            ) : !showTracer && autoResult ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink-muted flex items-center gap-2"><Ruler className="w-4 h-4 text-accent" /> Estimated lawn size</span>
                    <ConfidenceBadge confidence={autoResult.confidence} />
                  </div>
                  <div className="flex items-end gap-2 mt-2">
                    <input type="number" value={sqft || ''} onChange={e => setSqft(Number(e.target.value) || 0)}
                      className="w-32 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-xl font-bold text-ink outline-none focus:border-accent" />
                    <span className="text-sm text-ink-muted pb-2">sq ft</span>
                  </div>
                  <p className="text-[11px] text-ink-faint mt-1">Auto-estimated — edit the number to adjust, or redraw it exactly below.</p>
                </div>
                <Button variant="secondary" className="w-full" onClick={() => setShowTracer(true)}><Ruler className="w-4 h-4" /> Redraw on the map</Button>
              </div>
            ) : mapErr && mapErr !== 'manual' ? (
              <div className="space-y-3">
                <p className="text-sm text-amber-400">{mapErr}</p>
                <label className="text-xs text-ink-muted">Approximate lawn size (sq ft)</label>
                <input type="number" value={manualSqft} onChange={e => { setManualSqft(e.target.value); setSqft(Number(e.target.value) || 0) }}
                  placeholder="e.g. 3000" className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent" />
              </div>
            ) : mapErr === 'manual' ? (
              <div className="space-y-3">
                <label className="text-xs text-ink-muted">Approximate lawn size (sq ft)</label>
                <input type="number" value={manualSqft} onChange={e => { setManualSqft(e.target.value); setSqft(Number(e.target.value) || 0) }}
                  placeholder="e.g. 3000" className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent" />
              </div>
            ) : (
              <>
                <div ref={mapEl} className="w-full h-72 rounded-xl overflow-hidden border border-border-strong bg-bg-tertiary" />
                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-2 text-sm text-ink">
                    <Ruler className="w-4 h-4 text-accent" /> {sqft > 0 ? `${sqft.toLocaleString()} sq ft` : 'Tap 3+ corners to start'}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={undo} title="Undo last point"><Undo2 className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={clearTrace} title="Clear"><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <button onClick={() => setMapErr('manual')} className="text-xs text-ink-faint hover:text-ink mt-2 underline">Enter size manually instead</button>
              </>
            )}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={() => setStep('address')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button className="flex-1" disabled={sqft <= 0} onClick={() => setStep('plan')}>See my price <ArrowRight className="w-4 h-4" /></Button>
            </div>
          </Section>
        )}

        {/* STEP: plan */}
        {step === 'plan' && (
          <Section title="Your instant quote" sub={`${sqft.toLocaleString()} sq ft lawn · choose how often you'd like service.`}>
            <div className="space-y-2">
              {plans.map(p => (
                <button key={p.key} onClick={() => setPlan(p)}
                  className={cn('w-full text-left rounded-xl border px-4 py-3 transition-all flex items-center justify-between gap-3',
                    plan?.key === p.key ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/40')}>
                  <div>
                    <p className="text-sm font-semibold text-ink flex items-center gap-2">{p.label}{p.recommended && <span className="text-[10px] uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">Best value</span>}</p>
                    {p.annual ? <p className="text-xs text-ink-faint mt-0.5">{formatCurrency(p.price)}/visit · ~{formatCurrency(p.annual)}/season</p> : <p className="text-xs text-ink-faint mt-0.5">single visit</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-ink">{formatCurrency(p.price)}</p>
                    <p className="text-[10px] text-ink-faint">{p.key === 'one_time' ? 'one-time' : 'per visit'}</p>
                  </div>
                </button>
              ))}
            </div>
            {gst > 0 && <p className="text-[11px] text-ink-faint mt-2">Prices shown before {gst}% GST.</p>}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={() => setStep('measure')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button className="flex-1" disabled={!plan} onClick={() => setStep('contact')}>Continue <ArrowRight className="w-4 h-4" /></Button>
            </div>
          </Section>
        )}

        {/* STEP: contact */}
        {step === 'contact' && (
          <Section title="Almost done" sub={`Book your ${plan?.label.toLowerCase()} service. ${biz.company_name || 'We'}'ll confirm and schedule your first visit.`}>
            <div className="space-y-3">
              <Field label="Your name" value={name} onChange={setName} placeholder="Jane Doe" />
              <Field label="Email" value={email} onChange={setEmail} placeholder="jane@example.com" type="email" />
              <Field label="Phone" value={phone} onChange={setPhone} placeholder="(403) 555-0100" type="tel" />
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted">How did you hear about us?</label>
                <select value={hearAbout} onChange={e => setHearAbout(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent">
                  <option value="">Select…</option>
                  {HEAR_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <Field label="Referral code (optional)" value={referralCode} onChange={setReferralCode} placeholder="e.g. JANE20" />
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted">Additional notes (optional)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Gate code, dog in the yard, problem areas…"
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted">Photos (optional)</label>
                <label className="inline-flex items-center gap-1.5 text-xs font-medium text-accent cursor-pointer">
                  <Camera className="w-3.5 h-3.5" /> {uploadingPhotos ? 'Uploading…' : 'Add photos of your lawn'}
                  <input type="file" accept="image/*" multiple onChange={addPhotos} className="hidden" disabled={uploadingPhotos} />
                </label>
                {photoUrls.length > 0 && <p className="text-[11px] text-emerald-400">{photoUrls.length} photo{photoUrls.length !== 1 ? 's' : ''} attached</p>}
              </div>
            </div>
            {plan && (
              <div className="mt-4 rounded-xl border border-border bg-bg-secondary px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-ink-muted">{plan.label}</span>
                <span className="text-base font-bold text-ink">{formatCurrency(plan.price)}{plan.key !== 'one_time' ? '/visit' : ''}</span>
              </div>
            )}
            {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
            <div className="flex gap-2 mt-4">
              <Button variant="secondary" onClick={() => setStep('plan')}><ArrowLeft className="w-4 h-4" /></Button>
              <Button className="flex-1" loading={submitting} disabled={!name.trim()} onClick={submit}>Book my service <Check className="w-4 h-4" /></Button>
            </div>
          </Section>
        )}

        {/* STEP: done */}
        {step === 'done' && (
          <div className="text-center py-10 space-y-3">
            <CheckCircle2 className="w-14 h-14 text-emerald-400 mx-auto" />
            <p className="text-xl font-bold text-ink">You’re booked!</p>
            <p className="text-sm text-ink-muted">Thanks, {name.split(' ')[0]}. {biz.company_name || 'We'} received your request{quoteNumber ? ` (${quoteNumber})` : ''} and will reach out shortly to confirm your first visit.</p>
            <div className="flex flex-col items-center gap-1.5 pt-3">
              {biz.phone && <a href={`tel:${biz.phone}`} className="text-sm text-accent flex items-center gap-1.5"><Phone className="w-4 h-4" /> {biz.phone}</a>}
              {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="text-sm text-ink-muted flex items-center gap-1.5"><Mail className="w-4 h-4" /> {biz.email_primary}</a>}
            </div>
          </div>
        )}

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
    </div>
  )
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-bold text-ink">{title}</h1>
      {sub && <p className="text-sm text-ink-muted mt-1 mb-4">{sub}</p>}
      {children}
    </div>
  )
}
function ConfidenceBadge({ confidence }: { confidence?: string }) {
  const map: Record<string, string> = {
    high: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
    medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    low: 'text-ink-muted border-border bg-bg-tertiary',
  }
  const c = confidence || 'low'
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', map[c] || map.low)}>{c} confidence</span>
}
function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-ink-muted">{label}</label>
      <input type={type || 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent" />
    </div>
  )
}
