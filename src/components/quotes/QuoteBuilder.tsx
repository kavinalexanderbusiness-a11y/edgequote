'use client'

import { useEffect, useMemo, useState } from 'react'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/Input'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { useAutosave } from '@/hooks/useAutosave'
import { AutosaveStatus, DraftRestoreBanner } from '@/components/ui/Autosave'
import { QuoteMeasure } from '@/components/quotes/QuoteMeasure'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Collapsible } from '@/components/ui/Collapsible'
import { QuoteFormValues, Customer, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { sumServiceLines, serviceLineTotals, emptyServiceLine, SERVICE_UNITS } from '@/lib/quoteServices'
import { formatCurrency, formatDate, suggestTravelFee, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { formatServicePrice, servicePricingKind } from '@/lib/servicePricing'
import { laborSuggestion, pricingConfigFromSettings, latestSavedRecommendation, recommendationIsStale, pricingPackage } from '@/lib/pricing'
import { evaluatePrice, PriceGuardrail } from '@/lib/priceGuardrails'
import { PriceGuardrailNote } from '@/components/pricing/PriceGuardrailNote'
import { findCustomerMatch } from '@/lib/customers'
import { createClient } from '@/lib/supabase/client'
import type { MeasurementSnapshot, SavedRecommendation } from '@/types'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { SmartLaborField } from '@/components/labor/SmartLaborField'
import { PriceIntelligence } from '@/components/pricing/PriceIntelligence'
import { Clock, DollarSign, Car, Calculator, AlertTriangle, MapPin, Repeat, Ruler, Sparkles, FileText, SlidersHorizontal, CheckCircle2, Users, Layers, Plus, Trash2 } from 'lucide-react'

interface QuoteBuilderProps {
  customers: Customer[]
  templates: ServiceTemplate[]
  tiers: TravelFeeTier[]
  settings?: BusinessSettings | null
  defaultCustomerId?: string
  // When opened from a SPECIFIC property (per-property Quote button), load that
  // property's address + saved lawn size instead of the customer's primary.
  defaultPropertyId?: string
  defaultValues?: Partial<QuoteFormValues>
  onSubmit: (values: QuoteFormValues) => Promise<void>
  isEdit?: boolean
  /** Autosave key — defaults per new/edit; pass a precise one (e.g. `quote:${id}`). */
  autosaveKey?: string
  /** Server record's updated_at — drafts older than this are never offered. */
  autosaveBaselineUpdatedAt?: string | null
}

const DEFAULT_RATE = 50

export function QuoteBuilder({
  customers, templates, tiers, settings, defaultCustomerId, defaultPropertyId, defaultValues, onSubmit, isEdit,
  autosaveKey, autosaveBaselineUpdatedAt,
}: QuoteBuilderProps) {
  const router = useRouter()
  const { register, handleSubmit, watch, setValue, getValues, reset, control, formState: { errors, isSubmitting } } =
    useForm<QuoteFormValues>({
      defaultValues: {
        customer_id: defaultCustomerId || '',
        customer_name: '',
        customer_phone: '',
        customer_email: '',
        address: '',
        service_type: '',
        service_template_id: '',
        initial_price: 0,
        weekly_price: 0,
        biweekly_price: 0,
        monthly_price: 0,
        measured_sqft: 0,
        suggested_price: 0,
        overgrowth_multiplier: 1,
        distance_km: 0,
        hours: 2,
        crew_size: 1,
        rate: DEFAULT_RATE,
        travel_fee: 0,
        notes: '',
        status: 'draft',
        services: [],
        ...defaultValues,
      },
    })

  // Additional service lines beyond the primary one (multi-service quotes).
  const serviceLines = useFieldArray({ control, name: 'services' })

  // Autosave the whole quote — survives refresh / crash / accidental close (shared engine).
  const formValues = watch()
  const autosave = useAutosave<QuoteFormValues>({
    key: autosaveKey || (isEdit ? 'quote:edit' : 'quote:new'),
    value: formValues,
    baselineUpdatedAt: autosaveBaselineUpdatedAt ?? null,
    isEmpty: v => !v.customer_id && !v.customer_name?.trim() && !v.address?.trim() && !v.service_type?.trim() && !(Number(v.initial_price) > 0),
  })
  const submit = handleSubmit(async v => { await onSubmit(v); autosave.clear() })

  const [calcLoading, setCalcLoading] = useState(false)
  const [calcMsg, setCalcMsg] = useState<string | null>(null)
  const [showMeasure, setShowMeasure] = useState(false)
  const [includeTravel, setIncludeTravel] = useState(true)
  const [initialManual, setInitialManual] = useState<boolean>((defaultValues?.initial_price ?? 0) > 0)
  const [showBestDays, setShowBestDays] = useState(false)
  // Saved recommendation from the customer's latest property measurement — the
  // source of truth for suggested prices (no re-measuring needed).
  const [savedRec, setSavedRec] = useState<{ rec: SavedRecommendation; sqft: number; date: string } | null>(null)
  // Which suggested price the owner tapped — drives the compact "Suggested Pricing"
  // highlight. Cleared the moment a price is edited (manual override).
  const [pickedCadence, setPickedCadence] = useState<'one_time' | 'weekly' | 'biweekly' | null>(null)

  const hours = watch('hours') || 0
  const crewSize = watch('crew_size') || 1
  const rate = watch('rate') || DEFAULT_RATE
  const travelFee = watch('travel_fee') || 0
  const customerId = watch('customer_id')
  const templateId = watch('service_template_id')
  const overgrowth = Number(watch('overgrowth_multiplier')) || 1
  const distanceKm = Number(watch('distance_km')) || 0
  const address = watch('address')
  const showTravelSeparately = watch('show_travel_separately')
  const customTravelRequired = watch('custom_travel_required')
  const initialPrice = Number(watch('initial_price')) || 0
  const weeklyPrice = Number(watch('weekly_price')) || 0
  const biweeklyPrice = Number(watch('biweekly_price')) || 0
  const monthlyPrice = Number(watch('monthly_price')) || 0

  const manualName = watch('customer_name')
  const manualPhone = watch('customer_phone')
  const manualEmail = watch('customer_email')
  const notes = watch('notes')
  const measuredSqft = Number(watch('measured_sqft')) || 0

  // Smart Price Guardrails — per-cadence, never-block warnings (measured lawn +
  // crew cost). Each filled cadence is judged against ITS own recommended price.
  const priceGuardrails = useMemo<PriceGuardrail[]>(() => {
    const cfg = pricingConfigFromSettings(settings)
    const crewCost = settings?.crew_cost_per_hour && settings.crew_cost_per_hour > 0 ? settings.crew_cost_per_hour : 40
    const out: PriceGuardrail[] = []
    const add = (cadence: 'one_time' | 'weekly' | 'biweekly' | 'monthly', price: number) => {
      if (price > 0) out.push(evaluatePrice({ cadence, price, sqft: measuredSqft, cfg, crewCost }))
    }
    add('one_time', initialPrice); add('weekly', weeklyPrice); add('biweekly', biweeklyPrice); add('monthly', monthlyPrice)
    return out
  }, [settings, measuredSqft, initialPrice, weeklyPrice, biweeklyPrice, monthlyPrice])

  // Live duplicate detection — when entering a brand-new lead, surface a likely
  // existing customer so we link instead of creating a duplicate. Reuses the
  // single matching engine (phone/email/address confident, name not).
  const isManualEntry = !customerId || customerId === '__manual'
  const likelyMatch = useMemo(
    () => (isManualEntry ? findCustomerMatch(customers, { name: manualName, phone: manualPhone, email: manualEmail, address }) : null),
    [isManualEntry, customers, manualName, manualPhone, manualEmail, address],
  )
  const suggestedInitial = laborSuggestion(Number(hours), Number(crewSize), Number(rate), overgrowth || 1)
  // Additional service lines — summed by the ONE quote-services engine (same
  // discount semantics as invoices). The first-visit total = primary + extras + travel.
  const watchedServices = watch('services')
  const extras = useMemo(() => sumServiceLines(watchedServices), [watchedServices])
  const effectiveTotal = initialPrice + extras.net + Number(travelFee || 0)

  // Which pricing STRUCTURE this service uses — the one seam that decides which
  // engine recommends and which fields an Accept fills (lawn cadences vs area
  // rate vs labour). Template display type wins; else the serviceKey normalizer.
  const svcTemplate = templates.find(t => t.id === templateId) ?? null
  const pricingKind = servicePricingKind(watch('service_type'), svcTemplate)

  // Live suggested prices straight from the measured lawn — the compact one-tap
  // pricing. Same engine as everywhere else; ONLY for lawn-cadence services (a
  // hedge job or mulch install must never be priced as that many ft² of grass).
  const suggested = useMemo(() => {
    if (pricingKind !== 'lawn_recurring' || measuredSqft <= 0) return null
    const cfg = pricingConfigFromSettings(settings)
    const pkg = pricingPackage(measuredSqft, cfg, { overgrowth: overgrowth || 1, nearbyCount: 0 })
    return {
      one_time: pkg.oneTime,
      weekly: pkg.options.find(o => o.cadence === 'weekly')?.price ?? 0,
      biweekly: pkg.options.find(o => o.cadence === 'biweekly')?.price ?? 0,
      monthly: pkg.options.find(o => o.cadence === 'monthly')?.price ?? 0,
      recommended: pkg.recommended.cadence,
    }
  }, [pricingKind, measuredSqft, overgrowth, settings])

  // The service-appropriate single recommendation for NON-lawn kinds.
  //   per_area → the template's $/sq ft × the measured area (+ materials note)
  //   labour   → hours × crew × rate (the existing labour engine)
  const areaRate = svcTemplate && svcTemplate.pricing_display_type === 'per_sqft' ? Number(svcTemplate.default_rate) || 0 : 0
  const serviceRec = useMemo(() => {
    if (pricingKind === 'per_area' && areaRate > 0 && measuredSqft > 0) {
      return {
        price: Math.round(areaRate * measuredSqft),
        basis: `${formatCurrency(areaRate)}/sq ft × ${Math.round(measuredSqft).toLocaleString()} sq ft`,
        materials: svcTemplate?.pricing_display_type?.includes('materials') ?? false,
      }
    }
    if (pricingKind === 'labour' || pricingKind === 'per_area') {
      return {
        price: suggestedInitial,
        basis: `${Number(hours) || 0} hr × ${crewSize} crew × ${formatCurrency(Number(rate))}/hr`,
        materials: (svcTemplate?.pricing_display_type || '').includes('materials'),
      }
    }
    return null
  }, [pricingKind, areaRate, measuredSqft, suggestedInitial, hours, crewSize, rate, svcTemplate])

  // Accept for one-off services: fill the one price that makes sense and CLEAR
  // the lawn cadence fields (weekly mulch makes no sense on a quote).
  function applyServiceRec() {
    if (!serviceRec) return
    setValue('initial_price', serviceRec.price)
    setValue('weekly_price', 0)
    setValue('biweekly_price', 0)
    setValue('monthly_price', 0)
    setValue('suggested_price', serviceRec.price)
    setInitialManual(true)
    setPickedCadence(null)
  }

  // Monthly is off the standard lawn-care menu (a month of growth is a rough cut) —
  // it stays blank unless the owner explicitly enables it. Editing loads it as
  // enabled when the quote already has a monthly price.
  const [includeMonthly, setIncludeMonthly] = useState<boolean>((defaultValues?.monthly_price ?? 0) > 0)

  // Tap a suggestion → fill One-Time + Weekly + Bi-Weekly TOGETHER (the customer
  // sees every option, no re-typing); the tapped cadence is just the one you'd
  // pitch. Monthly fills only when enabled. All fields stay editable after.
  function applySuggested(c: 'one_time' | 'weekly' | 'biweekly') {
    if (!suggested) return
    setValue('initial_price', suggested.one_time)
    setValue('weekly_price', suggested.weekly)
    setValue('biweekly_price', suggested.biweekly)
    setValue('monthly_price', includeMonthly ? suggested.monthly : 0)
    setValue('suggested_price', suggested.one_time)
    setInitialManual(false)
    setPickedCadence(c)
  }

  // One-line summaries so collapsed sections still reveal their state.
  const recSummary = [
    weeklyPrice > 0 && `Wk ${formatCurrency(weeklyPrice)}`,
    biweeklyPrice > 0 && `Bi ${formatCurrency(biweeklyPrice)}`,
    monthlyPrice > 0 && `Mo ${formatCurrency(monthlyPrice)}`,
  ].filter(Boolean).join(' · ')
  const travelSummary = Number(travelFee) > 0
    ? `${formatCurrency(Number(travelFee))}${distanceKm > 0 ? ` · ${distanceKm} km` : ''}`
    : (includeTravel ? 'No fee yet' : 'Absorbing travel')
  const laborSummary = `${Number(hours) || 0} hr · ${crewSize} crew · ${formatCurrency(Number(rate))}/hr`

  useEffect(() => {
    if (!customerId || customerId === '__manual') return
    const customer = customers.find(c => c.id === customerId)
    if (customer) {
      setValue('customer_name', customer.name)
      if (!isEdit && customer.address) {
        const full = [customer.address, customer.city, customer.province].filter(Boolean).join(', ')
        setValue('address', full)
      }
    }
  }, [customerId, customers, setValue, isEdit])

  // Pull the latest measurement recommendation for the relevant property — the
  // SPECIFIC property when one was requested (per-property Quote button), else the
  // customer's primary. Measured prices become the suggestion, no re-measuring.
  useEffect(() => {
    if (!customerId || customerId === '__manual') { setSavedRec(null); return }
    let active = true
    async function load() {
      const supabase = createClient()
      const cols = 'lawn_sqft, measurement_history, address, city, province'
      const res = defaultPropertyId
        ? await supabase.from('properties').select(cols).eq('id', defaultPropertyId).limit(1).maybeSingle()
        : await supabase.from('properties').select(cols).eq('customer_id', customerId).order('is_primary', { ascending: false }).limit(1).maybeSingle()
      if (!active) return
      const row = res.data as { lawn_sqft: number | null; measurement_history: MeasurementSnapshot[]; address: string | null; city: string | null; province: string | null } | null
      setSavedRec(latestSavedRecommendation(row?.measurement_history))
      // Default the Lawn Size from the property's saved size when it's still empty —
      // don't clobber an edit, a website-measurement handoff, or a manual entry.
      const lawn = Number(row?.lawn_sqft) || 0
      if (!isEdit && lawn > 0 && (Number(getValues('measured_sqft')) || 0) === 0) {
        setValue('measured_sqft', lawn)
      }
      // Targeting a specific property → its address wins. Otherwise the primary
      // property's address fills the field only when it's still EMPTY (imported
      // customers and website leads often carry the address on the property, not
      // the customer record — never make the owner retype data we just fetched).
      if (!isEdit && row?.address) {
        const full = [row.address, row.city, row.province].filter(Boolean).join(', ')
        if (full && (defaultPropertyId || !getValues('address'))) setValue('address', full)
      }
    }
    load()
    return () => { active = false }
  }, [customerId, defaultPropertyId, isEdit, getValues, setValue])

  useEffect(() => {
    if (!templateId) return
    const t = templates.find(s => s.id === templateId)
    if (t) {
      setValue('service_type', t.name)
      // Only an HOURLY template's rate is a labour rate — a per-sqft or
      // starting-from figure is a PRICE and must never become $/man-hour.
      if (t.pricing_display_type === 'hourly' || t.pricing_display_type === 'hourly_materials') {
        setValue('rate', t.default_rate)
      }
      if (!isEdit && t.default_description) setValue('notes', t.default_description)
    }
  }, [templateId, templates, setValue, isEdit])

  useEffect(() => {
    // Labour keeps the price live ONLY while nothing was accepted or typed —
    // an accepted suggestion (pickedCadence) must never be silently overwritten.
    if (!initialManual && !pickedCadence) setValue('initial_price', suggestedInitial)
  }, [suggestedInitial, initialManual, pickedCadence, setValue])

  const travelSuggestion = distanceKm > 0 ? suggestTravelFee(distanceKm, tiers) : null

  useEffect(() => {
    if (travelSuggestion?.isCustom) {
      setValue('custom_travel_required', true)
    } else if (distanceKm > 0) {
      setValue('custom_travel_required', false)
    }
  }, [travelSuggestion, distanceKm, setValue])

  function applySuggestedTravel() {
    if (travelSuggestion && !travelSuggestion.isCustom && travelSuggestion.fee !== null) {
      setValue('travel_fee', travelSuggestion.fee)
    }
  }

  async function calculateDistance(addr?: string) {
    setCalcMsg(null)
    const base = settings?.base_address
    const dest = addr || address
    if (!base) { setCalcMsg('Set your base address in Settings first.'); return }
    if (!dest) { setCalcMsg('Enter a service address first.'); return }
    setCalcLoading(true)
    try {
      const res = await fetch('/api/distance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: base, destination: dest }),
      })
      const data = await res.json()
      if (res.ok && typeof data.km === 'number') {
        setValue('distance_km', data.km)
        const sugg = suggestTravelFee(data.km, tiers)
        if (includeTravel && !sugg.isCustom && sugg.fee !== null) setValue('travel_fee', sugg.fee)
        setCalcMsg(`${data.km} km${data.durationText ? ` · ${data.durationText} drive` : ''}`)
      } else {
        setCalcMsg(data.error || 'Could not calculate distance.')
      }
    } catch {
      setCalcMsg('Distance lookup failed.')
    } finally {
      setCalcLoading(false)
    }
  }

  function toggleIncludeTravel(on: boolean) {
    setIncludeTravel(on)
    if (!on) {
      setValue('travel_fee', 0)
    } else if (distanceKm > 0) {
      const s = suggestTravelFee(distanceKm, tiers)
      if (!s.isCustom && s.fee !== null) setValue('travel_fee', s.fee)
    }
  }

  // Memoized: the builder re-renders on every keystroke (many watch() subscriptions),
  // so without this these O(n) arrays would be rebuilt — and handed as fresh refs to the
  // Select children — on each character typed. Recompute only when the source lists change.
  const customerOptions = useMemo(() => [
    { value: '', label: 'Select a customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
    { value: '__manual', label: '+ Enter manually' },
  ], [customers])
  const activeTemplates = useMemo(() => templates.filter(t => t.is_active), [templates])
  const templateOptions = useMemo(() => [
    { value: '', label: 'Select a service...' },
    ...activeTemplates.map(t => ({ value: t.id, label: `${t.name} — ${formatServicePrice(t)}` })),
  ], [activeTemplates])
  const statusOptions = [
    { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' },
    { value: 'accepted', label: 'Accepted' }, { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' },
    { value: 'declined', label: 'Declined' },
  ]
  const showManualName = !customerId || customerId === '__manual'

  return (
    <form onSubmit={submit} className="pb-24 lg:pb-0">
      {autosave.draft && (
        <div className="mb-4">
          <DraftRestoreBanner
            savedAt={autosave.savedAt}
            label="unsaved quote"
            onRestore={() => { const v = autosave.restore(); if (v) reset(v) }}
            onDiscard={autosave.discard}
          />
        </div>
      )}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          {/* ── FAST PATH — Customer → Property → Service → Price → Save ── */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{isEdit ? 'Quote details' : 'New quote'}</h2>
              <div className="flex items-center gap-2">
                <AutosaveStatus status={autosave.status} savedAt={autosave.savedAt} />
                {initialManual && (
                  <span className="text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">Manual price</span>
                )}
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              {/* Customer — type-to-search picker (scales past a giant <select>) */}
              <Controller name="customer_id" control={control}
                render={({ field }) => (
                  <CustomerPicker label="Customer" customers={customers} value={field.value || ''} onChange={field.onChange} />
                )} />
              {showManualName && (
                <div className="space-y-3 rounded-xl border border-accent/20 bg-accent/5 p-3">
                  <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent" /> New person — we&apos;ll save them as a customer &amp; property automatically when you save.
                  </p>
                  <Input label="Customer Name" placeholder="Full name"
                    error={errors.customer_name?.message}
                    {...register('customer_name', { required: 'Customer name is required' })} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input label="Phone (optional)" type="tel" placeholder="(403) 555-0100"
                      hint="Used to avoid duplicates" {...register('customer_phone')} />
                    <Input label="Email (optional)" type="email" placeholder="jane@example.com"
                      {...register('customer_email')} />
                  </div>

                  {/* Likely-match prompt — use the existing customer instead of duplicating */}
                  {likelyMatch && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-2">
                      <p className="text-xs text-ink flex items-start gap-1.5">
                        <Users className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {likelyMatch.confident
                            ? <>Looks like an existing customer — <span className="font-semibold">{likelyMatch.customer.name}</span> (same {likelyMatch.reason}).</>
                            : <>Possible existing customer — <span className="font-semibold">{likelyMatch.customer.name}</span> (same name).</>}
                          {' '}<span className="text-ink-muted">Use them to avoid a duplicate?</span>
                        </span>
                      </p>
                      <div className="flex items-center gap-2">
                        <Button type="button" size="sm" onClick={() => setValue('customer_id', likelyMatch.customer.id)}>
                          Use {likelyMatch.customer.name.split(' ')[0]}
                        </Button>
                        <span className="text-[10px] text-ink-faint">or keep typing to save as new</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Property */}
              <Controller name="address" control={control}
                rules={{ required: 'Address is required' }}
                render={({ field }) => (
                  <AddressAutocomplete
                    label="Service Address"
                    placeholder="123 Main Street, Calgary, AB"
                    value={field.value || ''}
                    onChange={field.onChange}
                    onSelect={(p) => { field.onChange(p.formatted); calculateDistance(p.formatted) }}
                    error={errors.address?.message}
                  />
                )} />

              {/* Service FIRST (owner directive) — measurement, suggested pricing,
                  intelligence, duration and profitability below are all specific to
                  the selected service. */}
              <Controller name="service_template_id" control={control}
                render={({ field }) => (<Select label="Service" options={templateOptions} {...field} />)} />
              <Input label="Service Name" placeholder="e.g. Lawn Mowing"
                hint="Auto-fills when you pick a service above — edit to rename it on the quote."
                error={errors.service_type?.message}
                {...register('service_type', { required: 'Service is required' })} />

              {/* Lawn size — a CORE property attribute (powers pricing, labour & future
                  analytics). Auto-filled from a website/satellite measurement or the
                  property's saved size; always editable, and synced back to the property
                  on save. */}
              <Input label="Lawn Size (ft²)" type="number" step="1" min="0"
                placeholder="e.g. 5,000"
                hint="Powers pricing & labour. Auto-filled from a measurement or the saved property size — edit to correct."
                {...register('measured_sqft', { min: 0 })} />

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button type="button" variant="secondary" size="sm"
                  onClick={() => {
                    // Immediate feedback where the tap happened — a message inside
                    // the collapsed Travel section is a silent failure.
                    if (!address) { toast.error('Enter a service address first.'); return }
                    setShowMeasure(true)
                  }}>
                  <Ruler className="w-3.5 h-3.5" /> Measure &amp; price from satellite
                </Button>
                {measuredSqft > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {Math.round(measuredSqft).toLocaleString()} sq ft measured
                  </span>
                )}
              </div>

              {/* ── THE recommended price ─────────────────────────────────────
                  ONE primary recommendation per service kind; everything below
                  it supports that number instead of competing with it.
                  • Lawn cadence services → Pricing Intelligence (engine anchor +
                    win-history + minimum floor) is the primary; the cadence
                    tiles below are the supporting structure it fills.
                  • Everything else (mulch, cleanups, hedges…) → one card from
                    the service-appropriate engine (area rate or labour). */}
              {pricingKind === 'lawn_recurring' && measuredSqft > 0 && (
                <PriceIntelligence
                  sqft={measuredSqft}
                  serviceType={watch('service_type')}
                  cadence={suggested?.recommended ?? 'one_time'}
                  overgrowth={overgrowth}
                  propertyId={defaultPropertyId}
                  customerId={customerId && customerId !== '__manual' ? customerId : undefined}
                  currentPrice={(suggested?.recommended ?? 'one_time') === 'one_time' ? initialPrice
                    : (suggested?.recommended === 'weekly' ? weeklyPrice
                      : suggested?.recommended === 'biweekly' ? biweeklyPrice : monthlyPrice)}
                  onApply={(price) => {
                    // Accept = fill the FULL lawn structure in one tap: the learned
                    // price takes the recommended cadence's slot, the engine fills
                    // the rest (monthly only when enabled). Everything stays editable.
                    if (!suggested) {
                      setValue('initial_price', price); setValue('suggested_price', price); setInitialManual(true)
                      return
                    }
                    const c = suggested.recommended
                    setValue('initial_price', c === 'one_time' ? price : suggested.one_time)
                    setValue('weekly_price', c === 'weekly' ? price : suggested.weekly)
                    setValue('biweekly_price', c === 'biweekly' ? price : suggested.biweekly)
                    setValue('monthly_price', includeMonthly ? (c === 'monthly' ? price : suggested.monthly) : 0)
                    setValue('suggested_price', suggested.one_time)
                    setInitialManual(false)
                    setPickedCadence(c === 'monthly' ? null : c)
                  }}
                />
              )}

              {/* One-off / area services: the single service-appropriate price. */}
              {pricingKind !== 'lawn_recurring' && serviceRec && (
                <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-3 motion-safe:animate-[fadeIn_140ms_ease-out]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recommended price</p>
                      <p className="text-xl font-bold text-ink leading-tight mt-0.5 tabular-nums">{formatCurrency(serviceRec.price)}</p>
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        {serviceRec.basis}{serviceRec.materials ? ' · plus materials' : ''}
                      </p>
                    </div>
                    {/* Same confirmation language as Pricing Intelligence — Accept
                        flips to a green "Applied" once the price is in the field. */}
                    {Math.abs((Number(initialPrice) || 0) - serviceRec.price) < 0.5
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 shrink-0 motion-safe:animate-[fadeIn_120ms_ease-out]"><CheckCircle2 className="w-3.5 h-3.5" /> Applied</span>
                      : (
                        <Button type="button" size="sm" onClick={applyServiceRec} className="shrink-0">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Accept
                        </Button>
                      )}
                  </div>
                  <p className="text-[10px] text-ink-faint mt-1.5">
                    {pricingKind === 'per_area'
                      ? 'One-time job — Accept fills the price; recurring fields stay empty.'
                      : 'Priced from labour — fine-tune hours & crew in Advanced Pricing below.'}
                    {serviceRec.materials ? ' Add materials as Additional services or into the price.' : ''}
                  </p>
                </div>
              )}

              {/* Supporting cadence structure (lawn services) — Accept above fills
                  these together; tap one to lead with a different frequency. */}
              {suggested && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Plan options — one tap fills all</p>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { c: 'weekly', label: 'Weekly', price: suggested.weekly, per: '/visit' },
                      { c: 'biweekly', label: 'Bi-Weekly', price: suggested.biweekly, per: '/visit' },
                      { c: 'one_time', label: 'One-Time', price: suggested.one_time, per: '' },
                    ] as const).map(opt => {
                      const active = pickedCadence === opt.c && !initialManual
                      return (
                        <button key={opt.c} type="button" onClick={() => applySuggested(opt.c)}
                          className={cn('rounded-xl border p-2.5 text-left transition-all', // transition-all so the selection ring eases in too
                            active ? 'border-accent bg-accent/10 ring-1 ring-accent' : 'border-border bg-surface hover:border-border-strong')}>
                          <span className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium text-ink-muted">{opt.label}</span>
                            {/* ONE recommendation on screen: when Pricing Intelligence is
                                the primary card, the tile badge would be a second,
                                differently-priced "Rec". */}
                            {!(pricingKind === 'lawn_recurring' && measuredSqft > 0) && suggested.recommended === opt.c && <span className="text-[9px] font-bold uppercase tracking-wide text-accent">Rec</span>}
                          </span>
                          <span className="block text-base font-bold text-ink mt-0.5 leading-tight tabular-nums">
                            {formatCurrency(opt.price)}<span className="text-[10px] font-normal text-ink-faint">{opt.per}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <p className="text-[10px] text-ink-faint">One tap fills One-Time + Weekly + Bi-Weekly together — every field stays editable below.</p>
                    <button type="button"
                      onClick={() => {
                        const next = !includeMonthly
                        setIncludeMonthly(next)
                        // Toggling applies immediately when suggestions already filled the fields.
                        if (suggested && !initialManual) setValue('monthly_price', next ? suggested.monthly : 0)
                      }}
                      className={cn('shrink-0 text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors',
                        includeMonthly ? 'text-accent border-accent/40 bg-accent/10' : 'text-ink-faint border-border hover:text-ink')}>
                      {includeMonthly ? 'Monthly: on' : '+ Monthly'}
                    </button>
                  </div>
                </div>
              )}

            </CardBody>
          </Card>

          {/* ── Advanced Pricing — exact price + the full engine, collapsed until needed ── */}
          <Collapsible title="Advanced Pricing" icon={SlidersHorizontal} summary="Exact price · labour · recurring · travel — full control">
          {/* Saved measurement — the pricing source of truth for this property.
              Shown ONLY when there's no LIVE suggestion (same numbers, same
              engine — never two copies of the price list on screen). */}
          {savedRec && !suggested && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
              <p className="text-[11px] font-semibold text-accent uppercase tracking-wide">
                Measured property · {savedRec.sqft.toLocaleString()} ft² · {formatCurrency(savedRec.rec[savedRec.rec.cadence === 'one_time' ? 'one_time' : savedRec.rec.cadence])}/{savedRec.rec.cadence === 'one_time' ? 'visit' : savedRec.rec.cadence} recommended
              </p>
              <p className="text-xs text-ink-muted">
                One-Time <span className="text-ink font-semibold">${savedRec.rec.one_time}</span> · Weekly <span className="text-ink font-semibold">${savedRec.rec.weekly}</span> · Bi-Weekly <span className="text-ink font-semibold">${savedRec.rec.biweekly}</span> · Monthly <span className="text-ink font-semibold">${savedRec.rec.monthly}</span>
              </p>
              <p className="text-[11px] text-ink-faint">Calculated {formatDate(savedRec.date)}</p>
              <button type="button"
                onClick={() => {
                  setValue('initial_price', savedRec.rec.one_time)
                  setValue('weekly_price', savedRec.rec.weekly)
                  setValue('biweekly_price', savedRec.rec.biweekly)
                  setValue('monthly_price', savedRec.rec.monthly)
                  setValue('measured_sqft', savedRec.sqft)
                  setValue('suggested_price', savedRec.rec.one_time)
                  setInitialManual(true)
                }}
                className="text-xs font-semibold text-accent hover:underline">
                Use measured prices →
              </button>
              {recommendationIsStale(savedRec.date, Date.now()) && (
                <p className="text-[11px] text-amber-400">⚠ Pricing recommendations may be outdated. Consider recalculating.</p>
              )}
            </div>
          )}

          {/* Price */}
          <div>
            <Input label="Price ($, first visit)" type="number" step="1" min="0"
              hint={initialManual ? 'Manual — overrides the labour suggestion.' : `Suggested ${formatCurrency(suggestedInitial)} from labour. Type to override.`}
              {...register('initial_price', { min: 0, onChange: () => setInitialManual(true) })} />
            {initialManual && (
              <button type="button" onClick={() => setInitialManual(false)}
                className="text-xs text-accent hover:underline mt-1.5">
                Use suggested ({formatCurrency(suggestedInitial)})
              </button>
            )}
          </div>

          <Collapsible title="Labour calculator" icon={Calculator} summary={laborSummary}>
            <p className="text-xs text-ink-faint">Adjusts the suggested price above. Most mowing quotes can skip this and just type a price.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Estimated Hours" type="number" step="0.25" min="0"
                error={errors.hours?.message}
                {...register('hours', { required: 'Required', min: { value: 0.25, message: 'Min 0.25' } })} />
              <Input label="Crew Size" type="number" min="1" max="20"
                error={errors.crew_size?.message}
                {...register('crew_size', { required: 'Required', min: { value: 1, message: 'Min 1' } })} />
            </div>
            {/* Smart Labor Estimate — reference only on quotes; never changes the price. */}
            <SmartLaborField
              readOnly
              sqft={measuredSqft}
              serviceType={watch('service_type')}
              crewSize={Number(crewSize) || 1}
              overgrowth={overgrowth}
              price={initialPrice || weeklyPrice || biweeklyPrice || monthlyPrice || 0}
              value={null}
              onApply={() => {}}
            />
            <Input label="Adjustment Multiplier" type="number" step="0.05" min="0"
              hint="Multiplies the rate. e.g. 0.75 (easy), 1.0 (standard), 1.25 (overgrown)."
              {...register('overgrowth_multiplier', { min: 0 })} />
            <Input label="Base Rate ($/man-hour)" type="number" step="5" min="0"
              hint="Only used to suggest the price above."
              error={errors.rate?.message}
              {...register('rate', { required: 'Required', min: { value: 0, message: 'Rate cannot be negative' } })} />
          </Collapsible>

          <Collapsible title="Plan pricing" icon={Repeat} summary={recSummary || 'One-time quote'}>
            <p className="text-xs text-ink-faint">Fill any cadence you want to offer — they appear on the quote as options the customer can pick.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Input label="Weekly ($/visit)" type="number" step="1" min="0" {...register('weekly_price', { min: 0 })} />
              <Input label="Bi-Weekly ($/visit)" type="number" step="1" min="0" {...register('biweekly_price', { min: 0 })} />
              <Input label="Monthly ($/visit)" type="number" step="1" min="0" {...register('monthly_price', { min: 0 })} />
            </div>
            <PriceGuardrailNote guardrails={priceGuardrails} />
          </Collapsible>

          <Collapsible title="Travel" icon={Car} summary={travelSummary}>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={() => calculateDistance()} loading={calcLoading}>
                <MapPin className="w-3.5 h-3.5" /> Calculate Distance
              </Button>
            </div>
            {calcMsg && <p className="text-xs text-accent">{calcMsg}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <Input label="Distance (km)" type="number" step="0.1" min="0" {...register('distance_km', { min: 0 })} />
              <Input label="Travel Fee ($)" type="number" step="5" min="0" {...register('travel_fee', { min: 0 })} />
            </div>
            {travelSuggestion && (
              <div className="text-sm">
                {travelSuggestion.isCustom ? (
                  <span className="text-amber-400">{travelSuggestion.tierLabel}: custom fee required</span>
                ) : (
                  <span className="text-ink-muted">{travelSuggestion.tierLabel}: <span className="text-accent font-semibold">{formatCurrency(travelSuggestion.fee || 0)}</span></span>
                )}
              </div>
            )}
            {customTravelRequired && (
              <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                Beyond your furthest travel tier — enter a custom travel fee above.
              </div>
            )}
            {travelSuggestion && !travelSuggestion.isCustom && (
              <Button type="button" variant="secondary" size="sm" onClick={applySuggestedTravel}>
                Apply suggested travel fee
              </Button>
            )}
            <div className="pt-1 space-y-2">
              <Toggle checked={includeTravel} onChange={toggleIncludeTravel}
                label={includeTravel ? 'Charging travel fee' : 'Absorbing travel — no fee'} />
              <Controller name="show_travel_separately" control={control}
                render={({ field }) => (
                  <Toggle checked={field.value} onChange={field.onChange}
                    label={field.value ? 'Show travel as separate line on PDF' : 'Travel rolled into total on PDF'} />
                )} />
            </div>
          </Collapsible>
          </Collapsible>
          {/* ── Additional services — a quote can hold one OR many services. Sits
              right after Advanced Pricing so the primary flow reads Address →
              Measure → Recommended price → Accept → fine-tune → extras. Each line
              has qty × unit price − discount; totals sum via the one
              quote-services engine. The primary service above stays untouched. ── */}
          <Collapsible title="Additional services" icon={Layers}
            summary={serviceLines.fields.length ? `${serviceLines.fields.length} line${serviceLines.fields.length !== 1 ? 's' : ''} · ${formatCurrency(extras.net)}` : 'One-service quote — add mulch, cleanup, hedges…'}>
            <div className="space-y-3">
              {serviceLines.fields.map((f, i) => {
                const line = watchedServices?.[i]
                const net = line ? serviceLineTotals(line).net : 0
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Service {i + 2}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(net)}</span>
                        <button type="button" onClick={() => serviceLines.remove(i)} aria-label="Remove service"
                          className="text-ink-faint hover:text-red-400 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                      <Input label="Service" placeholder="e.g. Hedge Trimming"
                        {...register(`services.${i}.service_type` as const, { required: true })} />
                      {templates.length > 0 && (
                        <Select label="From template" placeholder="Pick…"
                          options={templates.map(t => ({ value: t.id, label: t.name }))}
                          value={watch(`services.${i}.service_template_id`) || ''}
                          onChange={e => {
                            const t = templates.find(x => x.id === e.target.value)
                            setValue(`services.${i}.service_template_id`, e.target.value)
                            if (t) {
                              setValue(`services.${i}.service_type`, t.name)
                              if (Number(t.default_rate) > 0) setValue(`services.${i}.unit_price`, Number(t.default_rate))
                              const d = (t.pricing_display_type || '').toLowerCase()
                              setValue(`services.${i}.unit`, d.includes('hour') ? 'hour' : d.includes('linear') ? 'linear_ft' : d.includes('sq') ? 'sqft' : 'each')
                            }
                          }} />
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Input label="Qty" type="number" step="0.5" min="0"
                        {...register(`services.${i}.quantity` as const, { min: 0 })} />
                      <Select label="Unit" options={SERVICE_UNITS.map(u => ({ value: u.value, label: u.label }))}
                        {...register(`services.${i}.unit` as const)} />
                      <Input label="Unit price ($)" type="number" step="1" min="0"
                        {...register(`services.${i}.unit_price` as const, { min: 0 })} />
                      <Input label="Duration (min)" type="number" step="5" min="0"
                        {...register(`services.${i}.est_minutes` as const, { min: 0 })} />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-[auto_auto_1fr] gap-3 items-end">
                      <Select label="Discount" placeholder="None"
                        options={[{ value: 'amount', label: '$ off' }, { value: 'percent', label: '% off' }]}
                        {...register(`services.${i}.discount_type` as const)} />
                      <Input label="Value" type="number" step="1" min="0"
                        {...register(`services.${i}.discount_value` as const, { min: 0 })} />
                      <Input label="Notes" placeholder="Optional"
                        {...register(`services.${i}.notes` as const)} />
                    </div>
                  </div>
                )
              })}
              <Button type="button" variant="secondary" size="sm" onClick={() => serviceLines.append(emptyServiceLine())}>
                <Plus className="w-3.5 h-3.5" /> Add service
              </Button>
              {extras.net > 0 && (
                <p className="text-xs text-ink-muted">
                  Additional services total <span className="font-semibold text-ink">{formatCurrency(extras.net)}</span>
                  {extras.discountAmount > 0 && <> (after {formatCurrency(extras.discountAmount)} discounts)</>}
                  {extras.minutes > 0 && <> · ≈{extras.minutes} min</>}
                </p>
              )}
            </div>
          </Collapsible>


          <Collapsible title="Notes" icon={FileText} summary={notes ? String(notes).slice(0, 40) : 'None'}>
            <Textarea label="Notes" placeholder="Job-specific details, access instructions, gate codes..."
              {...register('notes')} />
          </Collapsible>

          <Collapsible title="Scheduling & status" icon={SlidersHorizontal}>
            <Controller name="status" control={control}
              render={({ field }) => (<Select label="Quote Status" options={statusOptions} {...field} />)} />
            <div className="pt-1">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-2 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent" /> Best days to schedule
              </p>
              {!address ? (
                <p className="text-xs text-ink-faint">Enter a service address to see the best days near your existing jobs.</p>
              ) : !showBestDays ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowBestDays(true)}>
                  <Sparkles className="w-3.5 h-3.5" /> Find best days
                </Button>
              ) : (
                <BestDaySuggestions address={address} />
              )}
            </div>
          </Collapsible>
        </div>

        <div className="hidden lg:block space-y-4">
          <Card className="sticky top-6">
            <CardHeader className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">Quote Preview</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-muted"><Clock className="w-3.5 h-3.5" /> Hours</span>
                <span className="text-ink font-medium">{Number(hours).toFixed(1)} hrs · {crewSize} crew</span>
              </div>
              <div className="border-t border-border pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-muted">First visit{initialManual ? ' (manual)' : ''}</span>
                  <span className="text-ink font-semibold">{formatCurrency(initialPrice)}</span>
                </div>
                {extras.net > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-ink-muted"><Layers className="w-3.5 h-3.5" /> Additional services ({serviceLines.fields.length})</span>
                    <span className="text-ink font-medium">{formatCurrency(extras.net)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-ink-muted"><Car className="w-3.5 h-3.5" /> Travel{showTravelSeparately ? ' (shown)' : ''}</span>
                  <span className="text-ink font-medium">{formatCurrency(Number(travelFee))}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-sm font-semibold text-ink">First visit total</span>
                  <span className="text-2xl font-bold text-accent">{formatCurrency(effectiveTotal)}</span>
                </div>
              </div>
              {(weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0) && (
                <div className="border-t border-border pt-3 space-y-1.5">
                  <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Plan options</p>
                  {weeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium">{formatCurrency(weeklyPrice)}/visit</span></div>}
                  {biweeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium">{formatCurrency(biweeklyPrice)}/visit</span></div>}
                  {monthlyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium">{formatCurrency(monthlyPrice)}/visit</span></div>}
                </div>
              )}
              <div className="pt-2 space-y-2">
                <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                  {isEdit ? 'Update Quote' : 'Save Quote'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>Cancel</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Mobile sticky save bar — always reachable without scrolling */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 px-4 py-2.5 bg-bg-secondary/95 backdrop-blur border-t border-border flex items-center justify-between gap-3">
        <div className="leading-tight min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint">First visit total</p>
          <p className="text-xl font-bold text-accent leading-none">{formatCurrency(effectiveTotal)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" size="lg" loading={isSubmitting}>{isEdit ? 'Update' : 'Save Quote'}</Button>
        </div>
      </div>

      {showMeasure && (
        <QuoteMeasure
          address={address}
          travelFee={Number(travelFee) || 0}
          cfg={pricingConfigFromSettings(settings)}
          serviceType={watch('service_type')}
          propertyId={defaultPropertyId}
          customerId={customerId && customerId !== '__manual' ? customerId : undefined}
          services={templates.map(t => t.name).filter((n): n is string => !!n)}
          onServiceChange={(n) => setValue('service_type', n)}
          onClose={() => setShowMeasure(false)}
          onApply={(sel) => {
            // Fill the WHOLE pricing structure in one apply — first visit at the
            // one-time price plus every recurring option, so the customer sees all
            // choices with zero re-typing. Monthly stays blank unless enabled (or
            // the measure flow explicitly recommended monthly).
            setValue('initial_price', sel.oneTime)
            setValue('weekly_price', sel.weekly)
            setValue('biweekly_price', sel.biweekly)
            if (includeMonthly || sel.cadence === 'monthly') {
              setValue('monthly_price', sel.monthly)
              if (sel.cadence === 'monthly') setIncludeMonthly(true)
            }
            setValue('measured_sqft', sel.totalSqft)
            setValue('suggested_price', sel.suggested)
            setInitialManual(true); setShowMeasure(false)
          }}
        />
      )}
    </form>
  )
}