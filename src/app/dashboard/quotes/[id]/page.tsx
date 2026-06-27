'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Quote, Customer, QuoteFormValues, ServiceTemplate, TravelFeeTier, BusinessSettings, CONFIDENCE_LABELS, CONFIDENCE_COLORS } from '@/types'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { PageHeader } from '@/components/layout/PageHeader'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { SendComms } from '@/components/comms/SendComms'
import { formatCurrency, formatDate, applyOvergrowth, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { addDays, format as formatDfn, parseISO } from 'date-fns'
import { needsFollowUp, daysSince, logFollowUpPatch, markWonPatch } from '@/lib/followup'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { Edit2, ArrowLeft, FileDown, CalendarPlus, FileText, Copy, Bell, Phone, MessageSquare, RotateCw, Check, X, Send } from 'lucide-react'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
  const [duplicating, setDuplicating] = useState(false)
  const [savedCustomerMsg, setSavedCustomerMsg] = useState<string | null>(null)
  const [dupMsg, setDupMsg] = useState<string | null>(null)


  const supabase = createClient()

  // One-time confirmation handed over from the New Quote save (lead → customer).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.sessionStorage.getItem('eq_quote_save_customer')
    if (!raw) return
    window.sessionStorage.removeItem('eq_quote_save_customer')
    try {
      const m = JSON.parse(raw) as { created: boolean; name: string; matchedBy: string | null }
      setSavedCustomerMsg(
        m.created
          ? `New customer ${m.name} and their property were created and linked to this quote.`
          : m.matchedBy
            ? `Linked to existing customer ${m.name} (matched by ${m.matchedBy}) — no duplicate created.`
            : null
      )
    } catch { /* ignore */ }
  }, [])

  // One-time toast handed over from a Duplicate action on the source quote.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const from = window.sessionStorage.getItem('eq_quote_dup_from')
    if (!from) return
    window.sessionStorage.removeItem('eq_quote_dup_from')
    setDupMsg(`Duplicated from ${from}. Edit and save to finish the new quote.`)
  }, [])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const [qRes, cRes, tRes, tierRes, sRes] = await Promise.all([
        supabase.from('quotes').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('customers').select('*').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — archived hidden from the picker
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
    const { data: { user } } = await supabase.auth.getUser()

    // Keep the quote attached to a real customer + property (create or match).
    let customerId: string | null = values.customer_id && values.customer_id !== '__manual' ? values.customer_id : null
    let propertyId: string | null = quote?.property_id ?? null
    let customerName = values.customer_name
    try {
      const ensured = await ensureCustomerAndProperty(
        supabase, user!.id,
        { customerId: values.customer_id, name: values.customer_name, address: values.address, phone: values.customer_phone, email: values.customer_email },
        customers,
      )
      customerId = ensured.customerId
      customerName = ensured.customerName
      propertyId = ensured.propertyId ?? propertyId
    } catch {
      const c = customers.find(c => c.id === values.customer_id)
      if (c) customerName = c.name
    }

    const mult = Number(values.overgrowth_multiplier) || 1
    const finalRate = applyOvergrowth(Number(values.rate), mult)

    const { data, error } = await supabase
      .from('quotes')
      .update({
        customer_id: customerId,
        customer_name: customerName,
        property_id: propertyId,
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
        notes: values.notes || null,
        hours: Number(values.hours),
        crew_size: Number(values.crew_size),
        rate: finalRate,
        travel_fee: Number(values.travel_fee),
        measured_sqft: Number(values.measured_sqft) || null,
        suggested_price: Number(values.suggested_price) || null,
        status: values.status,
      })
      .eq('id', id)
      .select()
      .single()

    if (data) {
      setQuote(data)
      setEditing(false)
      // Keep the lawn size on the property in sync (it's a core attribute, not just
      // quote data). New/unchanged → silent; a CHANGED size replaces it non-blockingly
      // with a quick Undo (no up-front confirm).
      const measuredSqft = Number(values.measured_sqft) || 0
      if (propertyId && measuredSqft > 0) {
        const { data: prop } = await supabase.from('properties').select('lawn_sqft').eq('id', propertyId).maybeSingle()
        const prior = Number((prop as { lawn_sqft: number | null } | null)?.lawn_sqft) || 0
        const changed = Math.round(prior) !== Math.round(measuredSqft)
        if (changed) {
          await supabase.from('properties').update({ lawn_sqft: measuredSqft }).eq('id', propertyId)
          if (prior > 0) {
            const priorLawn = (prop as { lawn_sqft: number | null } | null)?.lawn_sqft ?? null
            toast.undo(`Saved lawn size updated to ${measuredSqft.toLocaleString()} ft²`, async () => {
              await supabase.from('properties').update({ lawn_sqft: priorLawn }).eq('id', propertyId)
            })
          }
        }
      }
    } else if (error) {
      toast.error('Could not update quote: ' + error.message)
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
      toast.error('Could not generate the PDF. Please try again.')
    } finally {
      setPdfLoading(false)
    }
  }

  // One tap to "send": hand the PDF to the device AND mark the quote sent
  // (stamping sent_at arms the follow-up clock) — instead of two separate steps.
  async function handleSendQuote() {
    if (!quote) return
    await handleOpenPdf()
    if (quote.status === 'draft') {
      const nowIso = new Date().toISOString()
      await supabase.from('quotes').update({ status: 'sent' }).eq('id', quote.id)
      await supabase.from('quotes').update({ sent_at: nowIso }).eq('id', quote.id).is('sent_at', null)
      setQuote({ ...quote, status: 'sent', sent_at: quote.sent_at ?? nowIso })
    }
  }

  async function handleScheduleJob(dateOverride?: string) {
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
        scheduled_date: dateOverride || localToday(),
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

      // INV-#### from the highest existing number — count-based numbering
      // reissues a number after any delete (duplicate customer-facing docs).
      const { data: nums } = await supabase
        .from('invoices')
        .select('invoice_number')
        .eq('user_id', user!.id)
      const invoiceNumber = `INV-${String(maxNumericSuffix(((nums as { invoice_number: string }[]) || []).map(n => n.invoice_number)) + 1).padStart(4, '0')}`

      // Local dates — UTC stamping dates evening invoices tomorrow.
      const issued = localTodayISO()
      const dueISO = formatDfn(addDays(parseISO(issued), 14), 'yyyy-MM-dd')

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
        issued_date: issued,
        due_date: dueISO,
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

  async function handleDuplicate() {
    if (!quote) return
    setDuplicating(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: qnums } = await supabase
        .from('quotes')
        .select('quote_number')
        .eq('user_id', user!.id)
      const quote_number = generateQuoteNumber(maxNumericSuffix(((qnums as { quote_number: string }[]) || []).map(n => n.quote_number)) + 1)

      const { data, error } = await supabase.from('quotes').insert({
        quote_number,
        customer_id: quote.customer_id,
        customer_name: quote.customer_name,
        address: quote.address,
        service_type: quote.service_type,
        service_template_id: quote.service_template_id,
        initial_price: quote.initial_price,
        weekly_price: quote.weekly_price,
        biweekly_price: quote.biweekly_price,
        monthly_price: quote.monthly_price,
        overgrowth_multiplier: quote.overgrowth_multiplier,
        custom_travel_required: quote.custom_travel_required,
        show_travel_separately: quote.show_travel_separately,
        notes: quote.notes,
        hours: quote.hours,
        crew_size: quote.crew_size,
        rate: quote.rate,
        travel_fee: quote.travel_fee,
        property_id: quote.property_id,
        // Carry measurement provenance so a duplicate keeps its breakdown/analysis.
        measured_sqft: quote.measured_sqft,
        suggested_price: quote.suggested_price,
        front_lawn_sqft: quote.front_lawn_sqft,
        back_lawn_sqft: quote.back_lawn_sqft,
        left_side_sqft: quote.left_side_sqft,
        right_side_sqft: quote.right_side_sqft,
        boulevard_sqft: quote.boulevard_sqft,
        other_sqft: quote.other_sqft,
        travel_distance_km: quote.travel_distance_km,
        pricing_confidence: quote.pricing_confidence,
        issued_date: localTodayISO(),
        status: 'draft',
        user_id: user!.id,
      }).select().single()

      if (!error && data) {
        try { window.sessionStorage.setItem('eq_quote_dup_from', quote.quote_number) } catch { /* ignore */ }
        router.push(`/dashboard/quotes/${data.id}`)
      } else if (error) {
        toast.error('Could not duplicate quote: ' + error.message)
        setDuplicating(false)
      }
    } catch {
      toast.error('Could not duplicate quote. Please try again.')
      setDuplicating(false)
    }
  }

  // One guard for the follow-up / won / lost actions so a double-tap can't double
  // a follow-up count or fire the status change twice.
  const [actionBusy, setActionBusy] = useState(false)
  async function logFollowUp() {
    if (!quote || actionBusy) return
    setActionBusy(true)
    try {
      const patch = logFollowUpPatch(quote)
      await supabase.from('quotes').update(patch).eq('id', quote.id)
      setQuote({ ...quote, ...patch })
    } finally { setActionBusy(false) }
  }

  async function markWon() {
    if (!quote || actionBusy) return
    setActionBusy(true)
    try {
      const patch = markWonPatch(quote.follow_up_count)
      await supabase.from('quotes').update(patch).eq('id', quote.id)
      setQuote({ ...quote, ...patch })   // status → accepted; the persistent banner shows automatically
    } finally { setActionBusy(false) }
  }

  async function markLost() {
    if (!quote || actionBusy) return
    setActionBusy(true)
    try {
      await supabase.from('quotes').update({ status: 'declined' }).eq('id', quote.id)
      setQuote({ ...quote, status: 'declined' })
    } finally { setActionBusy(false) }
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Loading quote…</div>
  if (!quote) return <div className="text-center py-16 text-sm text-red-400">Quote not found.</div>

  const customerPhone = customers.find(c => c.id === quote.customer_id)?.phone || null
  const canInvoice = quote.status === 'accepted' || quote.status === 'scheduled' || quote.status === 'completed'

  // Measurement provenance + pricing analysis (suggested vs. actual).
  const measSections = [
    { label: 'Front Lawn', v: quote.front_lawn_sqft },
    { label: 'Back Lawn', v: quote.back_lawn_sqft },
    { label: 'Left Side', v: quote.left_side_sqft },
    { label: 'Right Side', v: quote.right_side_sqft },
    { label: 'Boulevard', v: quote.boulevard_sqft },
    { label: 'Other', v: quote.other_sqft },
  ].filter(s => s.v != null && Number(s.v) > 0)
  const hasMeasurement = (quote.measured_sqft != null && Number(quote.measured_sqft) > 0) || measSections.length > 0
  const suggestedPrice = quote.suggested_price != null ? Number(quote.suggested_price) : null
  const actualPrice = Number(quote.total)
  const priceDiff = suggestedPrice != null ? actualPrice - suggestedPrice : null

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
          initial_price: quote.initial_price || 0,
          weekly_price: quote.weekly_price || 0,
          biweekly_price: quote.biweekly_price || 0,
          monthly_price: quote.monthly_price || 0,
          measured_sqft: quote.measured_sqft || 0,
          suggested_price: quote.suggested_price || 0,
          overgrowth_multiplier: 1,
          distance_km: 0,
          hours: quote.hours,
          crew_size: quote.crew_size,
          rate: quote.rate,
          travel_fee: quote.travel_fee,
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
      {/* Responsive header: title + actions on one row on desktop (lg); on
          tablet/mobile the action toolbar wraps onto its own row beneath the
          quote number, which stays min-w-0/break-words so it's never covered. */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <button onClick={() => router.back()} className="mt-1 shrink-0 text-ink-muted hover:text-ink transition-colors" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-ink tracking-tight break-words">{quote.quote_number}</h1>
            <p className="text-sm text-ink-muted mt-0.5">Created {formatDate(quote.created_at)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end lg:shrink-0">
          {/* Primary deliver action — leads the row */}
          {quote.status === 'draft' ? (
            <Button onClick={handleSendQuote} size="sm" loading={pdfLoading}>
              <Send className="w-3.5 h-3.5" /> PDF &amp; mark sent
            </Button>
          ) : (
            <Button onClick={handleOpenPdf} size="sm" loading={pdfLoading}>
              <FileDown className="w-3.5 h-3.5" /> Open PDF
            </Button>
          )}
          <QuoteStatusControl
            key={quote.status}
            quoteId={quote.id}
            status={quote.status}
            onChanged={(s) => {
              setQuote(prev => prev ? { ...prev, status: s } : prev)
            }}
          />
          {/* Accepted quotes schedule via the persistent banner below; the toolbar
              action is for already-scheduled quotes (book another visit). */}
          {quote.status === 'scheduled' && (
            <Button onClick={() => handleScheduleJob()} variant="secondary" size="sm" loading={scheduling}>
              <CalendarPlus className="w-3.5 h-3.5" /> Schedule Job
            </Button>
          )}
          {canInvoice && (
            <Button onClick={handleConvertToInvoice} variant="secondary" size="sm" loading={converting}>
              <FileText className="w-3.5 h-3.5" /> Convert to Invoice
            </Button>
          )}
          <Button onClick={() => setEditing(true)} variant="ghost" size="sm">
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button onClick={handleDuplicate} variant="ghost" size="sm" loading={duplicating}>
            <Copy className="w-3.5 h-3.5" /> Duplicate
          </Button>
        </div>
      </div>

      {/* Send this quote to the customer (SMS / Email / Both) */}
      {quote.customer_id && (
        <Card>
          <CardBody className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Send this quote to the customer</p>
              <p className="text-xs text-ink-muted mt-0.5">Texts/emails a personalized message with a link to view &amp; accept it in their portal.</p>
            </div>
            <SendComms customerId={quote.customer_id} template="quote" label="Send quote" />
          </CardBody>
        </Card>
      )}

      {savedCustomerMsg && (
        <div className="flex items-center justify-between gap-3 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
          <span className="flex items-center gap-2 text-emerald-300">
            <Check className="w-4 h-4 shrink-0" /> {savedCustomerMsg}
          </span>
          <button onClick={() => setSavedCustomerMsg(null)} className="text-ink-faint hover:text-ink shrink-0">✕</button>
        </div>
      )}

      {dupMsg && (
        <div className="flex items-center justify-between gap-3 text-sm bg-accent/10 border border-accent/20 rounded-xl px-4 py-3">
          <span className="flex items-center gap-2 text-ink"><Copy className="w-4 h-4 shrink-0 text-accent" /> {dupMsg}</span>
          <button onClick={() => setDupMsg(null)} className="text-ink-faint hover:text-ink shrink-0">✕</button>
        </div>
      )}

      {/* Persistent reminder — stays until the job is actually scheduled (status
          leaves "accepted"), so the next step is never lost by dismissing a prompt. */}
      {quote.status === 'accepted' && (
        <div className="flex items-center justify-between flex-wrap gap-3 text-sm bg-accent/10 border border-accent/20 rounded-xl px-4 py-3">
          <span className="text-ink font-medium flex items-center gap-2">
            <CalendarPlus className="w-4 h-4 shrink-0 text-accent" /> Accepted — this job isn’t scheduled yet.
          </span>
          {/* One click opens the scheduler with everything prefilled — customer,
              property, service, price, recurring cadence, learned visit length and a
              suggested start time. Just pick the day. */}
          <Button size="sm" onClick={() => router.push(`/dashboard/schedule?quote=${quote.id}`)}>
            <CalendarPlus className="w-3.5 h-3.5" /> Schedule this job
          </Button>
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

      {quote.status === 'sent' && (
        <Card className={needsFollowUp(quote) ? 'border-amber-500/40' : ''}>
          <CardBody>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                <Bell className="w-5 h-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-ink">
                    {quote.sent_at ? `Sent ${daysSince(quote.sent_at)} day${daysSince(quote.sent_at) !== 1 ? 's' : ''} ago` : 'Not yet marked as sent'}
                  </p>
                  {needsFollowUp(quote) && (
                    <span className="text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 font-semibold">Needs Follow-Up</span>
                  )}
                </div>
                <p className="text-xs text-ink-muted mt-0.5">
                  {quote.follow_up_count > 0 ? `${quote.follow_up_count} follow-up${quote.follow_up_count !== 1 ? 's' : ''} logged` : 'No follow-ups logged yet'}
                  {quote.last_followed_up_at && <> · last {daysSince(quote.last_followed_up_at)}d ago</>}
                </p>
              </div>
            </div>

            {/* One-tap recovery actions — large targets for mobile */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
              <a
                href={customerPhone ? `tel:${customerPhone}` : undefined}
                aria-disabled={!customerPhone}
                className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${customerPhone ? 'bg-accent/10 border-accent/20 text-accent hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
              >
                <Phone className="w-4 h-4" /> Call
              </a>
              <a
                href={customerPhone ? `sms:${customerPhone}` : undefined}
                aria-disabled={!customerPhone}
                className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${customerPhone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
              >
                <MessageSquare className="w-4 h-4" /> Text
              </a>
              <button
                onClick={logFollowUp}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                <RotateCw className="w-4 h-4" /> Followed up
              </button>
              <button
                onClick={markWon}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                <Check className="w-4 h-4" /> Won
              </button>
              <button
                onClick={markLost}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink-muted hover:text-red-400 transition-colors col-span-2 sm:col-span-1 disabled:opacity-50 disabled:pointer-events-none"
              >
                <X className="w-4 h-4" /> Lost
              </button>
            </div>
          </CardBody>
        </Card>
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
            {quote.measured_sqft ? (
              <div>
                <p className="text-xs text-ink-faint uppercase tracking-wide font-semibold mb-1">Lawn Size</p>
                <p className="text-ink font-medium">{Number(quote.measured_sqft).toLocaleString()} ft²</p>
              </div>
            ) : null}
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
            <div className="flex justify-between text-sm">
              <span className="text-ink-muted">Initial / first visit</span>
              <span className="text-ink font-medium">{formatCurrency(quote.initial_price ?? quote.subtotal)}</span>
            </div>
            {quote.travel_fee > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-ink-muted">Travel Fee {quote.show_travel_separately ? '(shown to customer)' : '(in total)'}</span>
                <span className="text-ink font-medium">{formatCurrency(quote.travel_fee)}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-2 border-t border-border">
              <span className="text-sm font-semibold text-ink">First Invoice Total</span>
              <span className="text-3xl font-bold text-accent">{formatCurrency(quote.total)}</span>
            </div>
            {(quote.weekly_price || quote.biweekly_price || quote.monthly_price) ? (
              <div className="pt-3 border-t border-border space-y-1.5">
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Ongoing maintenance options</p>
                {quote.weekly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium">{formatCurrency(quote.weekly_price)}/visit</span></div>
                ) : null}
                {quote.biweekly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium">{formatCurrency(quote.biweekly_price)}/visit</span></div>
                ) : null}
                {quote.monthly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium">{formatCurrency(quote.monthly_price)}/visit</span></div>
                ) : null}
              </div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* Measurements + pricing analysis — handy when reviewing pricing later */}
      {(hasMeasurement || suggestedPrice != null) && (
        <Card>
          <CardBody className="space-y-4">
            {hasMeasurement && (
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Measurements</p>
                <div className="space-y-1.5">
                  {measSections.map(s => (
                    <div key={s.label} className="flex justify-between text-sm">
                      <span className="text-ink-muted">{s.label}</span>
                      <span className="text-ink font-medium">{Number(s.v).toLocaleString()} sq ft</span>
                    </div>
                  ))}
                  {quote.measured_sqft != null && Number(quote.measured_sqft) > 0 && (
                    <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                      <span className="text-sm font-semibold text-ink">Total</span>
                      <span className="text-ink font-bold">{Number(quote.measured_sqft).toLocaleString()} sq ft</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {suggestedPrice != null && (
              <div className={hasMeasurement ? 'pt-4 border-t border-border' : ''}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Pricing analysis</p>
                  {quote.pricing_confidence && CONFIDENCE_COLORS[quote.pricing_confidence] && (
                    <span className={`inline-flex items-center text-[10px] font-semibold border rounded-full px-2 py-0.5 ${CONFIDENCE_COLORS[quote.pricing_confidence]}`}>
                      {CONFIDENCE_LABELS[quote.pricing_confidence]}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Suggested price</span>
                    <span className="text-ink font-medium">{formatCurrency(suggestedPrice)}</span>
                  </div>
                  {/* "Actual quote price" row removed — it just repeated the First Invoice
                      Total shown prominently above; the difference below conveys the rest. */}
                  {priceDiff != null && (
                    <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                      <span className="text-ink-muted">Your price vs suggested</span>
                      <span className={`font-semibold ${priceDiff >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {priceDiff >= 0 ? '+' : '−'}{formatCurrency(Math.abs(priceDiff))}
                        <span className="text-ink-faint font-normal"> {priceDiff >= 0 ? 'above' : 'below'} suggested</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  )
}