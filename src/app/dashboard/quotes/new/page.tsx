'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings, LawnSections, PricingConfidence } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'
import { applyOvergrowth, generateQuoteNumber } from '@/lib/utils'
import { ensureCustomerAndProperty } from '@/lib/customers'

interface MeasurementPayload {
  customerId: string | null
  propertyId: string | null
  address: string
  sqft: number
  sections?: LawnSections
  jobPrice: number
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
        supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
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

    // New format: EPS-#### (zero-padded, auto-increment)
    const { count } = await supabase
      .from('quotes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user!.id)
    const quote_number = generateQuoteNumber((count || 0) + 1)

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
      initial_price: Number(values.initial_price) > 0 ? Number(values.initial_price) : null,
      weekly_price: Number(values.weekly_price) > 0 ? Number(values.weekly_price) : null,
      biweekly_price: Number(values.biweekly_price) > 0 ? Number(values.biweekly_price) : null,
      monthly_price: Number(values.monthly_price) > 0 ? Number(values.monthly_price) : null,
      overgrowth_multiplier: mult,
      custom_travel_required: values.custom_travel_required,
      show_travel_separately: values.show_travel_separately,
      issued_date: new Date().toISOString().split('T')[0],
      notes: values.notes || null,
      hours: Number(values.hours),
      crew_size: Number(values.crew_size),
      rate: finalRate,
      travel_fee: Number(values.travel_fee),
      measured_sqft: measurement?.sqft ?? (Number(values.measured_sqft) || null),
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
          // Sensible default so a measured lawn is saveable in one tap (editable).
          service_type: 'Lawn Mowing',
          initial_price: measurement.jobPrice || 0,
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