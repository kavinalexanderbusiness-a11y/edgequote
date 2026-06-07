'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Quote, Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Edit2, ArrowLeft, FileDown, CalendarPlus, FileText, Copy } from 'lucide-react'

export default function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)
  const [convertMsg, setConvertMsg] = useState<string | null>(null)
  const [showSchedulePrompt, setShowSchedulePrompt] = useState(false)
  const [duplicating, setDuplicating] = useState(false)


  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [qRes, cRes, tRes, tierRes, sRes] = await Promise.all([
        supabase.from('quotes').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
        supabase.from('service_templates').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('travel_fee_tiers').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
      ])
      setQuote(qRes.data)
      setCustomers(cRes.data || [])
      setTemplates(tRes.data || [])
      setTiers(tierRes.data || [])
      setSettings(sRes.data)
      setLoading(false)
    }
    load()
  }, [id])

  async function handleUpdate(values: QuoteFormValues) {
    let customerName = values.customer_name
    if (values.customer_id && values.customer_id !== '__manual') {
      const customer = customers.find(c => c.id === values.customer_id)
      if (customer) customerName = customer.name
    }

    const mult = Number(values.overgrowth_multiplier) || 1
    const finalRate = mult === 0 ? Number(values.rate) : Number(values.rate) * mult
    const isRecurring = values.service_frequency !== 'one_time'

    const { data, error } = await supabase
      .from('quotes')
      .update({
        customer_id: values.customer_id && values.customer_id !== '__manual' ? values.customer_id : null,
        customer_name: customerName,
        address: values.address,
        service_type: values.service_type,
        service_template_id: values.service_template_id || null,
        service_frequency: values.service_frequency,
        initial_price: isRecurring ? Number(values.initial_price) || null : null,
        recurring_price: isRecurring ? Number(values.recurring_price) || null : null,
        recurring_interval: values.recurring_interval || null,
        overgrowth_multiplier: mult,
        custom_travel_required: values.custom_travel_required,
        show_travel_separately: values.show_travel_separately,
        notes: values.notes || null,
        hours: Number(values.hours),
        crew_size: Number(values.crew_size),
        rate: finalRate,
        travel_fee: Number(values.travel_fee),
        flat_price: Number(values.flat_price) > 0 ? Number(values.flat_price) : null,
        status: values.status,
      })
      .eq('id', id)
      .select()
      .single()

    if (data) {
      setQuote(data)
      setEditing(false)
    } else if (error) {
      alert('Could not update quote: ' + error.message)
    }
  }

 async function handleOpenPdf() {
    if (!quote) return
    setPdfLoading(true)
    try {
      const { renderQuoteBlob } = await import('@/components/quotes/QuotePDF')
      const blob = await renderQuoteBlob(quote, settings)
      const url = URL.createObjectURL(blob)
      // Hand the file directly to the device. On desktop this downloads the
      // PDF; on iOS it opens the PDF viewer / share sheet. Avoids the
      // about:blank tab that mobile Safari leaves when opening a blob URL.
      const a = document.createElement('a')
      a.href = url
      a.download = `${quote.quote_number}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch {
      alert('Could not generate the PDF. Please try again.')
    } finally {
      setPdfLoading(false)
    }
  }
  async function handleScheduleJob() {
    if (!quote) return
    setScheduling(true)
    setScheduleMsg(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Find the property for this quote: use quote.property_id, else the customer's primary property
      let propertyId: string | null = quote.property_id
      if (!propertyId && quote.customer_id) {
        const { data: props } = await supabase
          .from('properties')
          .select('id')
          .eq('customer_id', quote.customer_id)
          .order('is_primary', { ascending: false })
          .limit(1)
        if (props && props.length > 0) propertyId = props[0].id
      }

      const { error } = await supabase.from('jobs').insert({
        user_id: user!.id,
        customer_id: quote.customer_id,
        property_id: propertyId,
        quote_id: quote.id,
        title: `${quote.service_type} — ${quote.customer_name}`,
        service_type: quote.service_type,
        scheduled_date: new Date().toISOString().slice(0, 10),
        duration_minutes: Math.round(Number(quote.hours) * 60),
        crew_size: quote.crew_size,
        status: 'scheduled',
        notes: quote.notes,
      })

      if (error) {
        setScheduleMsg('Could not create job: ' + error.message)
      } else {
        // Bump quote to scheduled if it was accepted
        if (quote.status === 'accepted') {
          await supabase.from('quotes').update({ status: 'scheduled' }).eq('id', quote.id)
          setQuote({ ...quote, status: 'scheduled' })
        }
        setScheduleMsg('Job created. Set the date on the Schedule page.')
      }
    } catch {
      setScheduleMsg('Could not create job. Please try again.')
    } finally {
      setScheduling(false)
    }
  }

  async function handleConvertToInvoice() {
    if (!quote) return
    setConverting(true)
    setConvertMsg(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Don't double-convert
      const { data: existing } = await supabase
        .from('invoices')
        .select('id')
        .eq('quote_id', quote.id)
        .limit(1)
      if (existing && existing.length > 0) {
        setConvertMsg('An invoice already exists for this quote.')
        setConverting(false)
        return
      }

      // Generate INV-#### from current count
      const { count } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user!.id)
      const num = (count || 0) + 1
      const invoiceNumber = `INV-${String(num).padStart(4, '0')}`

      const due = new Date()
      due.setDate(due.getDate() + 14)

      const { error } = await supabase.from('invoices').insert({
        user_id: user!.id,
        quote_id: quote.id,
        customer_id: quote.customer_id,
        property_id: quote.property_id,
        invoice_number: invoiceNumber,
        customer_name: quote.customer_name,
        address: quote.address,
        service_type: quote.service_type,
        amount: quote.total,
        status: 'unpaid',
        issued_date: new Date().toISOString().slice(0, 10),
        due_date: due.toISOString().slice(0, 10),
        notes: quote.notes,
      })

      if (error) {
        setConvertMsg('Could not create invoice: ' + error.message)
      } else {
        setConvertMsg(`Invoice ${invoiceNumber} created.`)
      }
    } catch {
      setConvertMsg('Could not create invoice. Please try again.')
    } finally {
      setConverting(false)
    }
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading...</div>
  if (!quote) return <div className="text-center py-16 text-sm text-red-400">Quote not found.</div>

  const isRecurring = quote.service_frequency && quote.service_frequency !== 'one_time'
  const recurringLabel = quote.service_frequency === 'initial_weekly' ? 'Weekly Maintenance' : 'Bi-Weekly Maintenance'
  const canSchedule = quote.status === 'accepted' || quote.status === 'scheduled'
  const canInvoice = quote.status === 'accepted' || quote.status === 'scheduled' || quote.status === 'completed'

  if (editing) return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title={`Edit ${quote.quote_number}`} />
      <QuoteBuilder
        customers={customers}
        templates={templates}
        tiers={tiers}
        settings={settings}
        defaultValues={{
          customer_id: quote.customer_id || '__manual',
          customer_name: quote.customer_name,
          address: quote.address,
          service_type: quote.service_type,
          service_template_id: quote.service_template_id || '',
          service_frequency: quote.service_frequency || 'one_time',
          initial_price: quote.initial_price || 0,
          recurring_price: quote.recurring_price || 0,
          recurring_interval: quote.recurring_interval || '',
          overgrowth_multiplier: 1,
          distance_km: 0,
          hours: quote.hours,
          crew_size: quote.crew_size,
          rate: quote.rate,
          travel_fee: quote.travel_fee,
          flat_price: quote.flat_price || 0,
          custom_travel_required: quote.custom_travel_required || false,
          show_travel_separately: quote.show_travel_separately || false,
          notes: quote.notes || '',
          status: quote.status,
        }}
        onSubmit={handleUpdate}
        isEdit
      />
    </div>
  )

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <PageHeader
          title={quote.quote_number}
          description={`Created ${formatDate(quote.created_at)}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <QuoteStatusControl
                quoteId={quote.id}
                status={quote.status}
                onChanged={(s) => {
                  setQuote(prev => prev ? { ...prev, status: s } : prev)
                  if (s === 'accepted') setShowSchedulePrompt(true)
                }}
              />
              {canSchedule && (
                <Button onClick={handleScheduleJob} variant="secondary" size="sm" loading={scheduling}>
                  <CalendarPlus className="w-3.5 h-3.5" /> Schedule Job
                </Button>
              )}
              {canInvoice && (
                <Button onClick={handleConvertToInvoice} variant="secondary" size="sm" loading={converting}>
                  <FileText className="w-3.5 h-3.5" /> Convert to Invoice
                </Button>
              )}
              <Button onClick={handleOpenPdf} variant="secondary" size="sm" loading={pdfLoading}>
                <FileDown className="w-3.5 h-3.5" /> Open PDF
              </Button>
              <Button onClick={() => setEditing(true)} variant="secondary" size="sm">
                <Edit2 className="w-3.5 h-3.5" /> Edit
              </Button>
            </div>
          }
        />
      </div>

      {showSchedulePrompt && (
        <div className="flex items-center justify-between flex-wrap gap-3 text-sm bg-accent/10 border border-accent/20 rounded-xl px-4 py-3">
          <span className="text-ink font-medium">Quote accepted — schedule this job now?</span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={async () => { setShowSchedulePrompt(false); await handleScheduleJob(); router.push('/dashboard/schedule') }}>
              Yes, schedule
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSchedulePrompt(false)}>Not now</Button>
          </div>
        </div>
      )}

      {scheduleMsg && (
        <div className="text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          {scheduleMsg} <button onClick={() => router.push('/dashboard/schedule')} className="underline font-medium ml-1">Go to Schedule</button>
        </div>
      )}

      {convertMsg && (
        <div className="text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          {convertMsg} <button onClick={() => router.push('/dashboard/invoices')} className="underline font-medium ml-1">Go to Invoices</button>
        </div>
      )}

      <Card>
        <div className="p-6 border-b border-border bg-gradient-to-r from-accent/5 to-transparent">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1">Customer</p>
          <p className="text-lg font-bold text-ink">{quote.customer_name}</p>
          <p className="text-sm text-ink-muted mt-0.5">{quote.address}</p>
        </div>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Service</p>
              <p className="text-ink font-medium">{quote.service_type}</p>
            </div>
            <div>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Frequency</p>
              <p className="text-ink font-medium">
                {quote.service_frequency === 'one_time' ? 'One-Time' :
                 quote.service_frequency === 'initial_weekly' ? 'Initial + Weekly' : 'Initial + Bi-Weekly'}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Hours</p>
              <p className="text-ink font-medium">{quote.hours} hrs</p>
            </div>
            <div>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Crew Size</p>
              <p className="text-ink font-medium">{quote.crew_size} worker{quote.crew_size > 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Rate</p>
              <p className="text-ink font-medium">{formatCurrency(quote.rate)}/man-hour</p>
            </div>
            {quote.overgrowth_multiplier && quote.overgrowth_multiplier !== 1 && (
              <div>
                <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Overgrowth</p>
                <p className="text-ink font-medium">{quote.overgrowth_multiplier}×</p>
              </div>
            )}
          </div>

          {quote.notes && (
            <div className="pt-3 border-t border-border">
              <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Notes</p>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-2">
            {quote.custom_travel_required && (
              <div className="flex items-center gap-2 text-xs text-amber-400 mb-1">Custom travel fee applied (beyond standard tiers)</div>
            )}
            {quote.flat_price != null ? (
              <div className="flex items-center justify-between pt-1">
                <div>
                  <span className="text-sm font-semibold text-ink">Total</span>
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">Manual price</span>
                </div>
                <span className="text-3xl font-bold text-accent">{formatCurrency(quote.total)}</span>
              </div>
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Labour ({quote.man_hours} hrs × {formatCurrency(quote.rate)})</span>
                  <span className="text-ink font-medium">{formatCurrency(quote.subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Travel Fee {quote.show_travel_separately ? '(shown to customer)' : '(in total)'}</span>
                  <span className="text-ink font-medium">{formatCurrency(quote.travel_fee)}</span>
                </div>
                {isRecurring ? (
                  <div className="pt-2 border-t border-border space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-ink-muted">Initial Visit</span>
                      <span className="text-xl font-bold text-ink">{formatCurrency(quote.initial_price || quote.total)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-ink-muted">{recurringLabel}</span>
                      <span className="text-xl font-bold text-accent">{formatCurrency(quote.recurring_price || 0)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center pt-2 border-t border-border">
                    <span className="text-sm font-semibold text-ink">Total</span>
                    <span className="text-3xl font-bold text-accent">{formatCurrency(quote.total)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}