'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings, LawnSections, PricingConfidence, SavedRecommendation } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { applyOvergrowth, generateQuoteNumber, localTodayISO, maxNumericSuffix, formatCurrency } from '@/lib/utils'
import { Globe } from 'lucide-react'
import { pricingConfigFromSettings, pricingPackage, buildSavedRecommendation, estimateVisitMinutes } from '@/lib/pricing'
import { servicePricingKind } from '@/lib/servicePricing'
import { saveManual } from '@/lib/measure/data'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { applyFeeRecovery } from '@/lib/invoiceTotals'
import { sumServiceLines } from '@/lib/quoteServices'
import { LeadPrefillPayload, LEAD_PREFILL_KEY } from '@/lib/leads'
import { toast } from '@/lib/toast'
import { ensureCurrentPricingConfigVersion } from '@/lib/pricingConfig'

interface MeasurementPayload {
  customerId: string | null
  propertyId: string | null
  address: string
  sqft: number
  sections?: LawnSections
  jobPrice: number
  // Selected recurring structure from the pricing recommendation package.
  cadence?: 'one_time' | 'weekly' | 'biweekly' | 'monthly' | null
  weekly?: number | null
  biweekly?: number | null
  monthly?: number | null
  travelFee?: number
  includeTravel?: boolean
  travelIsCustom?: boolean
  travelDistanceKm?: number | null
  suggestedPrice: number
  ratePer1000?: number
  overgrowth?: number
  confidence?: PricingConfidence
  // ADR-002 · derived state carried from the standalone Measurement Tool, so BOTH
  // measure paths record the same provenance. Optional because a payload written by an
  // older tab (this travels through sessionStorage) simply won't have them — and
  // absent must read as "not recorded", never as a grade.
  valueGrade?: string | null
  nearbyCount?: number | null
}

