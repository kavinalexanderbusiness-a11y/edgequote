'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'

export default function NewQuotePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const defaultCustomerId = searchParams.get('customer') || undefined
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

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
    const num = String((count || 0) + 1).padStart(4, '0')
    const quote_number = `EPS-${num}`

    let customerName = values.customer_name
    if (values.customer_id && values.customer_id !== '__manual') {
      const customer = customers.find(c => c.id === values.customer_id)
      if (customer) customerName = customer.name
    }

    const mult = Number(values.overgrowth_multiplier) || 1
    const finalRate = mult === 0 ? Number(values.rate) : Number(values.rate) * mult

    const { data, error } = await supabase.from('quotes').insert({
      quote_number,
      customer_id: values.customer_id && values.customer_id !== '__manual' ? values.customer_id : null,
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
      status: values.status,
      user_id: user!.id,
    }).select().single()

    if (!error && data) {
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
        defaultCustomerId={defaultCustomerId}
        onSubmit={handleSubmit}
      />
    </div>
  )
}