'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Quote, Customer, QuoteFormValues, QuoteService, ServiceTemplate, TravelFeeTier, BusinessSettings, CONFIDENCE_LABELS, STATUS_LABELS } from '@/types'
import { sumServiceLines, serviceLineTotals, splitServices } from '@/lib/quoteServices'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { extractBookingPhotos, bookingPhotoViews } from '@/lib/bookingPhotos'
import { PageHeader } from '@/components/layout/PageHeader'
import { DetailHeader } from '@/components/layout/DetailHeader'
import { Banner } from '@/components/ui/Banner'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { QuoteIntelligencePanel } from '@/components/quotes/QuoteIntelligencePanel'
import { formatCurrency, formatDate, applyOvergrowth, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { nextInvoiceNumber } from '@/lib/invoicing'
import { isQuoteExpired, isExpiringSoon, daysUntilExpiry, defaultValidUntil, markSentPatch, sendBlockedReason, sendBlockedLabel, DEFAULT_QUOTE_VALID_DAYS } from '@/lib/quoteStatus'
import { toast } from '@/lib/toast'
import { addDays, format as formatDfn, parseISO } from 'date-fns'
import { needsFollowUp, daysSince, logFollowUpPatch, markWonPatch } from '@/lib/followup'
import { scheduleQuoteAsJob } from '@/lib/scheduleQuote'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { Edit2, FileDown, CalendarPlus, FileText, Copy, Bell, Phone, MessageSquare, RotateCw, Check, X, Send, Camera, Globe, CalendarClock } from 'lucide-react'

export default function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [quote, setQuote] = useState<Quote | null>(null)
  // Multi-service breakdown (quote_services). Empty = legacy single-service quote.
  const [services, setServices] = useState<QuoteService[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [converting, setConverting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [extending, setExtending] = useState(false)
  const [showMessage, setShowMessage] = useState(false)
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
      const matchedByLabel: Record<string, string> = { phone: 'phone number', email: 'email address', address: 'address' }
      setSavedCustomerMsg(
        m.created
          ? `New customer ${m.name} and their property were created and linked to this quote.`
          : m.matchedBy
            ? `Linked to existing customer ${m.name} (matched by ${matchedByLabel[m.matchedBy] || m.matchedBy}) — no duplicate created.`
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
      // Local session read — no auth round-trip before the batch below.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      const [qRes, svcRes, cRes, tRes, tierRes, sRes] = await Promise.all([
        supabase.from('quotes').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('quote_services').select('*').eq('quote_id', id).order('sort_order'),
        supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — archived hidden from the picker
        supabase.from('service_templates').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('travel_fee_tiers').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
      ])
      setQuote(qRes.data)
      setServices((svcRes.data as QuoteService[]) || []) // error/absent table → [] (legacy)
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

    // Multi-service: initial_price = primary + Σ additional line nets so the
    // generated quotes.total stays correct. (Edit saves as-entered — fee recovery
    // was baked in at creation, same as the single-service field.)
    const extraLines = (values.services || []).filter(s => s.service_type.trim())
    const extrasNet = sumServiceLines(extraLines).net
    const initialWithExtras = (Number(values.initial_price) > 0 ? Number(values.initial_price) : 0) + extrasNet

    const { data, error } = await supabase
      .from('quotes')
      .update({
        customer_id: customerId,
        customer_name: customerName,
        property_id: propertyId,
        address: values.address,
        service_type: values.service_type,
        service_template_id: values.service_template_id || null,
        initial_price: initialWithExtras > 0 ? initialWithExtras : null,
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
      // Replace the service breakdown atomically-enough for a single owner:
      // clear + reinsert (rows exist ONLY for multi-service quotes).
      const { data: { user: u2 } } = await supabase.auth.getUser()
      await supabase.from('quote_services').delete().eq('quote_id', id)
      if (extraLines.length && u2) {
        const { data: rows } = await supabase.from('quote_services').insert([
          {
            user_id: u2.id, quote_id: id, sort_order: 0,
            service_type: values.service_type, service_template_id: values.service_template_id || null,
            quantity: 1, unit: 'each', unit_price: Number(values.initial_price) || 0,
            est_minutes: Math.round(Number(values.hours) * 60) || null,
          },
          ...extraLines.map((s, i) => ({
            user_id: u2.id, quote_id: id, sort_order: i + 1,
            service_type: s.service_type.trim(), service_template_id: s.service_template_id || null,
            quantity: Number(s.quantity) > 0 ? Number(s.quantity) : 1,
            unit: s.unit || 'each', unit_price: Number(s.unit_price) || 0,
            est_minutes: Number(s.est_minutes) > 0 ? Math.round(Number(s.est_minutes)) : null,
            discount_type: s.discount_type || null,
            discount_value: s.discount_type && Number(s.discount_value) > 0 ? Number(s.discount_value) : null,
            notes: s.notes?.trim() || null,
            // The line KIND is what makes a material a material. This save path
            // DELETEs every line and re-inserts, so omitting it here would demote
            // every material to a service the first time a quote was edited.
            kind: s.kind || 'service',
          })),
        ]).select('*')
        setServices((rows as QuoteService[]) || [])
      } else {
        setServices([])
      }
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

 // Returns TRUE only when the PDF actually reached the device — the caller gates the
 // "mark sent" write on it, so a failed render can never flip the quote to Sent.
 async function handleOpenPdf(): Promise<boolean> {
    if (!quote) return false
    setPdfLoading(true)
    try {
      const { renderQuoteBlob } = await import('@/components/quotes/QuotePDF')
      const blob = await renderQuoteBlob(quote, settings, services)
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
      return true
    } catch {
      toast.error('Could not generate the PDF. Please try again.')
      return false
    } finally {
      setPdfLoading(false)
    }
  }

  // Extending is the honest counterpart to expiry: the owner decides the old price
  // still stands, and the quote re-enters the follow-up queue by itself (the cron
  // reads the same lib/quoteStatus overlay). Dated from TODAY, not from the lapsed
  // date, so "extend 30 days" means 30 days from now.
  async function extendValidity(days: number) {
    if (!quote) return
    setExtending(true)
    const validUntil = defaultValidUntil(localTodayISO(), days)
    const { error } = await supabase.from('quotes').update({ valid_until: validUntil }).eq('id', quote.id)
    setExtending(false)
    if (error) { toast.error('Could not extend the quote: ' + error.message); return }
    setQuote({ ...quote, valid_until: validUntil })
    toast.success(`${quote.quote_number} now stands until ${formatDate(validUntil)}.`)
  }

  // One tap to "send": hand the PDF to the device AND mark the quote sent
  // (stamping sent_at arms the follow-up clock) — instead of two separate steps.
  async function handleSendQuote() {
    if (!quote) return
    // A document with no price is broken whoever receives it — and until
    // RUN-2026-07-16e the DB hid that by inventing hours × crew_size × rate. Blocked
    // BEFORE the PDF renders: a $0.00 quote on your phone is one tap from a customer.
    //
    // Only the price blocks here, deliberately. This hands the PDF to YOUR device, so
    // a quote with no customer linked is a real thing to do — a walk-up you price at
    // the door. Delivery is where a customer becomes mandatory, and that's guarded at
    // the composer below.
    if (sendBlockedReason(quote) === 'no_price') {
      toast.error(sendBlockedLabel('no_price'))
      return
    }
    const delivered = await handleOpenPdf()
    if (!delivered) return   // PDF failed → never claim (or record) that it was sent
    if (quote.status === 'draft') {
      // ONE patch, ONE write. This was three updates — and it was the only one of the
      // app's four "mark sent" paths that wrote all three fields, which is why the
      // other three left 0 of 55 quotes able to expire. markSentPatch omits rather
      // than overwrites, so a deliberately-set expiry still survives.
      const patch = markSentPatch(quote, localTodayISO())
      await supabase.from('quotes').update(patch).eq('id', quote.id)
      setQuote({ ...quote, ...patch } as typeof quote)
      // Be honest about what just happened: the PDF is on YOUR device, and the
      // customer still hasn't heard from you.
      toast(`${quote.quote_number} marked as sent — the PDF is on your device. The customer hasn’t been messaged yet.`, {
        tone: 'success',
        action: quote.customer_id ? { label: 'Send it to them', run: () => setShowMessage(true) } : undefined,
      })
    }
  }

  async function handleScheduleJob(dateOverride?: string) {
    if (!quote) return
    setScheduling(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      // THE quote→job engine (lib/scheduleQuote) — same job here as from the
      // dashboard's "Accepted — not yet scheduled" card.
      const { error } = await scheduleQuoteAsJob(supabase, user!.id, quote, { date: dateOverride, services })
      if (error) {
        toast.error('Could not create job: ' + error)
      } else {
        if (quote.status === 'accepted') setQuote({ ...quote, status: 'scheduled' })
        // Say exactly where the job landed (TODAY's route until moved) and offer
        // one tap to it — crew/notes/time tweaks usually happen immediately.
        toast('Job added to today’s schedule.', {
          tone: 'success',
          action: { label: 'View job', run: () => router.push('/dashboard/schedule') },
        })
      }
    } catch {
      toast.error('Could not create job. Please try again.')
    } finally {
      setScheduling(false)
    }
  }

  async function handleConvertToInvoice() {
    if (!quote) return
    // A $0 invoice can never be paid — it would sit stuck until cancelled.
    if (!(Number(quote.total) > 0)) { toast.error('Set a price on this quote before invoicing it.'); return }
    setConverting(true)
    // One invoice per quote — the completed-job auto-draft stamps quote_id too, so
    // this catches BOTH a prior manual convert and an auto-draft. Without it,
    // Convert after job completion double-billed the same work.
    {
      const { data: dup } = await supabase.from('invoices').select('invoice_number').eq('quote_id', quote.id).limit(1)
      if (dup && dup.length > 0) {
        toast.error(`This quote is already invoiced (${(dup[0] as { invoice_number: string }).invoice_number}) — edit that invoice instead of creating a duplicate.`)
        setConverting(false)
        return
      }
    }
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Don't double-convert
      const { data: existing } = await supabase
        .from('invoices')
        .select('id')
        .eq('quote_id', quote.id)
        .limit(1)
      if (existing && existing.length > 0) {
        toast.error('An invoice already exists for this quote.')
        setConverting(false)
        return
      }

      // ONE numbering engine — shared with the auto-draft and manual creation.
      const invoiceNumber = await nextInvoiceNumber(supabase, user!.id)

      // Local dates — UTC stamping dates evening invoices tomorrow.
      const issued = localTodayISO()
      const dueISO = formatDfn(addDays(parseISO(issued), 14), 'yyyy-MM-dd')

      // Multi-service: carry the full breakdown onto the invoice as line_items
      // (the invoices jsonb snapshot shape), so the customer sees every service.
      // amount stays quote.total — already the summed net + travel.
      const lineItems = services.length
        ? [
            ...services.map(s => ({
              description: s.quantity > 1 ? `${s.service_type} × ${s.quantity}` : s.service_type,
              amount: serviceLineTotals(s).net,
              kind: 'service' as const,
            })),
            ...(Number(quote.travel_fee) > 0 ? [{ description: 'Travel', amount: Number(quote.travel_fee), kind: 'travel' as const }] : []),
          ]
        : null
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
        line_items: lineItems,
        status: 'unpaid',
        issued_date: issued,
        due_date: dueISO,
        notes: quote.notes,
      })

      if (error) {
        toast.error('Could not create invoice: ' + error.message)
      } else {
        toast(`Invoice ${invoiceNumber} created.`, {
          tone: 'success',
          action: { label: 'View invoice', run: () => router.push(`/dashboard/invoices?invoice=${encodeURIComponent(invoiceNumber)}`) },
        })
      }
    } catch {
      toast.error('Could not create invoice. Please try again.')
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
        // Copy the multi-service breakdown onto the duplicate.
        if (services.length) {
          await supabase.from('quote_services').insert(services.map(s => ({
            user_id: user!.id, quote_id: data.id, sort_order: s.sort_order,
            service_type: s.service_type, service_template_id: s.service_template_id,
            quantity: s.quantity, unit: s.unit, unit_price: s.unit_price,
            est_minutes: s.est_minutes, discount_type: s.discount_type,
            discount_value: s.discount_value, notes: s.notes,
            // Without this the duplicate silently demotes every material back to
            // a service — the copy would stop matching the quote it came from.
            kind: s.kind ?? 'service',
          })))
        }
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
      toast.success('Follow-up logged — we’ll flag this quote again in 3 days.')
    } finally { setActionBusy(false) }
  }

  async function markWon() {
    if (!quote || actionBusy) return
    setActionBusy(true)
    try {
      // Snapshot what was bought (Pricing v2 Phase 0). `total` is the number on the
      // document the customer said yes to — copying it here is what makes it
      // survivable when the quote is later edited. The cadence is deliberately NOT
      // passed: this button says "they said yes", not "they said yes to weekly", and
      // the app must not invent a distinction the owner never made. It becomes known
      // when the job is scheduled against a recurrence.
      const patch = markWonPatch(quote.follow_up_count, {
        acceptedPrice: Number(quote.total) || null,
        selectedCadence: null,
      })
      await supabase.from('quotes').update(patch).eq('id', quote.id)
      setQuote({ ...quote, ...patch })   // status → accepted; the persistent banner shows automatically
      toast.success('Marked as won — schedule the job to lock it in.')
    } finally { setActionBusy(false) }
  }

  async function markLost() {
    if (!quote || actionBusy) return
    const prev = quote.status
    setActionBusy(true)
    try {
      await supabase.from('quotes').update({ status: 'declined' }).eq('id', quote.id)
      setQuote({ ...quote, status: 'declined' })
      // Lost sits one tap from Won and hides the card holding both — always offer the
      // way back (same undo idiom as every other destructive action here).
      toast.undo('Marked as lost.', async () => {
        const { error } = await supabase.from('quotes').update({ status: prev }).eq('id', quote.id)
        if (error) { toast.error('Could not restore the quote: ' + error.message); return }
        setQuote(q => q ? { ...q, status: prev } : q)
      })
    } finally { setActionBusy(false) }
  }

  if (loading) return <div className="max-w-5xl mx-auto"><SkeletonRows count={6} /></div>
  if (!quote) return <div className="text-center py-16 text-sm text-red-400">Quote not found.</div>

  const customerPhone = customers.find(c => c.id === quote.customer_id)?.phone || null
  const canInvoice = quote.status === 'accepted' || quote.status === 'scheduled' || quote.status === 'completed'

  // Surface the quote's state in the header itself — a sent quote reads "Sent 3
  // days ago" (the follow-up clock), everything else the plain status label.
  const sentDays = quote.sent_at ? daysSince(quote.sent_at) : null
  const statusPhrase = quote.status === 'sent' && sentDays != null
    ? `Sent ${sentDays} day${sentDays !== 1 ? 's' : ''} ago`
    : STATUS_LABELS[quote.status]

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

  // Multi-service edit: quotes.initial_price stores the SUMMED net, so decompose
  // it back into the builder's shape — primary price from row 0, extras from rows
  // 1+. Legacy quotes (no rows) load exactly as before.
  const { primary: primaryLine, extras: extraServiceRows } = splitServices(services)

  if (editing) return (
    <div className="max-w-5xl mx-auto space-y-6">
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
          initial_price: primaryLine ? primaryLine.unit_price : (quote.initial_price || 0),
          services: extraServiceRows.map(s => ({
            service_type: s.service_type,
            service_template_id: s.service_template_id || '',
            quantity: s.quantity,
            unit: s.unit || 'each',
            unit_price: s.unit_price,
            est_minutes: s.est_minutes || 0,
            // Carry the line's kind through the edit round-trip. Defaulting to
            // 'service' here would silently turn a saved material back into a
            // service the first time the quote was opened and re-saved.
            kind: s.kind ?? 'service',
            discount_type: (s.discount_type || '') as '' | 'amount' | 'percent',
            discount_value: s.discount_value || 0,
            notes: s.notes || '',
          })),
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
        autosaveKey={`quote:${quote.id}`}
        autosaveBaselineUpdatedAt={quote.updated_at}
      />
    </div>
  )

  return (
    // Match the edit view's width so toggling Edit never reflows the page.
    <div className="max-w-5xl mx-auto space-y-6">
      {/* THE shared DetailHeader — back + truncating title + action toolbar,
          the same anatomy as every other detail page. */}
      <DetailHeader
        title={quote.quote_number}
        description={`${statusPhrase} · Created ${formatDate(quote.created_at)}`}
        action={
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {/* Owner-side PDF action. Honest label: this downloads the PDF to YOUR
              device and flips the status — it does NOT message the customer (the
              Send card below does that, and is the primary action for drafts). */}
          {quote.status === 'draft' ? (
            <Button onClick={handleSendQuote} size="sm" variant={quote.customer_id ? 'secondary' : 'primary'} loading={pdfLoading}>
              <FileDown className="w-3.5 h-3.5" /> Download PDF
            </Button>
          ) : (
            <Button onClick={handleOpenPdf} variant="secondary" size="sm" loading={pdfLoading}>
              <FileDown className="w-3.5 h-3.5" /> Open PDF
            </Button>
          )}
          <QuoteStatusControl
            key={quote.status}
            quoteId={quote.id}
            status={quote.status}
            // Without these the shared patches can't do their job: followUpCount was
            // missing entirely (so flipping to Accepted here recorded no follow-up
            // attribution), and the stamps let markSentPatch leave a deliberate expiry
            // alone instead of overwriting it.
            followUpCount={quote.follow_up_count}
            sentAt={quote.sent_at}
            validUntil={quote.valid_until}
            total={quote.total}
            onChanged={(s) => {
              setQuote(prev => prev ? { ...prev, status: s } : prev)
            }}
          />
          {/* Accepted quotes schedule via the persistent banner below; the toolbar
              action is for already-scheduled quotes (book another visit). */}
          {quote.status === 'scheduled' && (
            <Button onClick={() => handleScheduleJob()} variant="secondary" size="sm" loading={scheduling}>
              <CalendarPlus className="w-3.5 h-3.5" /> Book another visit
            </Button>
          )}
          {canInvoice && (
            // Completed = converting is THE stage action, so it takes the one
            // primary slot; other stages have their own primary elsewhere.
            <Button onClick={handleConvertToInvoice} variant={quote.status === 'completed' ? 'primary' : 'secondary'} size="sm" loading={converting}>
              <FileText className="w-3.5 h-3.5" /> Convert to invoice
            </Button>
          )}
          <Button onClick={() => setEditing(true)} variant="ghost" size="sm">
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </Button>
          <Button onClick={handleDuplicate} variant="ghost" size="sm" loading={duplicating} aria-label="Duplicate quote" title="Duplicate quote">
            <Copy className="w-4 h-4" />
          </Button>
        </div>
        }
      />

      {/* One-shot confirmations from the create/duplicate flow — greet the owner at
          the top (was buried below the send card), then dismiss. */}
      {savedCustomerMsg && (
        <Banner tone="success" icon={Check} onDismiss={() => setSavedCustomerMsg(null)}>{savedCustomerMsg}</Banner>
      )}
      {dupMsg && (
        <Banner tone="accent" icon={Copy} onDismiss={() => setDupMsg(null)}>{dupMsg}</Banner>
      )}
      {/* This draft was created by a customer's online booking — frame it as a review,
          not something the owner authored. */}
      {quote.status === 'draft' && !!(quote as { lead_meta?: unknown }).lead_meta && (
        <Banner tone="accent" icon={Globe}>
          <span className="font-semibold text-ink">Customer booking — review this draft.</span> {(quote.customer_name || 'A customer').split(' ')[0]} requested this online. Check the price, then send it for approval.
        </Banner>
      )}

      {/* Photos the customer attached when booking this quote (lead_meta.photos) —
          shown read-only through the shared gallery/lightbox so the owner reviews
          exactly what the customer sent. */}
      {(() => {
        const photos = bookingPhotoViews(extractBookingPhotos((quote as { lead_meta?: unknown }).lead_meta), quote.created_at)
        return photos.length > 0 ? (
          <Card>
            <CardBody className="space-y-2">
              <p className="text-sm font-semibold text-ink flex items-center gap-2">
                <Camera className="w-4 h-4 text-accent-text" /> Customer photos
                <span className="ml-auto text-xs font-normal text-ink-faint">{photos.length} attached at booking</span>
              </p>
              <JobPhotos propertyId={null} variant="gallery" readOnly initialPhotos={photos} />
            </CardBody>
          </Card>
        ) : null
      })()}

      {/* Persistent reminder — stays until the job is actually scheduled (status
          leaves "accepted"), so the next step is never lost by dismissing a prompt.
          Rendered ABOVE the send card: once the customer approved, scheduling is
          the next step — not re-sending the quote. */}
      {/* Expiry — the price, not just the paperwork. An expired quote is honoured
          only if the owner chooses to; the automatic chaser has already stopped. */}
      {isQuoteExpired(quote, localTodayISO()) && (
        <Banner tone="warn" icon={CalendarClock}>
          <span className="flex items-center justify-between gap-3 flex-wrap w-full">
            <span>
              This quote expired on <span className="font-semibold">{formatDate(quote.valid_until!)}</span> — follow-ups have stopped. Extend it if you&rsquo;ll still honour the price.
            </span>
            <Button size="sm" variant="secondary" type="button" loading={extending}
              onClick={() => extendValidity(DEFAULT_QUOTE_VALID_DAYS)}>
              Extend {DEFAULT_QUOTE_VALID_DAYS} days
            </Button>
          </span>
        </Banner>
      )}
      {isExpiringSoon(quote, localTodayISO()) && (
        <Banner tone="warn" icon={CalendarClock}>
          {(() => {
            const d = daysUntilExpiry(quote, localTodayISO())!
            return `This quote ${d === 0 ? 'expires today' : `expires in ${d} day${d !== 1 ? 's' : ''}`} (${formatDate(quote.valid_until!)}) — worth a nudge while it still stands.`
          })()}
        </Banner>
      )}

      {quote.status === 'accepted' && (
        <div className="flex items-center justify-between flex-wrap gap-3 text-sm bg-accent/10 border border-accent/20 rounded-xl px-4 py-3">
          <span className="text-ink font-medium flex items-center gap-2">
            <CalendarPlus className="w-4 h-4 shrink-0 text-accent-text" /> Accepted — this job isn’t scheduled yet.
          </span>
          <div className="flex items-center gap-2">
            {/* Honest label — this books the job on TODAY's route (move it after). */}
            <Button size="sm" onClick={() => handleScheduleJob()} loading={scheduling}>
              <CalendarPlus className="w-3.5 h-3.5" /> Schedule for today
            </Button>
            <Button size="sm" variant="ghost" onClick={() => router.push(`/dashboard/schedule?quote=${quote.id}`)}>Pick a day</Button>
          </div>
        </div>
      )}

      {/* Send this quote to the customer — the ONE shared Send Message dialog. */}
      {quote.customer_id && (
        <Card>
          <CardBody className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">
                {quote.status === 'draft' || quote.status === 'sent' ? 'Send this quote to the customer' : 'Resend this quote to the customer'}
              </p>
              <p className="text-xs text-ink-muted mt-0.5">
                {quote.status === 'draft' || quote.status === 'sent'
                  ? <>Texts/emails a personalized message with a link to view &amp; accept it in their portal.</>
                  : <>Texts/emails them a copy with a link to their portal.</>}
              </p>
            </div>
            {/* The REAL send is the primary action while the quote awaits delivery. */}
            <Button variant={quote.status === 'draft' || quote.status === 'sent' ? 'primary' : 'secondary'} onClick={() => setShowMessage(true)}>
              <MessageSquare className="w-4 h-4" /> {quote.status === 'draft' || quote.status === 'sent' ? 'Send quote' : 'Resend quote'}
            </Button>
          </CardBody>
          {/* vars.address is the quote's OWN address — the same string QuotePDF prints,
              so the message and the document it links to name the same place. Deliberately
              NOT the customer's primary property: borrowing that is what made six of a
              landlord's quotes indistinguishable in the portal. */}
          <SendMessageDialog open={showMessage} onClose={() => setShowMessage(false)}
            customerId={quote.customer_id} customerName={quote.customer_name}
            defaultTemplate="quote" vars={{ amount: formatCurrency(quote.total), address: quote.address || undefined }}
            onSent={async () => {
              // Actually delivering the quote IS sending it — and THIS is the path that
              // truly reaches the customer, so it must record the same three facts as
              // every other. Its previous comment claimed it behaved "exactly like the
              // PDF path"; it didn't — it omitted valid_until, so a quote the customer
              // genuinely received could never expire. Now they share one patch, which
              // is the only way that claim can stay true.
              if (quote.status === 'draft') {
                const patch = markSentPatch(quote, localTodayISO())
                await supabase.from('quotes').update(patch).eq('id', quote.id)
                setQuote(prev => prev ? { ...prev, ...patch } as typeof prev : prev)
              }
            }} />
        </Card>
      )}

      {/* Schedule/convert results flow through the ONE toast system — inline
          banners here stacked three deep on a phone before any quote content. */}
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
                className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${customerPhone ? 'bg-accent/10 border-accent/20 text-accent-text hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
              >
                <Phone className="w-4 h-4" /> Call
              </a>
              <a
                href={customerPhone ? `sms:${customerPhone}` : undefined}
                aria-disabled={!customerPhone}
                className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${customerPhone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
              >
                <MessageSquare className="w-4 h-4" /> Text
              </a>
              <button
                onClick={logFollowUp}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <RotateCw className="w-4 h-4" /> Followed up
              </button>
              <button
                onClick={markWon}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Check className="w-4 h-4" /> Won
              </button>
              {/* Lost is the discouraging path — kept quieter (ghost) so the eye
                  lands on Won first. Handler unchanged. */}
              <button
                onClick={markLost}
                disabled={actionBusy}
                className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink transition-colors col-span-2 sm:col-span-1 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X className="w-4 h-4" /> Lost
              </button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <div className="p-6 border-b border-border bg-gradient-to-r from-accent/5 to-transparent">
          <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide mb-1">Customer</p>
          <p className="text-lg font-bold text-ink">{quote.customer_name}</p>
          <p className="text-sm text-ink-muted mt-0.5">{quote.address}</p>
        </div>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Service</p>
              <p className="text-ink font-medium">{quote.service_type}</p>
            </div>
            {quote.measured_sqft ? (
              <div>
                <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Lawn Size</p>
                <p className="text-ink font-medium tabular-nums">{Number(quote.measured_sqft).toLocaleString()} ft²</p>
              </div>
            ) : null}
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Hours</p>
              <p className="text-ink font-medium tabular-nums">{quote.hours} hrs</p>
            </div>
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Crew Size</p>
              <p className="text-ink font-medium tabular-nums">{quote.crew_size} worker{quote.crew_size > 1 ? 's' : ''}</p>
            </div>
            <div>
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Rate</p>
              <p className="text-ink font-medium tabular-nums">{formatCurrency(quote.rate)}/crew hr</p>
            </div>
            {quote.overgrowth_multiplier && quote.overgrowth_multiplier !== 1 && (
              <div>
                <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Overgrowth</p>
                <p className="text-ink font-medium">{quote.overgrowth_multiplier}×</p>
              </div>
            )}
          </div>

          {quote.notes && (
            <div className="pt-3 border-t border-border">
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">Notes</p>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-2">
            {quote.custom_travel_required && (
              <div className="flex items-center gap-2 text-xs text-amber-400 mb-1">Custom travel fee applied (beyond standard tiers)</div>
            )}
            {/* Section label — same treatment as "Measurements" / "Ongoing
                maintenance options" so the breakdown reads as a peer section. */}
            <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">Services</p>
            {services.length > 0 ? (
              // Multi-service breakdown — one row per line (rows are the source of
              // truth; quotes.initial_price is their summed net). Service NAME
              // carries the weight; quantity/discount/notes read as muted sub-notes.
              <div className="space-y-2.5">
                {services.map(s => {
                  const t = serviceLineTotals(s)
                  return (
                    <div key={s.id} className="flex justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <span className="text-ink font-medium">{s.service_type}</span>
                        {Number(s.quantity) > 1 && <span className="text-ink-faint"> × {s.quantity}</span>}
                        {t.discountAmount > 0 && <span className="text-emerald-400 text-xs"> (−{formatCurrency(t.discountAmount)})</span>}
                        {s.notes && <span className="block text-xs text-ink-muted truncate">{s.notes}</span>}
                      </span>
                      <span className="text-ink font-medium shrink-0 tabular-nums">{formatCurrency(t.net)}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex justify-between text-sm">
                <span className="text-ink font-medium">First visit</span>
                <span className="text-ink font-medium tabular-nums">{formatCurrency(quote.initial_price ?? quote.subtotal)}</span>
              </div>
            )}
            {quote.travel_fee > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-ink-muted">Travel Fee {quote.show_travel_separately ? '(shown to customer)' : '(included in total)'}</span>
                <span className="text-ink font-medium tabular-nums">{formatCurrency(quote.travel_fee)}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-2 border-t border-border">
              <span className="text-sm font-semibold text-ink">{(quote.weekly_price || quote.biweekly_price || quote.monthly_price) ? 'First Visit Total' : 'Quote Total'}</span>
              <span className="text-3xl font-bold text-accent-text tabular-nums">{formatCurrency(quote.total)}</span>
            </div>
            {/* Echo the estimate-confidence chip (same treatment as the pricing
                analysis card) so the headline number carries its own credibility
                cue. Absent confidence → nothing. */}
            {quote.pricing_confidence && CONFIDENCE_LABELS[quote.pricing_confidence] && (
              <div className="flex justify-end">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted">
                  <span className={`w-1.5 h-1.5 rounded-full ${quote.pricing_confidence === 'high' ? 'bg-emerald-400' : quote.pricing_confidence === 'medium' ? 'bg-amber-400' : 'bg-ink-faint'}`} />
                  {CONFIDENCE_LABELS[quote.pricing_confidence]}
                </span>
              </div>
            )}
            {(quote.weekly_price || quote.biweekly_price || quote.monthly_price) ? (
              <div className="pt-3 border-t border-border space-y-1.5">
                <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">Ongoing maintenance options</p>
                {quote.weekly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(quote.weekly_price)}/visit</span></div>
                ) : null}
                {quote.biweekly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(quote.biweekly_price)}/visit</span></div>
                ) : null}
                {quote.monthly_price ? (
                  <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(quote.monthly_price)}/visit</span></div>
                ) : null}
              </div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/* Quote Intelligence — the owner's AI second opinion, through THE assist
          engine. Renders nothing when AI isn't configured; advisory only (the
          pricing engine's persisted suggestion stays the authority on price). */}
      <QuoteIntelligencePanel quoteId={quote.id} />

      {/* Measurements + pricing analysis — handy when reviewing pricing later */}
      {(hasMeasurement || suggestedPrice != null) && (
        <Card>
          <CardBody className="space-y-4">
            {hasMeasurement && (
              <div>
                <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide mb-2">Measurements</p>
                <div className="space-y-1.5">
                  {measSections.map(s => (
                    <div key={s.label} className="flex justify-between text-sm">
                      <span className="text-ink-muted">{s.label}</span>
                      <span className="text-ink font-medium tabular-nums">{Number(s.v).toLocaleString()} sq ft</span>
                    </div>
                  ))}
                  {quote.measured_sqft != null && Number(quote.measured_sqft) > 0 && (
                    <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                      <span className="text-sm font-semibold text-ink">Total</span>
                      <span className="text-ink font-bold tabular-nums">{Number(quote.measured_sqft).toLocaleString()} sq ft</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {suggestedPrice != null && (
              <div className={hasMeasurement ? 'pt-4 border-t border-border' : ''}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">Pricing analysis</p>
                  {quote.pricing_confidence && CONFIDENCE_LABELS[quote.pricing_confidence] && (
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted">
                      <span className={`w-1.5 h-1.5 rounded-full ${quote.pricing_confidence === 'high' ? 'bg-emerald-400' : quote.pricing_confidence === 'medium' ? 'bg-amber-400' : 'bg-ink-faint'}`} />
                      {CONFIDENCE_LABELS[quote.pricing_confidence]}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-ink-muted">Suggested price</span>
                    <span className="text-ink font-medium tabular-nums">{formatCurrency(suggestedPrice)}</span>
                  </div>
                  {/* Provenance — a recommendation should always show where it came from. */}
                  <p className="text-[11px] text-ink-faint leading-snug">
                    Based on {hasMeasurement ? 'the measured lawn size' : 'the lawn size'} and your pricing rates{quote.pricing_confidence ? `, weighted by nearby quotes you've won (${CONFIDENCE_LABELS[quote.pricing_confidence]?.toLowerCase() ?? 'estimated'})` : ''}.
                  </p>
                  {/* "Actual quote price" row removed — it just repeated the First Invoice
                      Total shown prominently above; the difference below conveys the rest. */}
                  {priceDiff != null && (
                    <div className="flex justify-between text-sm pt-1.5 border-t border-border">
                      <span className="text-ink-muted">Your price vs suggested</span>
                      <span className={`font-semibold tabular-nums ${priceDiff >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
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