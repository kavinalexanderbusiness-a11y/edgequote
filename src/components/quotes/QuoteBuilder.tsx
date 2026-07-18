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
import { StickyActionBar } from '@/components/ui/StickyActionBar'
import { Banner } from '@/components/ui/Banner'
import { Collapsible } from '@/components/ui/Collapsible'
import { Modal } from '@/components/ui/Modal'
import { AssistButton, AiStop, AiUndo, AiError, AiNote, AI_CHECK_FIRST } from '@/components/ai/ui'
import { useAiAssist } from '@/hooks/useAiAssist'
import { QuoteFormValues, Customer, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { sumServiceLines, serviceLineTotals, emptyServiceLine } from '@/lib/quoteServices'
import { MATERIAL_SUGGESTIONS, emptyMaterialLine } from '@/lib/quoteMaterials'
import { loadServiceUnits, SYSTEM_UNITS, type ServiceUnit } from '@/lib/units'
import { formatCurrency, formatDate, suggestTravelFee, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { formatServicePrice, servicePricingKind, serviceRecommendation } from '@/lib/servicePricing'
import { laborSuggestion, pricingConfigFromSettings, latestSavedRecommendation, recommendationIsStale, pricingPackage } from '@/lib/pricing'
import { evaluatePrice, PriceGuardrail } from '@/lib/priceGuardrails'
import { PriceGuardrailNote } from '@/components/pricing/PriceGuardrailNote'
import { findCustomerMatch } from '@/lib/customers'
import { createClient } from '@/lib/supabase/client'
import type { MeasurementSnapshot, SavedRecommendation } from '@/types'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { SmartLaborField } from '@/components/labor/SmartLaborField'
import { PriceIntelligence } from '@/components/pricing/PriceIntelligence'
import { Clock, DollarSign, Car, Calculator, AlertTriangle, MapPin, Repeat, Ruler, Sparkles, FileText, SlidersHorizontal, CheckCircle2, Users, Layers, Plus, Trash2, ChevronUp, Package } from 'lucide-react'

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

// Where the price in the field came from. NEVER inferred by comparing the field to
// a recommendation — two numbers being equal is not consent, and that inference is
// exactly what made a fabricated price render as "✓ Applied" on a form nobody had
// touched. Only a real user action moves this to 'applied' or 'manual'.
//   empty     → we have no honest basis for a price. The field stays blank.
//   suggested → an engine's recommendation is sitting in the field, unconfirmed.
//   applied   → the owner tapped Accept / a plan tile / Use measured prices.
//   manual    → the owner typed their own number (or we loaded a saved quote).
type PriceOrigin = 'empty' | 'suggested' | 'applied' | 'manual'

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
        // Hours has NO default. It used to be 2 — a number nobody entered, about a
        // job nobody had described yet, which multiplied out into a fabricated
        // price the form then badged as confirmed. Unknown hours is not 2 hours.
        // It fills from the learned estimator below (SmartLaborField) the moment
        // that engine has real history for this service, and stays empty when it
        // doesn't. Empty hours ⇒ no labour recommendation ⇒ no price. That is the
        // correct behaviour, not a gap.
        hours: 0,
        // 1 is the structural floor, not a guess: crew_size has min=1, you cannot
        // send zero people, and with hours empty it multiplies into nothing anyway.
        // (business_settings.default_crew_size exists in the DB but is not in the
        // TS type and has no Settings UI — plumbing it through would change no
        // outcome today. Noted in the audit rather than half-built here.)
        crew_size: 1,
        // The owner's OWN configured rate. Settings has had a "Default Labour Rate
        // ($/man-hour)" field all along (settings/page.tsx) and this form ignored
        // it, hardcoding 50 — so a business that set its rate to $95 still got
        // quotes suggested from $50. Both pages gate rendering on `loading`, so
        // settings is always resolved before this form mounts. No settings ⇒ 0 ⇒
        // no labour recommendation, which is honest rather than invented.
        rate: Number(settings?.default_rate) || 0,
        travel_fee: 0,
        notes: '',
        status: 'draft',
        services: [],
        ...defaultValues,
      },
    })

  // Additional lines beyond the primary one. ONE field array holds both services
  // and materials — they are the same species of line (qty × unit_price through
  // the one quote-services engine) and a second array would mean a second sum.
  // The two sections below are a VIEW over it, split by `kind`; the real index is
  // carried through so register() still addresses the right row.
  const serviceLines = useFieldArray({ control, name: 'services' })
  const indexedLines = serviceLines.fields.map((f, i) => ({ f, i }))
  const kindAt = (i: number) => watchedServices?.[i]?.kind ?? 'service'
  const serviceIdx = indexedLines.filter(({ i }) => kindAt(i) !== 'material')
  const materialIdx = indexedLines.filter(({ i }) => kindAt(i) === 'material')
  // Per-section subtotals are DISPLAY ONLY — `extras` remains the ONE figure that
  // feeds the quote total, and it already sums every line regardless of kind.
  // Both go through sumServiceLines rather than a hand-rolled reduce: a second
  // adder here is how two totals start disagreeing.
  const linesAt = (idx: { i: number }[]) =>
    idx.map(({ i }) => watchedServices?.[i]).filter(Boolean) as NonNullable<typeof watchedServices>
  const serviceExtras = sumServiceLines(linesAt(serviceIdx))
  const materialsSum = sumServiceLines(linesAt(materialIdx))
  const serviceExtrasNet = serviceExtras.net

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
  const [calcMsg, setCalcMsg] = useState<{ text: string; error?: boolean } | null>(null)
  const [showMeasure, setShowMeasure] = useState(false)
  // Mobile-only: the desktop preview card is lg-only, so the phone needs a way in.
  const [showPreview, setShowPreview] = useState(false)
  const [includeTravel, setIncludeTravel] = useState(true)
  // Loading a saved quote → that price is the owner's own past decision, so it is
  // never live-overwritten by a suggestion (same behaviour the old boolean had).
  const [priceOrigin, setPriceOrigin] = useState<PriceOrigin>(
    (defaultValues?.initial_price ?? 0) > 0 ? 'manual' : 'empty',
  )
  // The suggestion engine stops writing to the field once the owner owns the
  // number — by accepting one or by typing one. Both used to be the single
  // `initialManual` boolean, which is why an Accept and a hand-typed override were
  // indistinguishable in the header badge.
  const priceLocked = priceOrigin === 'applied' || priceOrigin === 'manual'
  const [showBestDays, setShowBestDays] = useState(false)
  // Saved recommendation from the customer's latest property measurement — the
  // source of truth for suggested prices (no re-measuring needed).
  const [savedRec, setSavedRec] = useState<{ rec: SavedRecommendation; sqft: number; date: string } | null>(null)
  // Which suggested price the owner tapped — drives the compact "Suggested Pricing"
  // highlight. Cleared the moment a price is edited (manual override).
  const [pickedCadence, setPickedCadence] = useState<'one_time' | 'weekly' | 'biweekly' | null>(null)

  const hours = watch('hours') || 0
  const crewSize = watch('crew_size') || 1
  // No `|| DEFAULT_RATE` backstop: a missing rate must stay 0 so the labour
  // recommendation goes silent, rather than quietly reappearing at $50/hr.
  const rate = watch('rate') || 0
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
  // AI scope writer for the Notes field — words only; pricing never comes from it.
  const aiScope = useAiAssist()
  // What the field held before the assistant replaced it — powers Undo, and
  // doubles as "this text came from the assistant" for the explanation note.
  const [aiScopePrior, setAiScopePrior] = useState<string | null>(null)
  const measuredSqft = Number(watch('measured_sqft')) || 0

  // Smart Price Guardrails — per-cadence, never-block warnings (measured lawn +
  // crew cost). Each filled cadence is judged against ITS own recommended price.
  const priceGuardrails = useMemo<PriceGuardrail[]>(() => {
    const cfg = pricingConfigFromSettings(settings)
    const crewCost = settings?.crew_cost_per_hour && settings.crew_cost_per_hour > 0 ? settings.crew_cost_per_hour : 40
    const out: PriceGuardrail[] = []
    const add = (cadence: 'one_time' | 'weekly' | 'biweekly' | 'monthly', price: number) => {
      // PR-1: pass the real overgrowth so an overgrown job is judged against ITS
      // own (higher) recommended price, not a normal-condition one. valueGrade is
      // null because the builder prices neutrally — the grade curve is applied in
      // the measure tool, not here. Both are now REQUIRED by evaluatePrice.
      if (price > 0) out.push(evaluatePrice({ cadence, price, sqft: measuredSqft, cfg, crewCost, valueGrade: null, overgrowth }))
    }
    add('one_time', initialPrice); add('weekly', weeklyPrice); add('biweekly', biweeklyPrice); add('monthly', monthlyPrice)
    return out
  }, [settings, measuredSqft, initialPrice, weeklyPrice, biweeklyPrice, monthlyPrice, overgrowth])

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

  // The service's own recommendation, from the ONE seam in lib/servicePricing.
  // It returns null when we have no honest basis — and null is load-bearing: the
  // old code fell back to `hours × crew × rate` using defaults nobody entered, so
  // there was ALWAYS a number, and the card always rendered. Now silence is a
  // possible answer, and the UI says so (see the "no recommendation" card below).
  const serviceRec = useMemo(() => serviceRecommendation({
    kind: pricingKind,
    template: svcTemplate ? { ...svcTemplate, name: svcTemplate.name } : null,
    measuredSqft,
    // The labour figure exists ONLY when hours AND rate are real. laborSuggestion
    // is still the one labour engine — we just refuse to feed it invented inputs.
    labour: hours > 0 && rate > 0
      ? { price: suggestedInitial, hours: Number(hours), crewSize: Number(crewSize), rate: Number(rate) }
      : null,
  }), [pricingKind, svcTemplate, measuredSqft, hours, rate, crewSize, suggestedInitial])

  // Why we can't recommend anything — shown verbatim to the owner instead of a
  // number. Ordered by what they'd do next.
  const noRecReason = useMemo(() => {
    if (!watch('service_type')?.trim()) return 'Pick a service and we’ll recommend a price.'
    if (pricingKind === 'lawn_recurring') return 'Measure the property to see recommended pricing for this service.'
    if (rate <= 0) return 'No recommendation yet — set your Default Labour Rate in Settings, or type a price.'
    return 'No recommendation yet — add hours in the Labour calculator, or type a price. EdgeQuote won’t guess.'
  }, [watch, pricingKind, rate])

  // Accept for one-off services: fill the one price that makes sense and CLEAR
  // the lawn cadence fields (weekly mulch makes no sense on a quote).
  function applyServiceRec() {
    if (!serviceRec) return
    setValue('initial_price', serviceRec.price)
    setValue('weekly_price', 0)
    setValue('biweekly_price', 0)
    setValue('monthly_price', 0)
    setValue('suggested_price', serviceRec.price)
    setPriceOrigin('applied')   // a real tap — this is the ONLY road to "Applied"
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
    setPriceOrigin('applied')   // tapping a plan tile IS an accept
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

  // The recommendation stays live in the price field until the owner owns the
  // number. What changed: it can now be ABSENT. This effect used to run on mount
  // with `suggestedInitial` = 2 × 1 × $50 and write $100 into a form with no
  // customer, no address and no service — which then rendered as "✓ Applied".
  // Now serviceRec is null unless something real backs it, and a field that was
  // only ever holding a suggestion is cleared again when that basis disappears
  // (e.g. the owner clears the hours) rather than stranding a stale number.
  useEffect(() => {
    if (priceLocked || pickedCadence) return
    const price = serviceRec?.price ?? 0
    if (price > 0) {
      setValue('initial_price', price)
      setPriceOrigin('suggested')
    } else if (priceOrigin === 'suggested') {
      setValue('initial_price', 0)
      setPriceOrigin('empty')
    }
  }, [serviceRec, priceLocked, priceOrigin, pickedCadence, setValue])

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
    if (!base) { setCalcMsg({ text: 'Set your base address in Settings first.', error: true }); return }
    if (!dest) { setCalcMsg({ text: 'Enter a service address first.', error: true }); return }
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
        setCalcMsg({ text: `${data.km} km${data.durationText ? ` · ${data.durationText} drive` : ''}` })
      } else {
        setCalcMsg({ text: data.error || 'Could not calculate distance.', error: true })
      }
    } catch {
      setCalcMsg({ text: 'Distance lookup failed.', error: true })
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
  // The unit vocabulary (service_units): the nine system units plus this owner's
  // custom ones. It replaces a hardcoded four-value list, which is the whole
  // reason a plumber can now quote 6 fixtures and a painter 3 rooms — the line
  // maths was always qty × unit_price and never needed to change.
  //
  // Seeded with the system nine so the picker is never empty and never SHRINKS on
  // a failed read — loadServiceUnits() falls back to the same nine, so the only
  // thing a failure costs is this owner's custom units. It used to fall back to a
  // four-value constant, which silently dropped fixture/room/zone/equipment/flat.
  const [units, setUnits] = useState<ServiceUnit[]>(SYSTEM_UNITS)
  useEffect(() => {
    let alive = true
    loadServiceUnits(createClient()).then(u => { if (alive) setUnits(u) })
    return () => { alive = false }
  }, [])
  const unitOptions = useMemo(() => units.map(u => ({ value: u.code, label: u.label })), [units])

  // Favourites first, then the business's own sort_order within each group.
  // THIS is what a favourite is for: the settings toggle promises "shown first in
  // the quote builder", and this is the only place that promise can be kept — the
  // picker is the sole reader of display order. Marking a favourite does nothing
  // without this line. Stable within groups (the queries already order by
  // sort_order), so a business with no favourites sees the exact order it saw
  // before — the sort is a no-op until someone opts in.
  const activeTemplates = useMemo(
    () => templates.filter(t => t.is_active)
      .slice()   // never sort the shared store's array in place
      .sort((a, b) => Number(!!b.is_favorite) - Number(!!a.is_favorite)),
    [templates],
  )
  const templateOptions = useMemo(() => [
    { value: '', label: 'Select a service...' },
    ...activeTemplates.map(t => ({
      // A native <select> can't render an icon, so the star carries the grouping.
      value: t.id,
      label: `${t.is_favorite ? '★ ' : ''}${t.name} — ${formatServicePrice(t)}`,
    })),
  ], [activeTemplates])
  const statusOptions = [
    { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' },
    { value: 'accepted', label: 'Accepted' }, { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' },
    { value: 'declined', label: 'Declined' },
  ]
  const showManualName = !customerId || customerId === '__manual'

  // ── The price breakdown, defined ONCE ────────────────────────────────────────
  // Rendered by the desktop preview card AND the mobile sheet below. It used to
  // live only inside `hidden lg:block`, so a contractor quoting from a phone in
  // someone's driveway saw a single number — no hours, no travel, no discount,
  // and no Weekly/Bi-Weekly/Monthly prices, which for a mowing business ARE the
  // product. "What's it per cut if I go weekly?" was unanswerable without a
  // laptop. Same JSX both places: one breakdown, no second copy to drift.
  const previewBreakdown = (
    <>
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-ink-muted"><Clock className="w-3.5 h-3.5" /> Hours</span>
        <span className="text-ink font-medium tabular-nums">{Number(hours).toFixed(1)} hrs · {crewSize} crew</span>
      </div>
      <div className="border-t border-border pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">First visit{priceOrigin === 'manual' ? ' (manual)' : ''}</span>
          <span className="text-ink font-semibold tabular-nums">{formatCurrency(initialPrice)}</span>
        </div>
        {extras.net > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-ink-muted"><Layers className="w-3.5 h-3.5" /> Additional services ({serviceLines.fields.length})</span>
            <span className="text-ink font-medium tabular-nums">{formatCurrency(extras.net)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-ink-muted"><Car className="w-3.5 h-3.5" /> Travel{showTravelSeparately ? ' (shown)' : ''}</span>
          <span className="text-ink font-medium tabular-nums">{formatCurrency(Number(travelFee))}</span>
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <span className="text-sm font-semibold text-ink">First visit total</span>
          <span className="text-2xl font-bold text-accent-text tabular-nums">{formatCurrency(effectiveTotal)}</span>
        </div>
      </div>
      {(weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0) && (
        <div className="border-t border-border pt-3 space-y-1.5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Plan options</p>
          {weeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(weeklyPrice)}/visit</span></div>}
          {biweeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(biweeklyPrice)}/visit</span></div>}
          {monthlyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(monthlyPrice)}/visit</span></div>}
        </div>
      )}
    </>
  )

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
                {/* Three states, three words. This badge used to read "Manual price"
                    for BOTH a hand-typed number and an accepted recommendation —
                    the single boolean behind it couldn't tell them apart, which
                    undersold every price the engines got right. */}
                {priceOrigin === 'suggested' && (
                  <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border-strong rounded px-1.5 py-0.5">Suggested</span>
                )}
                {priceOrigin === 'applied' && (
                  <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Applied</span>
                )}
                {priceOrigin === 'manual' && (
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
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent-text" /> New person — we&apos;ll save them as a customer &amp; property automatically when you save.
                  </p>
                  <Input label="Customer Name *" placeholder="Jane Smith"
                    error={errors.customer_name?.message}
                    {...register('customer_name', { required: 'Customer name is required' })} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input label="Phone" type="tel" placeholder="(403) 555-0100"
                      hint="Used to avoid duplicates" {...register('customer_phone')} />
                    <Input label="Email" type="email" placeholder="jane@example.com"
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
                        <Button type="button" variant="secondary" size="sm" onClick={() => setValue('customer_id', likelyMatch.customer.id)}>
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
                    label="Service Address *"
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
              {/* The example comes from THEIR catalogue, not ours. A lawn company
                  with a "Lawn Mowing" template still reads "e.g. Lawn Mowing"; a
                  pool company reads "e.g. Pool Opening". Falls back to a neutral
                  hint before any template exists. */}
              <Input label="Service Name *" placeholder={`e.g. ${activeTemplates[0]?.name || 'Weekly Service'}`}
                hint="Auto-fills when you pick a service above — edit to rename it on the quote."
                error={errors.service_type?.message}
                {...register('service_type', { required: 'Service is required' })} />

              {/* A measured AREA — a core property attribute (powers pricing, labour
                  & future analytics). Auto-filled from a website/satellite measurement
                  or the property's saved size; always editable, and synced back to the
                  property on save.
                  The label said "Lawn Size (ft²)" for every trade, so a plumber pricing
                  a drain clean was asked for a lawn. Same de-lawning rule already
                  applied in Settings and the customer Portal: the stored column stays
                  `measured_sqft` / `lawn_sqft` (read in ~74 places — renaming it is a
                  migration, not a label fix), only the words change. The hint states
                  what the area actually does for THIS service, which for a labour job
                  is: nothing to the price, but it still feeds the labour estimate. */}
              <Input label="Measured Area (ft²)" type="number" step="1" min="0"
                placeholder="e.g. 5,000"
                hint={pricingKind === 'lawn_recurring'
                  ? 'Powers pricing & labour. Auto-filled from a measurement or the saved property size — edit to correct.'
                  : pricingKind === 'per_area'
                    ? 'Multiplied by your per-unit rate to price this service. Auto-filled from a measurement or the saved property size.'
                    : 'Optional for this service — it feeds the labour estimate, not the price. Auto-filled from a measurement or the saved property size.'}
                {...register('measured_sqft', { min: 0 })} />

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button type="button" variant="secondary" size="sm"
                  onClick={() => {
                    // Immediate feedback where the tap happened — a message inside
                    // the collapsed Travel section is a silent failure.
                    if (!address) { toast.error('Enter a service address first.'); return }
                    setShowMeasure(true)
                  }}>
                  {/* Only the lawn cadence engine prices FROM the satellite trace, so
                      only it may promise a price on the button that opens the map. */}
                  <Ruler className="w-3.5 h-3.5" /> {pricingKind === 'lawn_recurring' ? 'Measure & price from satellite' : 'Measure from satellite'}
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
                      setValue('initial_price', price); setValue('suggested_price', price); setPriceOrigin('applied')
                      return
                    }
                    const c = suggested.recommended
                    setValue('initial_price', c === 'one_time' ? price : suggested.one_time)
                    setValue('weekly_price', c === 'weekly' ? price : suggested.weekly)
                    setValue('biweekly_price', c === 'biweekly' ? price : suggested.biweekly)
                    setValue('monthly_price', includeMonthly ? (c === 'monthly' ? price : suggested.monthly) : 0)
                    setValue('suggested_price', suggested.one_time)
                    setPriceOrigin('applied')
                    setPickedCadence(c === 'monthly' ? null : c)
                  }}
                />
              )}

              {/* One-off / area services: the single service-appropriate price. */}
              {pricingKind !== 'lawn_recurring' && serviceRec && (
                <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-3 animate-fade">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recommended price</p>
                      <p className="text-xl font-bold text-ink leading-tight mt-0.5 tabular-nums">{formatCurrency(serviceRec.price)}</p>
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        {serviceRec.basis}{serviceRec.materials ? ' · plus materials' : ''}
                      </p>
                    </div>
                    {/* "Applied" means the owner accepted it — nothing else. This
                        used to be `|initialPrice − serviceRec.price| < 0.5`, which
                        is true by construction the instant the form loads (the
                        field is filled FROM this number), so a price nobody had
                        looked at rendered as confirmed. Equal values are not
                        consent; only priceOrigin === 'applied' is. */}
                    {priceOrigin === 'applied'
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 shrink-0 animate-fade"><CheckCircle2 className="w-3.5 h-3.5" /> Applied</span>
                      : (
                        <Button type="button" size="sm" onClick={applyServiceRec} className="shrink-0">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Accept
                        </Button>
                      )}
                  </div>
                  <p className="text-[10px] text-ink-faint mt-1.5">
                    {serviceRec.source === 'area_rate'
                      ? 'One-time job — Accept fills the price; recurring fields stay empty.'
                      : serviceRec.source === 'catalog_price'
                        ? 'Your own starting price for this service — add hours in the Labour calculator to price the actual job.'
                        : 'Priced from labour — fine-tune hours & crew in Advanced Pricing below.'}
                    {serviceRec.materials ? ' Add materials as Additional services or into the price.' : ''}
                  </p>
                </div>
              )}

              {/* ── Nothing honest to recommend ──────────────────────────────────
                  The state the builder never had. Every path used to end in a
                  number, because the labour fallback ran on invented defaults —
                  so "we don't know yet" was unsayable, and the closest thing to it
                  was a confident $100. Saying it plainly is the whole point: an
                  owner can trust the numbers that ARE shown only if the product is
                  willing to show none. */}
              {!(pricingKind === 'lawn_recurring' && measuredSqft > 0) && !serviceRec && (
                <div className="rounded-xl border border-border bg-bg-tertiary p-3 animate-fade">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">No recommended price</p>
                  <p className="text-xs text-ink-muted mt-1">{noRecReason}</p>
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
                      const active = pickedCadence === opt.c && priceOrigin === 'applied'
                      return (
                        <button key={opt.c} type="button" onClick={() => applySuggested(opt.c)}
                          className={cn('rounded-xl border p-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', // transition-all so the selection ring eases in too
                            active ? 'border-accent bg-accent/10 ring-1 ring-accent' : 'border-border bg-surface hover:border-border-strong')}>
                          <span className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium text-ink-muted">{opt.label}</span>
                            {/* ONE recommendation on screen: when Pricing Intelligence is
                                the primary card, the tile badge would be a second,
                                differently-priced "Rec". */}
                            {!(pricingKind === 'lawn_recurring' && measuredSqft > 0) && suggested.recommended === opt.c && <span className="text-[10px] font-bold uppercase tracking-wide text-accent-text">Rec</span>}
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
                      aria-pressed={includeMonthly}
                      onClick={() => {
                        const next = !includeMonthly
                        setIncludeMonthly(next)
                        // Toggling applies immediately when suggestions already filled the fields.
                        if (suggested && priceOrigin !== 'manual') setValue('monthly_price', next ? suggested.monthly : 0)
                      }}
                      className={cn('shrink-0 text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        includeMonthly ? 'text-accent-text border-accent/40 bg-accent/10' : 'text-ink-faint border-border hover:text-ink')}>
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
              engine — never two copies of the price list on screen).
              …and ONLY for a lawn-cadence service. A SavedRecommendation is built by
              buildSavedRecommendation(pricingPackage(...)) — it is a grass cadence
              price list and carries no record of the service it was computed for. So
              a customer whose lawn was measured last spring would, on a "Furnace
              Repair" quote, be shown "Measured property · 5,000 ft² · $73/visit
              recommended · Weekly $55…" plus a one-tap "Use measured prices" that
              filled MOWING cadence prices into a furnace quote. P0 stopped WRITING
              lawn recs onto non-lawn measurements; this is the read side of the same
              bug, and every property measured before that fix still carries one. */}
          {savedRec && !suggested && pricingKind === 'lawn_recurring' && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
              <p className="text-[11px] font-semibold text-accent-text uppercase tracking-wide">
                Measured property · {savedRec.sqft.toLocaleString()} ft² · {formatCurrency(savedRec.rec[savedRec.rec.cadence === 'one_time' ? 'one_time' : savedRec.rec.cadence])}/{savedRec.rec.cadence === 'one_time' ? 'visit' : savedRec.rec.cadence} recommended
              </p>
              <p className="text-xs text-ink-muted">
                One-Time <span className="text-ink font-semibold">${savedRec.rec.one_time}</span> · Weekly <span className="text-ink font-semibold">${savedRec.rec.weekly}</span> · Bi-Weekly <span className="text-ink font-semibold">${savedRec.rec.biweekly}</span> · Monthly <span className="text-ink font-semibold">${savedRec.rec.monthly}</span>
              </p>
              <p className="text-[11px] text-ink-faint">Calculated {formatDate(savedRec.date)}</p>
              <Button type="button" variant="secondary" size="sm"
                onClick={() => {
                  setValue('initial_price', savedRec.rec.one_time)
                  setValue('weekly_price', savedRec.rec.weekly)
                  setValue('biweekly_price', savedRec.rec.biweekly)
                  setValue('monthly_price', savedRec.rec.monthly)
                  setValue('measured_sqft', savedRec.sqft)
                  setValue('suggested_price', savedRec.rec.one_time)
                  setPriceOrigin('applied')   // an explicit tap on a real recommendation
                }}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Use measured prices
              </Button>
              {recommendationIsStale(savedRec.date, Date.now()) && (
                <p className="text-[11px] text-amber-400">⚠ Pricing recommendations may be outdated. Consider recalculating.</p>
              )}
            </div>
          )}

          {/* Price — the hint states where the number came from, and admits when
              there is no recommendation to fall back to. */}
          <div>
            <Input label="Price ($, first visit)" type="number" step="1" min="0"
              hint={
                priceOrigin === 'manual'
                  ? (serviceRec ? `Manual — overrides the ${formatCurrency(serviceRec.price)} recommendation.` : 'Manual — no recommendation available for this service.')
                  : priceOrigin === 'applied'
                    ? 'Applied from the recommendation. Type to override.'
                    : serviceRec
                      ? `Suggested ${formatCurrency(serviceRec.price)} — ${serviceRec.basis}. Type to override.`
                      : 'No recommendation for this service yet — enter your price.'
              }
              {...register('initial_price', { min: 0, onChange: () => { setPriceOrigin('manual'); setPickedCadence(null) } })} />
            {/* Only offer "use the recommendation" when one actually exists. */}
            {priceOrigin === 'manual' && serviceRec && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPriceOrigin('empty')} className="mt-1.5">
                Use suggested ({formatCurrency(serviceRec.price)})
              </Button>
            )}
          </div>

          <Collapsible title="Labour calculator" icon={Calculator} summary={laborSummary}>
            <p className="text-xs text-ink-faint">Hours × crew × rate — this is what the suggested price above is built from when there’s no measurement to price against.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* NOT required, and no minimum. Unknown hours must be expressible —
                  it is the honest state of a job nobody has estimated yet, and
                  `required` here would have forced the fabricated 2 back in through
                  validation the moment the default was removed. */}
              <Input label="Estimated Hours" type="number" step="0.25" min="0"
                hint="Blank until you or the estimate below fill it — no price is suggested from labour without it."
                error={errors.hours?.message}
                {...register('hours', { min: { value: 0, message: 'Cannot be negative' } })} />
              <Input label="Crew Size" type="number" min="1" max="20"
                error={errors.crew_size?.message}
                {...register('crew_size', { required: 'Required', min: { value: 1, message: 'Min 1' } })} />
            </div>
            {/* THE learned estimator — the same engine, model and DB-trigger-fed
                history that fills the duration when you SCHEDULE a job (JobForm).
                It was mounted here readOnly with an `onApply` no-op and captioned
                "Reference only", so the trained estimate sat one line above a field
                hardcoded to 2. It auto-fills only when est.enoughData is true —
                i.e. when this service has real history — and says "not enough data"
                otherwise. That refusal to guess is why it can be trusted with the
                price: it fills the HOURS, the hours drive the suggestion, and the
                suggestion still needs an Accept. */}
            <SmartLaborField
              affectsPrice
              sqft={measuredSqft}
              serviceType={watch('service_type')}
              crewSize={Number(crewSize) || 1}
              propertyId={defaultPropertyId}
              overgrowth={overgrowth}
              price={initialPrice || weeklyPrice || biweeklyPrice || monthlyPrice || 0}
              value={hours > 0 ? Math.round(Number(hours) * 60) : null}
              onApply={(minutes) => setValue('hours', Math.round((minutes / 60) * 100) / 100)}
            />
            <Input label="Adjustment Multiplier" type="number" step="0.05" min="0"
              hint="Multiplies the rate. e.g. 0.75 (easy), 1.0 (standard), 1.25 (overgrown)."
              {...register('overgrowth_multiplier', { min: 0 })} />
            <Input label="Base Rate ($/man-hour)" type="number" step="5" min="0"
              hint={Number(settings?.default_rate) > 0
                ? `Your Default Labour Rate from Settings (${formatCurrency(Number(settings?.default_rate))}/hr). Change it here for this quote only.`
                : 'Set a Default Labour Rate in Settings so quotes can suggest a labour price.'}
              error={errors.rate?.message}
              {...register('rate', { min: { value: 0, message: 'Rate cannot be negative' } })} />
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
                <MapPin className="w-3.5 h-3.5" /> Calculate distance
              </Button>
            </div>
            {calcMsg && <p className={cn('text-xs', calcMsg.error ? 'text-red-400' : 'text-accent-text')}>{calcMsg.text}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <Input label="Distance (km)" type="number" step="0.1" min="0" {...register('distance_km', { min: 0 })} />
              <Input label="Travel Fee ($)" type="number" step="5" min="0" {...register('travel_fee', { min: 0 })} />
            </div>
            {travelSuggestion && (
              <div className="text-sm">
                {travelSuggestion.isCustom ? (
                  <span className="text-amber-400">{travelSuggestion.tierLabel}: custom fee required</span>
                ) : (
                  <span className="text-ink-muted">{travelSuggestion.tierLabel}: <span className="text-accent-text font-semibold">{formatCurrency(travelSuggestion.fee || 0)}</span></span>
                )}
              </div>
            )}
            {customTravelRequired && (
              <Banner tone="warn" icon={AlertTriangle} className="text-xs">
                Beyond your furthest travel tier — enter a custom travel fee above.
              </Banner>
            )}
            {travelSuggestion && !travelSuggestion.isCustom && (
              <Button type="button" variant="secondary" size="sm" onClick={applySuggestedTravel}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Apply suggested travel fee
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
            summary={serviceIdx.length ? `${serviceIdx.length} line${serviceIdx.length !== 1 ? 's' : ''} · ${formatCurrency(serviceExtrasNet)}` : 'One-service quote — add cleanup, hedges…'}>
            <div className="space-y-3">
              {serviceIdx.map(({ f, i }, n) => {
                const line = watchedServices?.[i]
                const net = line ? serviceLineTotals(line).net : 0
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
                    {/* kind is form state, not a visible field — register it so it
                        survives submit rather than being dropped as unregistered. */}
                    <input type="hidden" {...register(`services.${i}.kind` as const)} />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Service {n + 2}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(net)}</span>
                        <button type="button" onClick={() => serviceLines.remove(i)} aria-label="Remove service"
                          className="text-ink-faint hover:text-red-400 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                      <Input label="Service *" placeholder="e.g. Hedge Trimming"
                        error={errors.services?.[i]?.service_type ? 'Service is required' : undefined}
                        {...register(`services.${i}.service_type` as const, { required: true })} />
                      {templates.length > 0 && (
                        <Select label="From template" placeholder="Select a template…"
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
                      <Select label="Unit" options={unitOptions}
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
              {materialIdx.length > 0 && (
                <p className="text-xs text-ink-faint">
                  Materials are listed separately below.
                </p>
              )}
              {/* Service-only figures: `extras` sums materials too, so using it
                  here would file mulch under "Additional services total". */}
              {serviceExtras.net > 0 && (
                <p className="text-xs text-ink-muted">
                  Additional services total <span className="font-semibold text-ink">{formatCurrency(serviceExtras.net)}</span>
                  {serviceExtras.discountAmount > 0 && <> (after {formatCurrency(serviceExtras.discountAmount)} discounts)</>}
                  {serviceExtras.minutes > 0 && <> · ≈{serviceExtras.minutes} min</>}
                </p>
              )}
            </div>
          </Collapsible>

          {/* ── Materials — goods you SUPPLY, priced like any other line.
              This section knows what you CHARGE and deliberately nothing about
              what you PAY: no cost, no margin, no stock, no reservation. What a
              material costs the business is the one canonical cost model's
              question (Pricing V2 Phase 1 / Inventory D1), and a cost field here
              would pre-empt it. Lines live in the SAME array as services and sum
              through the SAME engine — this is a view, not a second system. ── */}
          <Collapsible title="Materials" icon={Package}
            summary={materialIdx.length
              ? `${materialIdx.length} material${materialIdx.length !== 1 ? 's' : ''} · ${formatCurrency(materialsSum.net)}`
              : 'Mulch, gravel, sod, plants…'}>
            <div className="space-y-3">
              {materialIdx.map(({ f, i }, n) => {
                const line = watchedServices?.[i]
                const net = line ? serviceLineTotals(line).net : 0
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
                    <input type="hidden" {...register(`services.${i}.kind` as const)} />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Material {n + 1}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(net)}</span>
                        <button type="button" onClick={() => serviceLines.remove(i)} aria-label="Remove material"
                          className="text-ink-faint hover:text-red-400 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <Input label="Material *" placeholder="e.g. Mulch" list="eq-material-suggestions"
                      error={errors.services?.[i]?.service_type ? 'Material is required' : undefined}
                      hint="Pick a suggestion or type your own."
                      {...register(`services.${i}.service_type` as const, { required: true })} />
                    {/* Suggestions prefill the unit too — the point is that mulch
                        arrives already measured in cubic yards, not 'each'. */}
                    <div className="flex flex-wrap gap-1.5">
                      {MATERIAL_SUGGESTIONS.map(s => (
                        <button key={s.label} type="button"
                          onClick={() => {
                            setValue(`services.${i}.service_type`, s.label, { shouldDirty: true })
                            setValue(`services.${i}.unit`, s.unit, { shouldDirty: true })
                          }}
                          title={s.hint}
                          className="text-[11px] rounded-full border border-border px-2 py-0.5 text-ink-muted hover:text-ink hover:border-accent transition-colors">
                          {s.label}
                        </button>
                      ))}
                    </div>
                    {/* No Duration field: spreading the mulch is the SERVICE line's
                        minutes. Minutes here would inflate the scheduled job twice. */}
                    <div className="grid grid-cols-3 gap-3">
                      <Input label="Qty" type="number" step="0.5" min="0"
                        {...register(`services.${i}.quantity` as const, { min: 0 })} />
                      <Select label="Unit" options={unitOptions}
                        {...register(`services.${i}.unit` as const)} />
                      <Input label="Price per unit ($)" type="number" step="1" min="0"
                        {...register(`services.${i}.unit_price` as const, { min: 0 })} />
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
              <datalist id="eq-material-suggestions">
                {MATERIAL_SUGGESTIONS.map(s => <option key={s.label} value={s.label} />)}
              </datalist>
              <Button type="button" variant="secondary" size="sm" onClick={() => serviceLines.append(emptyMaterialLine())}>
                <Plus className="w-3.5 h-3.5" /> Add material
              </Button>
              {materialsSum.net > 0 && (
                <p className="text-xs text-ink-muted">
                  Materials total <span className="font-semibold text-ink">{formatCurrency(materialsSum.net)}</span>
                  {materialsSum.discountAmount > 0 && <> (after {formatCurrency(materialsSum.discountAmount)} discounts)</>}
                  {' '}— included in the quote total.
                </p>
              )}
            </div>
          </Collapsible>


          <Collapsible title="Notes" icon={FileText} summary={notes ? String(notes).slice(0, 40) : 'None'}>
            <Textarea label="Notes" placeholder="Job-specific details, access instructions, gate codes…"
              {...register('notes')} />
            {aiScope.enabled === true && (
              <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <AssistButton
                  label={notes && String(notes).trim() ? 'Polish' : 'Write'}
                  busyLabel="Writing…"
                  busy={aiScope.running}
                  title="Turns the services on this quote (and your rough notes) into customer-ready scope-of-work text — never touches pricing"
                  onClick={async () => {
                    const prior = String(notes || '')
                    aiScope.clearError()
                    setValue('notes', '')
                    const full = await aiScope.run({
                      task: 'quote_scope',
                      // Lets the scope reference real history ("the same work we did in
                      // April"). Facts are re-derived server-side from this id, as ever.
                      customerId: watch('customer_id') || undefined,
                      serviceType: watch('service_type') || undefined,
                      services: (watchedServices || []).map(s => ({ name: s?.service_type, notes: s?.notes })),
                      propertyId: defaultPropertyId || undefined,
                      measuredSqft: measuredSqft || undefined,
                      address: address || undefined,
                      draft: prior,
                    }, { onDelta: d => setValue('notes', String(watch('notes') || '') + d) })
                    if (full === null) { setValue('notes', prior); return }
                    setAiScopePrior(prior)
                    // This field's replace is destructive and had no way back —
                    // the composer had undo, the two Notes fields did not.
                    if (prior.trim()) toast.undo('Replaced your notes.', () => { setValue('notes', prior); setAiScopePrior(null) })
                  }} />
                {aiScope.running && <AiStop onClick={aiScope.cancel} />}
                {!aiScope.running && aiScopePrior !== null && (
                  <AiUndo onClick={() => { setValue('notes', aiScopePrior); setAiScopePrior(null) }} />
                )}
              </div>
              <AiError message={aiScope.error} />
              {!aiScope.running && aiScopePrior !== null && (
                <AiNote caution={AI_CHECK_FIRST}
                  explain="Written from this quote's line items and your notes on them, plus what you've done for this customer before. It never sees or states a price." />
              )}
              </div>
            )}
          </Collapsible>

          <Collapsible title="Scheduling & status" icon={SlidersHorizontal}>
            <Controller name="status" control={control}
              render={({ field }) => (<Select label="Quote Status" options={statusOptions} {...field} />)} />
            <div className="pt-1">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-2 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent-text" /> Best days to schedule
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
              <Calculator className="w-4 h-4 text-accent-text" />
              <h2 className="text-sm font-semibold text-ink">Quote Preview</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              {previewBreakdown}
              <div className="pt-2 space-y-2">
                <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                  {isEdit ? 'Update quote' : 'Save quote'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>Cancel</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Mobile sticky save bar — always reachable without scrolling */}
      <StickyActionBar fixed className="lg:hidden flex items-center justify-between gap-3">
        {/* The total is the handle for the breakdown on mobile — the desktop
            preview card is the only other place it exists, and it's lg-only. */}
        <button type="button" onClick={() => setShowPreview(true)}
          className="leading-tight min-w-0 text-left rounded-lg -m-1 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Show the price breakdown">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">
            First visit total <ChevronUp className="w-3 h-3" />
          </p>
          <p className="text-xl font-bold text-accent-text leading-none tabular-nums">{formatCurrency(effectiveTotal)}</p>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" size="lg" loading={isSubmitting}>{isEdit ? 'Update quote' : 'Save quote'}</Button>
        </div>
      </StickyActionBar>

      {/* Mobile breakdown — the SAME previewBreakdown the desktop card renders,
          in the shared Modal (which is a bottom sheet on phones). */}
      <Modal open={showPreview} onClose={() => setShowPreview(false)} title="Quote breakdown" icon={Calculator} size="sm">
        <div className="space-y-3">{previewBreakdown}</div>
      </Modal>

      {showMeasure && (
        <QuoteMeasure
          address={address}
          travelFee={Number(travelFee) || 0}
          cfg={pricingConfigFromSettings(settings)}
          serviceType={watch('service_type')}
          pricingKind={pricingKind}
          propertyId={defaultPropertyId}
          customerId={customerId && customerId !== '__manual' ? customerId : undefined}
          services={activeTemplates.map(t => t.name).filter((n): n is string => !!n)}
          // Setting the NAME alone left service_template_id stale, so svcTemplate
          // stayed null and pricingKind fell back to matching the name — which is a
          // guess about the trade, not the owner's answer. A "Lawn Mowing" template
          // the owner configured as hourly still name-matched to lawn_recurring and
          // re-opened the cadence gate two lines below. Set the id and let the
          // template effect above derive name/rate/notes: the picker's one path,
          // not a second one. Free text (no template) clears the id for the same reason.
          onServiceChange={(n) => {
            const t = activeTemplates.find(s => s.name === n)
            if (t) setValue('service_template_id', t.id)
            else { setValue('service_template_id', ''); setValue('service_type', n) }
          }}
          onClose={() => setShowMeasure(false)}
          onApply={(sel) => {
            // The measured AREA is a fact about the property and applies to every
            // trade — a traced roof is a traced roof. The PRICES in `sel` are not:
            // they come from pricingPackage(), the grass cadence engine, whose
            // signature never sees a service. Applying them to a pressure-washing
            // or furnace quote put a mowing price on it AND (via the old
            // setInitialManual(true)) locked out the correct labour suggestion, so
            // the one-tap default was the wrong number. The area always applies;
            // the lawn structure only applies to lawn-cadence services.
            setValue('measured_sqft', sel.totalSqft)
            if (pricingKind !== 'lawn_recurring') { setShowMeasure(false); return }

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
            setValue('suggested_price', sel.suggested)
            setPriceOrigin('applied')   // they tapped a tier in the modal
            setShowMeasure(false)
          }}
        />
      )}
    </form>
  )
}