export default function NewQuotePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const defaultCustomerId = searchParams.get('customer') || undefined
  const defaultPropertyId = searchParams.get('property') || undefined
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [measurement, setMeasurement] = useState<MeasurementPayload | null>(null)
  const [lead, setLead] = useState<LeadPrefillPayload | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  // Consume a handoff from the Measurement Tool (one-time).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.sessionStorage.getItem('eq_measurement')
    if (raw) {
      try { setMeasurement(JSON.parse(raw) as MeasurementPayload) } catch { /* ignore */ }
      window.sessionStorage.removeItem('eq_measurement')
    }
    // Consume a website-lead handoff (one-time) — opens the builder pre-filled from
    // a website quote request (Build Quote in Messages).
    const leadRaw = window.sessionStorage.getItem(LEAD_PREFILL_KEY)
    if (leadRaw) {
      try { setLead(JSON.parse(leadRaw) as LeadPrefillPayload) } catch { /* ignore */ }
      window.sessionStorage.removeItem(LEAD_PREFILL_KEY)
    }
  }, [])

  useEffect(() => {
    async function load() {
      // Local session read — no auth round-trip before the builder's data batch.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      const [customersRes, templatesRes, tiersRes, settingsRes] = await Promise.all([
        supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — archived hidden from the picker
        supabase.from('service_templates').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('travel_fee_tiers').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
      ])
      setCustomers(customersRes.data || [])
      setTemplates(templatesRes.data || [])
      setTiers(tiersRes.data || [])
      setSettings(settingsRes.data)
      setLoading(false)
    }
    load()
  }, [])

  async function handleSubmit(values: QuoteFormValues) {
    const { data: { user } } = await supabase.auth.getUser()

    // Next number from the highest EXISTING quote number — a row count would
    // reissue a number after any delete and two quotes would share it.
    const { data: qnums } = await supabase
      .from('quotes')
      .select('quote_number')
      .eq('user_id', user!.id)
    const quote_number = generateQuoteNumber(maxNumericSuffix(((qnums as { quote_number: string }[]) || []).map(n => n.quote_number)) + 1)

    // Every quote gets a real customer + property (create or match — no dupes, no orphans).
    let customerId: string | null = values.customer_id && values.customer_id !== '__manual' ? values.customer_id : null
    let propertyId: string | null = measurement?.propertyId ?? null
    let customerName = values.customer_name
    let createdCustomer = false
    let matchedBy: string | null = null
    try {
      const ensured = await ensureCustomerAndProperty(
        supabase, user!.id,
        { customerId: values.customer_id, name: values.customer_name, address: values.address, phone: values.customer_phone, email: values.customer_email },
        customers,
      )
      customerId = ensured.customerId
      customerName = ensured.customerName
      propertyId = measurement?.propertyId ?? ensured.propertyId
      createdCustomer = ensured.createdCustomer
      matchedBy = ensured.matchedBy
    } catch {
      // This catch used to swallow the failure: it recovered the display NAME, left
      // customerId null, and let the insert proceed — manufacturing a quote that can
      // never reach anyone. An orphan can't be sent (the Send card is gated on
      // customer_id), can't be chased (the cron filters on it), and has no portal. The
      // comment four lines up promises "no orphans"; this is what broke that promise.
      //
      // FOUR live rows came from here, one ("Danika bray", $66.95) with work already
      // scheduled against a quote that has no customer — and one whose customer NAME is
      // a phone number, which is what a half-recovered save looks like from the outside.
      //
      // So: stop. Returning leaves the builder's own form state intact with everything
      // the owner typed — the same choice handleSaveEdit makes on a failed write —
      // because a lost draft is recoverable in ten seconds and a silent orphan is not
      // recoverable at all.
      toast.error('Could not link this quote to a customer — nothing was saved. Check your connection and press Save again.')
      return
    }

    const mult = Number(values.overgrowth_multiplier) || 1
    const finalRate = applyOvergrowth(Number(values.rate), mult)

    // Multi-service: fee-recover each additional line's unit price (same one-time
    // bake-in as initial_price), then store initial_price = primary + Σ line nets
    // so the GENERATED quotes.total — and every consumer of it — stays correct.
    const recoveredPrimary = applyFeeRecovery(Number(values.initial_price) > 0 ? Number(values.initial_price) : null, settings)
    const extraLines = (values.services || [])
      .filter(s => s.service_type.trim())
      .map(s => ({ ...s, unit_price: applyFeeRecovery(Number(s.unit_price) || 0, settings) ?? 0 }))
    const extrasNet = sumServiceLines(extraLines).net
    const initialWithExtras = (recoveredPrimary ?? 0) + extrasNet

    // ADR-002 · state which configuration priced this quote, or don't write it.
    //
    // FAIL-CLOSED, and this is the whole point. A quote whose config we cannot name is
    // exactly the row this ADR exists to stop creating — 55 of them already exist and
    // can never be reproduced or learned from. The DB refuses it too
    // (quotes_engine_price_needs_config), so a soft fallback here would only turn a
    // clear message into a constraint violation. Stopping BEFORE the insert also keeps
    // the builder's form state intact, exactly as the customer-link guard above does:
    // a lost draft is recoverable in ten seconds; a quote with no provenance is not.
    const ver = await ensureCurrentPricingConfigVersion(supabase, user!.id)
    if (!ver.ok) {
      toast.error('Could not record which pricing settings this quote used — nothing was saved. Check your connection and press Save again.')
      return
    }

    const { data, error } = await supabase.from('quotes').insert({
      quote_number,
      // ADR-002 provenance. `price_source: 'engine'` is truthful for every quote this
      // form writes — even one the owner priced by hand, because `suggested_price` was
      // still computed by the engine under this config and the learner reads the pair.
      // (`initial_price !== suggested_price` is the app's own record of an override.)
      price_source: 'engine',
      pricing_config_version_id: ver.versionId,
      // Derived state. null = no grade was computed, which is a fact worth recording
      // honestly rather than defaulting.
      value_grade: values.value_grade ?? measurement?.valueGrade ?? null,
      nearby_count: values.nearby_count ?? measurement?.nearbyCount ?? null,
      customer_id: customerId,
      customer_name: customerName,
      address: values.address,
      service_type: values.service_type,
      service_template_id: values.service_template_id || null,
      // Bake the fee-recovery markup (global price increase) into the customer-
      // facing prices ONCE, here at generation. Jobs + invoices + Stripe inherit
      // these, so there's no double-application. suggested_price stays at the raw
      // engine value, so the quote page still shows "suggested → quoted".
      initial_price: initialWithExtras > 0 ? initialWithExtras : null,
      weekly_price: applyFeeRecovery(Number(values.weekly_price) > 0 ? Number(values.weekly_price) : null, settings),
      biweekly_price: applyFeeRecovery(Number(values.biweekly_price) > 0 ? Number(values.biweekly_price) : null, settings),
      monthly_price: applyFeeRecovery(Number(values.monthly_price) > 0 ? Number(values.monthly_price) : null, settings),
      overgrowth_multiplier: mult,
      custom_travel_required: values.custom_travel_required,
      show_travel_separately: values.show_travel_separately,
      issued_date: localTodayISO(),
      notes: values.notes || null,
      hours: Number(values.hours),
      crew_size: Number(values.crew_size),
      rate: finalRate,
      travel_fee: applyFeeRecovery(Number(values.travel_fee), settings) ?? 0,
      measured_sqft: Number(values.measured_sqft) || measurement?.sqft || null,
      suggested_price: measurement?.suggestedPrice ?? (Number(values.suggested_price) || null),
      front_lawn_sqft: measurement?.sections?.front ?? null,
      back_lawn_sqft: measurement?.sections?.back ?? null,
      left_side_sqft: measurement?.sections?.left ?? null,
      right_side_sqft: measurement?.sections?.right ?? null,
      boulevard_sqft: measurement?.sections?.boulevard ?? null,
      other_sqft: measurement?.sections?.other ?? null,
      travel_distance_km: measurement?.travelDistanceKm ?? null,
      pricing_confidence: measurement?.confidence ?? null,
      property_id: propertyId,
      status: values.status,
      user_id: user!.id,
    }).select().single()

    if (!error && data) {
      // Persist the service breakdown (only for multi-service quotes; single-service
      // quotes stay legacy with no child rows — identical behavior to before).
      // Row 0 = the primary service, rows 1+ = the additional lines.
      if (extraLines.length) {
        await supabase.from('quote_services').insert([
          {
            user_id: user!.id, quote_id: data.id, sort_order: 0,
            service_type: values.service_type, service_template_id: values.service_template_id || null,
            quantity: 1, unit: 'each', unit_price: recoveredPrimary ?? 0,
            est_minutes: Math.round(Number(values.hours) * 60) || null,
          },
          ...extraLines.map((s, i) => ({
            user_id: user!.id, quote_id: data.id, sort_order: i + 1,
            service_type: s.service_type.trim(), service_template_id: s.service_template_id || null,
            quantity: Number(s.quantity) > 0 ? Number(s.quantity) : 1,
            unit: s.unit || 'each', unit_price: s.unit_price,
            est_minutes: Number(s.est_minutes) > 0 ? Math.round(Number(s.est_minutes)) : null,
            discount_type: s.discount_type || null,
            discount_value: s.discount_type && Number(s.discount_value) > 0 ? Number(s.discount_value) : null,
            notes: s.notes?.trim() || null,
            // The line KIND is what makes a material a material. Omit it and
            // every material saves as a service — silently, and the quote
            // reads correctly right up until someone reopens it.
            kind: s.kind || 'service',
          })),
        ])
      }
      // A measurement taken inside the builder previously lived ONLY on the quote —
      // the property stayed "unmeasured" and sqft-based pricing suggestions never
      // fired for it. Persist it back to the property (newest measurement wins),
      // WITH the full recommendation package so future quotes/jobs suggest these
      // prices without re-measuring. (Prices don't depend on route context.)
      const measuredSqft = Number(values.measured_sqft) || measurement?.sqft || 0
      if (propertyId && measuredSqft > 0) {
        const { data: prop } = await supabase.from('properties').select('lawn_sqft, measurement_history').eq('id', propertyId).maybeSingle()
        const prior = Number((prop as { lawn_sqft: number | null } | null)?.lawn_sqft) || 0
        const changed = Math.round(prior) !== Math.round(measuredSqft)
        // New or unchanged → sync silently. A CHANGED size replaces the saved
        // measurement non-blockingly (no up-front confirm) and offers a quick Undo.
        if (changed) {
          // The AREA is a fact about the property and is always saved. The
          // RECOMMENDATION is not: buildSavedRecommendation wraps pricingPackage —
          // the grass cadence engine — so attaching it to a pressure-washing or
          // furnace quote's measurement wrote weekly/bi-weekly MOWING prices into
          // that property's history, where every later quote reads them back as
          // "the saved recommendation" for whatever service comes next. One wrong
          // quote used to poison the property permanently. Only a lawn-cadence
          // service gets a lawn recommendation; everything else saves the
          // measurement alone, and `recommendation` stays undefined (which
          // latestSavedRecommendation already skips).
          // (`?? 0` — estimateVisitMinutes is null when unmeasured; this branch is
          // guarded by measuredSqft > 0, so 0 is a type-level fallback, never data.)
          const isLawn = servicePricingKind(values.service_type, templates.find(t => t.id === values.service_template_id) ?? null) === 'lawn_recurring'
          const hist = Array.isArray((prop as { measurement_history: unknown } | null)?.measurement_history)
            ? (prop as { measurement_history: unknown[] }).measurement_history : []

          // MEAS-1: lawn AREA is owned by the typed ledger (property_measurements).
          // The mirror trigger derives properties.lawn_sqft and a DB guard now
          // rejects any direct lawn_sqft write that disagrees with it, so persist
          // through the ONE seam (lib/measure) and never write lawn_sqft here. Only
          // a LAWN service touches lawn area — a pressure-washing or furnace area is
          // not a lawn, and V2 exists precisely to stop that cross-contamination
          // (the old code wrote every measured area into lawn_sqft).
          if (isLawn) {
            const saved = await saveManual(supabase, { userId: user!.id, propertyId, kind: 'lawn', value: measuredSqft })
            if (!saved.ok) toast.error(`Saved the quote, but the lawn size didn’t sync: ${saved.error}`)

            // The pricing RECOMMENDATION is a lawn-only cache in measurement_history
            // that the property list and JobForm read back; append it alongside the
            // lawn save so the flagship measure flow keeps feeding those surfaces.
            const cfg = pricingConfigFromSettings(settings)
            const pkg = pricingPackage(measuredSqft, cfg, { overgrowth: Number(values.overgrowth_multiplier) || 1, nearbyCount: 0 })
            const rec = buildSavedRecommendation(pkg, estimateVisitMinutes(measuredSqft) ?? 0)
            if (measurement?.cadence && measurement.cadence !== 'one_time') rec.cadence = measurement.cadence
            await supabase.from('properties').update({
              measurement_history: [...hist, { date: new Date().toISOString(), total_sqft: measuredSqft, sections: measurement?.sections ?? lead?.sections ?? undefined, recommendation: rec }],
            }).eq('id', propertyId)

            if (prior > 0) {
              const priorLawn = (prop as { lawn_sqft: number | null } | null)?.lawn_sqft ?? null
              toast.undo(`Saved lawn size updated to ${measuredSqft.toLocaleString()} ft²`, async () => {
                if (priorLawn != null) await saveManual(supabase, { userId: user!.id, propertyId, kind: 'lawn', value: priorLawn })
                await supabase.from('properties').update({ measurement_history: hist }).eq('id', propertyId)
              })
            }
          }

          // A website lead measured the boundary/place/travel once — persist them
          // for any service. These aren't lawn_sqft, so the guard doesn't touch them.
          if (lead) {
            const geo: Record<string, unknown> = {}
            if (lead.lawnPolygon) geo.lawn_polygon = lead.lawnPolygon
            if (lead.placeId) geo.google_place_id = lead.placeId
            if (lead.mapsUrl) geo.maps_url = lead.mapsUrl
            if (lead.lat != null) geo.lat = lead.lat
            if (lead.lng != null) geo.lng = lead.lng
            if (lead.travelDistanceKm != null) geo.property_travel_distance_km = lead.travelDistanceKm
            if (lead.travelFee != null) geo.property_travel_fee = lead.travelFee
            if (Object.keys(geo).length) await supabase.from('properties').update(geo).eq('id', propertyId)
          }
        }
      }
      // Website lead: link it to the new quote + clear the open-lead badge so the
      // conversation continues as a normal thread (SMS/portal/follow-ups).
      if (lead) {
        await supabase.from('website_leads').update({ status: 'quoted', quote_id: data.id }).eq('id', lead.leadId)
        if (customerId) await supabase.from('conversations').update({ lead_status: null }).eq('user_id', user!.id).eq('customer_id', customerId)
      }
      // Tell the next screen the lead became a customer (created or matched).
      if (typeof window !== 'undefined' && (createdCustomer || matchedBy)) {
        window.sessionStorage.setItem('eq_quote_save_customer', JSON.stringify({ created: createdCustomer, name: customerName, matchedBy }))
      }
      toast.success(lead ? 'Quote created from the website lead.' : 'Quote created.')
      router.push(`/dashboard/quotes/${data.id}`)
    } else if (error) {
      toast.error('Could not save quote: ' + error.message)
    }
  }

  // ── The MeasureTool → quote handoff (sessionStorage 'eq_measurement') ────────
  // MeasureTool measures a PROPERTY and has no concept of a service, so every
  // price it hands over (jobPrice/weekly/biweekly/monthly) comes from
  // pricingPackage() — the grass cadence engine — whatever the trace was of. This
  // form then defaulted service_type to the owner's first active template, so for
  // any non-lawn trade the pair was: THEIR service name + OUR lawn prices. Worse,
  // QuoteBuilder seeds priceOrigin='manual' whenever a non-zero initial_price
  // arrives in defaultValues (correct for editing a real saved quote — that price
  // IS the owner's past decision), which locks the reconciliation effect off, so
  // the wrong number could never be corrected and read as hand-typed.
  //
  // Gate the PRICES on the same seam as everywhere else. The area, address and
  // customer are facts and always carry over. For the lawn business — first active
  // template "Lawn Mowing" → lawn_recurring — every field is seeded exactly as
  // before, byte-identical.
  const measurementDefaults = useMemo(() => {
    if (!measurement) return undefined
    const primary = templates.find(t => t.is_active) ?? null
    const lawn = servicePricingKind(primary?.name ?? '', primary) === 'lawn_recurring'
    return {
      customer_id: measurement.customerId || '',
      address: measurement.address || '',
      // The measured area flows straight into the editable field, every trade.
      measured_sqft: measurement.sqft || 0,
      // Default to the owner's PRIMARY service (their first template) so a
      // measured property is saveable in one tap — learned, not assumed.
      service_type: primary?.name || '',
      travel_fee: measurement.travelFee || 0,
      distance_km: measurement.travelDistanceKm || 0,
      custom_travel_required: measurement.travelIsCustom || false,
      // Lawn-engine output — only for a lawn-cadence service. The overgrowth
      // multiplier rides with them: it is a grass-growth adjustment and multiplies
      // nothing else.
      ...(lawn ? {
        initial_price: measurement.jobPrice || 0,
        // Selected cadence from the pricing package — the full structure
        // arrives pre-filled, no manual entry.
        weekly_price: measurement.weekly || 0,
        biweekly_price: measurement.biweekly || 0,
        monthly_price: measurement.monthly || 0,
        overgrowth_multiplier: measurement.overgrowth || 1,
      } : {}),
    }
  }, [measurement, templates])

  if (loading) return <div className="max-w-5xl mx-auto space-y-6"><SkeletonRows count={6} /></div>

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {lead ? (
        <>
          <PageHeader title="New quote from website lead" description="Review the pre-filled details and price, then create." />
          <Banner tone="accent" icon={Globe}>
            <span className="font-semibold text-ink">From a website request{lead.customerName ? ` — ${lead.customerName}` : ''}</span>
            {lead.initialPrice > 0 ? <> · they were quoted <span className="font-semibold text-ink">{formatCurrency(lead.initialPrice)}</span></> : null}
            {lead.serviceType ? <> · {lead.serviceType}</> : null}. We pre-filled their contact, address and pricing below — review and adjust before saving.
          </Banner>
        </>
      ) : (
        <PageHeader title="New Quote" description="Build and save a new service quote." />
      )}
      <QuoteBuilder
        customers={customers}
        templates={templates}
        tiers={tiers}
        settings={settings}
        defaultCustomerId={lead?.customerId || measurement?.customerId || defaultCustomerId}
        defaultPropertyId={measurement?.propertyId || defaultPropertyId}
        defaultValues={lead ? {
          // Pre-filled from a website quote request — review, adjust price, create.
          customer_id: lead.customerId || '',
          customer_name: lead.customerName || '',
          customer_phone: lead.customerPhone || '',
          customer_email: lead.customerEmail || '',
          address: lead.address || '',
          measured_sqft: lead.sqft || 0,
          // The lead's own stated service, else the owner's primary OFFERED one.
          // `templates` is loaded unfiltered (the picker still lists everything), so
          // the default must skip anything switched off — defaulting a new quote to a
          // service the owner has retired is a quote they have to correct by hand.
          // This branch was unreachable until the lead mapper stopped substituting a
          // hardcoded 'Lawn Mowing', which is always truthy.
          service_type: lead.serviceType || templates.find(t => t.is_active)?.name || '',
          // RAW website prices — handleSubmit applies fee-recovery once at insert.
          initial_price: lead.initialPrice || 0,
          weekly_price: lead.weekly || 0,
          biweekly_price: lead.biweekly || 0,
          monthly_price: lead.monthly || 0,
          travel_fee: lead.travelFee || 0,
          distance_km: lead.travelDistanceKm || 0,
          overgrowth_multiplier: lead.overgrowth || 1,
          notes: lead.notes || '',
        } : measurement ? measurementDefaults : undefined}
        onSubmit={handleSubmit}
      />
    </div>
  )
}