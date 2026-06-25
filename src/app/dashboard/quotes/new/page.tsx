'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings, LawnSections, PricingConfidence } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'
import { applyOvergrowth, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { pricingConfigFromSettings, pricingPackage, buildSavedRecommendation, estimateVisitMinutes } from '@/lib/pricing'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { applyFeeRecovery } from '@/lib/invoiceTotals'

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
}

export default function NewQuotePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const defaultCustomerId = searchParams.get('customer') || undefined
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [measurement, setMeasurement] = useState<MeasurementPayload | null>(null)
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
  }, [])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [customersRes, templatesRes, tiersRes, settingsRes] = await Promise.all([
        supabase.from('customers').select('*').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — archived hidden from the picker
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
      const c = customers.find(c => c.id === values.customer_id)
      if (c) customerName = c.name
    }

    const mult = Number(values.overgrowth_multiplier) || 1
    const finalRate = applyOvergrowth(Number(values.rate), mult)

    const { data, error } = await supabase.from('quotes').insert({
      quote_number,
      customer_id: customerId,
      customer_name: customerName,
      address: values.address,
      service_type: values.service_type,
      service_template_id: values.service_template_id || null,
      // Bake the fee-recovery markup (global price increase) into the customer-
      // facing prices ONCE, here at generation. Jobs + invoices + Stripe inherit
      // these, so there's no double-application. suggested_price stays at the raw
      // engine value, so the quote page still shows "suggested → quoted".
      initial_price: applyFeeRecovery(Number(values.initial_price) > 0 ? Number(values.initial_price) : null, settings),
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
        // New or unchanged → sync silently. REPLACING a saved measurement → confirm first.
        if (changed && (prior === 0 || confirm(`This property has a saved lawn size of ${prior.toLocaleString()} ft².\n\nReplace it with ${measuredSqft.toLocaleString()} ft²?`))) {
          const cfg = pricingConfigFromSettings(settings)
          const pkg = pricingPackage(measuredSqft, cfg, { overgrowth: Number(values.overgrowth_multiplier) || 1, nearbyCount: 0 })
          const rec = buildSavedRecommendation(pkg, estimateVisitMinutes(measuredSqft))
          if (measurement?.cadence && measurement.cadence !== 'one_time') rec.cadence = measurement.cadence
          const hist = Array.isArray((prop as { measurement_history: unknown } | null)?.measurement_history)
            ? (prop as { measurement_history: unknown[] }).measurement_history : []
          await supabase.from('properties').update({
            lawn_sqft: measuredSqft,
            measurement_history: [...hist, { date: new Date().toISOString(), total_sqft: measuredSqft, sections: measurement?.sections ?? undefined, recommendation: rec }],
          }).eq('id', propertyId)
        }
      }
      // Tell the next screen the lead became a customer (created or matched).
      if (typeof window !== 'undefined' && (createdCustomer || matchedBy)) {
        window.sessionStorage.setItem('eq_quote_save_customer', JSON.stringify({ created: createdCustomer, name: customerName, matchedBy }))
      }
      router.push(`/dashboard/quotes/${data.id}`)
    } else if (error) {
      alert('Could not save quote: ' + error.message)
    }
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading...</div>

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="New Quote" description="Build and save a new service quote" />
      <QuoteBuilder
        customers={customers}
        templates={templates}
        tiers={tiers}
        settings={settings}
        defaultCustomerId={measurement?.customerId || defaultCustomerId}
        defaultValues={measurement ? {
          customer_id: measurement.customerId || '',
          address: measurement.address || '',
          // Lawn size measured on the website flows straight into the editable field.
          measured_sqft: measurement.sqft || 0,
          // Sensible default so a measured lawn is saveable in one tap (editable).
          service_type: 'Lawn Mowing',
          initial_price: measurement.jobPrice || 0,
          // Selected cadence from the pricing package — the full structure
          // arrives pre-filled, no manual entry.
          weekly_price: measurement.weekly || 0,
          biweekly_price: measurement.biweekly || 0,
          monthly_price: measurement.monthly || 0,
          travel_fee: measurement.travelFee || 0,
          distance_km: measurement.travelDistanceKm || 0,
          custom_travel_required: measurement.travelIsCustom || false,
          overgrowth_multiplier: measurement.overgrowth || 1,
        } : undefined}
        onSubmit={handleSubmit}
      />
    </div>
  )
}