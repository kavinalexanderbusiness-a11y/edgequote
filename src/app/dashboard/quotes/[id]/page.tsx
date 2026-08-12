'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Quote, Customer, QuoteFormValues, QuoteService, QuoteOption, ServiceTemplate, TravelFeeTier, BusinessSettings, CONFIDENCE_LABELS, STATUS_LABELS, PAYMENT_METHODS } from '@/types'
import { sumServiceLines, serviceLineTotals, splitServices, recentTemplateIdsFrom } from '@/lib/quoteServices'
import {
  activeOption, headlineOptionPrice, optionRowsFor, optionValueBasis, optionValueBasisLabel,
  sortedOptions,
} from '@/lib/quoteOptions'
import { QuoteBuilder } from '@/components/quotes/QuoteBuilder'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { extractBookingPhotos, bookingPhotoViews } from '@/lib/bookingPhotos'
import { PageHeader } from '@/components/layout/PageHeader'
import { DetailHeader } from '@/components/layout/DetailHeader'
import { Banner } from '@/components/ui/Banner'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { QuoteIntelligencePanel } from '@/components/quotes/QuoteIntelligencePanel'
import { SaveAsBundleDialog } from '@/components/quotes/SaveAsBundleDialog'
import { formatCurrency, formatDate, applyOvergrowth, generateQuoteNumber, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { nextInvoiceNumber } from '@/lib/invoicing'
import { isQuoteExpired, isExpiringSoon, daysUntilExpiry, defaultValidUntil, markSentPatch, sendBlockedReason, sendBlockedLabel, DEFAULT_QUOTE_VALID_DAYS } from '@/lib/quoteStatus'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { ensureCurrentPricingConfigVersion } from '@/lib/pricingConfig'
import { addDays, format as formatDfn, parseISO } from 'date-fns'
import { needsFollowUp, daysSince, logFollowUpPatch, markWonPatch } from '@/lib/followup'
import { scheduleQuoteAsJob } from '@/lib/scheduleQuote'
import { ensureCustomerAndProperty } from '@/lib/customers'
import { servicePricingKind } from '@/lib/servicePricing'
import { saveManual } from '@/lib/measure/data'
// THE scheduling-deposit gate (lib/payments/depositGate): required/collected/
// outstanding derived from the ledger on every read — the same engine the portal
// and the charge route run, so this page can never disagree with them.
import {
  depositRuleFromForm, gateBlocksScheduling, loadQuoteDepositRows, schedulingGate,
  schedulingPreferenceLine, stampDepositOverride, type GateLedgerRow,
} from '@/lib/payments/depositGate'
import { recordDeposit } from '@/lib/payments/ledger'
import { AlertTriangle, Edit2, FileDown, CalendarPlus, FileText, Copy, Bell, Phone, MessageSquare, RotateCw, Check, X, Camera, Globe, CalendarClock, Layers, Lock, Wallet, CheckCircle2 } from 'lucide-react'
import { AUDIENCE_COPY } from '@/lib/noteScope'

export default function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [quote, setQuote] = useState<Quote | null>(null)
  // Multi-service breakdown (quote_services). Empty = legacy single-service quote.
  const [services, setServices] = useState<QuoteService[]>([])
  // The alternatives (quote_options). Empty on every quote that doesn't offer a
  // choice, which is every quote until an owner turns the switch on. MUTUALLY
  // EXCLUSIVE with `services` — the database refuses a quote holding both.
  const [options, setOptions] = useState<QuoteOption[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templates, setTemplates] = useState<ServiceTemplate[]>([])
  // Same picker, same ranking as the create door — a service list that reorders
  // itself between "new quote" and "edit quote" is two controls wearing one name.
  const [recentTemplateIds, setRecentTemplateIds] = useState<string[]>([])
  const [tiers, setTiers] = useState<TravelFeeTier[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [converting, setConverting] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  // "Save this scope as a bundle" — the one creation door for reusable scopes.
  // Names are held here (not inside the dialog) so the collision check is ready
  // before the dialog opens rather than after a failed save.
  const [showSaveBundle, setShowSaveBundle] = useState(false)
  const [bundleNames, setBundleNames] = useState<string[]>([])
  const [extending, setExtending] = useState(false)
  const [showMessage, setShowMessage] = useState(false)
  // The invoice this quote has already produced (newest, when several exist) —
  // read on load so the toolbar can answer "has this been billed?" without a tap.
  const [existingInvoiceNumber, setExistingInvoiceNumber] = useState<string | null>(null)
  const [savedCustomerMsg, setSavedCustomerMsg] = useState<string | null>(null)
  const [dupMsg, setDupMsg] = useState<string | null>(null)
  // ── Scheduling-deposit gate ────────────────────────────────────────────────
  // The quote's deposit ledger rows (payments.quote_id). null = not loaded yet
  // OR the read failed — and an unreadable ledger must NEVER display as "no
  // deposit received", so the panel says "checking…" instead of a verdict.
  const [depositRows, setDepositRows] = useState<GateLedgerRow[] | null>(null)
  const [depositRowsError, setDepositRowsError] = useState<string | null>(null)
  // The offline-payment recorder (e-transfer / cash / card-elsewhere).
  const [recordingDeposit, setRecordingDeposit] = useState(false)
  const [depAmount, setDepAmount] = useState('')
  const [depMethod, setDepMethod] = useState('etransfer')
  const [depBusy, setDepBusy] = useState(false)


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
      const [qRes, svcRes, optRes, cRes, tRes, tierRes, sRes, invRes, recentRes, bundleRes] = await Promise.all([
        supabase.from('quotes').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('quote_services').select('*').eq('quote_id', id).order('sort_order'),
        // The owner's own order, which is the order the customer saw.
        supabase.from('quote_options').select('*').eq('quote_id', id).order('sort_order'),
        supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user!.id).is('archived_at', null).order('name'), // active only — archived hidden from the picker
        supabase.from('service_templates').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('travel_fee_tiers').select('*').eq('user_id', user!.id).order('sort_order'),
        supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
        // Has this quote already been billed? The page never asked, so "Convert to
        // invoice" stayed live (and PRIMARY on a completed quote) forever — including
        // after completing a visit auto-drafted one — and the answer only ever arrived
        // as a red error AFTER the tap. ORDERED, not just limit(1): a recurring quote
        // legitimately accumulates invoices (the quote_id dedupe is skipped for
        // recurring jobs), so name the NEWEST rather than an arbitrary row. Same
        // select the convert guard already runs, so RLS is already proven.
        supabase.from('invoices').select('invoice_number, issued_date').eq('quote_id', id).order('issued_date', { ascending: false }).limit(1),
        // Ranking for the service picker, off rows that already exist. Nothing is
        // recorded to build it — see recentTemplateIdsFrom.
        supabase.from('quotes').select('service_template_id').eq('user_id', user!.id)
          .not('service_template_id', 'is', null).order('created_at', { ascending: false }).limit(60),
        // Names only. "Save as bundle" needs to know what would collide before
        // the owner types anything; it does not need the bundles themselves.
        supabase.from('service_bundles').select('name').eq('user_id', user!.id),
      ])
      setQuote(qRes.data)
      setServices((svcRes.data as QuoteService[]) || []) // error/absent table → [] (legacy)
      setOptions((optRes.data as QuoteOption[]) || [])
      setCustomers(cRes.data || [])
      setTemplates(tRes.data || [])
      setRecentTemplateIds(recentTemplateIdsFrom(recentRes.data))
      setTiers(tierRes.data || [])
      setSettings(sRes.data)
      setExistingInvoiceNumber((invRes.data?.[0] as { invoice_number: string } | undefined)?.invoice_number ?? null)
      setBundleNames(((bundleRes.data as { name: string }[] | null) || []).map(b => b.name.toLowerCase()))
      // The deposit ledger — only fetched when a rule exists (every other quote
      // pays nothing for the feature). A failed read stays null: "couldn't
      // check" must never render as "nothing received".
      const qRow = qRes.data as Quote | null
      if (qRow?.deposit_type) {
        const { rows, error } = await loadQuoteDepositRows(supabase, qRow.id)
        if (error) setDepositRowsError(error)
        else setDepositRows(rows)
      } else {
        setDepositRows([])
      }
      setLoading(false)
    }
    load()
  }, [id])

  // Re-derive the gate's ledger picture (post-record / post-refresh).
  async function refreshDepositRows(quoteId: string) {
    const { rows, error } = await loadQuoteDepositRows(supabase, quoteId)
    if (error) { setDepositRowsError(error); return }
    setDepositRowsError(null)
    setDepositRows(rows)
  }

  // Resolves FALSE when the update failed, so the builder keeps the autosave
  // draft rather than clearing it on a save that never landed.
  async function handleUpdate(values: QuoteFormValues): Promise<boolean> {
    const { data: { user } } = await supabase.auth.getUser()

    // QL-2: quotes.address is a DOCUMENT SNAPSHOT, never a match key. The old code
    // re-ran find-or-create on every edit using the snapshot — so after a property
    // address correction, editing the quote's PRICE re-matched the stale snapshot,
    // minted a duplicate property at the old address, and re-pointed the quote at
    // it. On edit, trust the ids the quote already has; resolution runs ONLY when
    // the owner actually changed the address or the customer — a deliberate
    // re-pointing, which is exactly what find-or-create is for.
    let customerId: string | null = values.customer_id && values.customer_id !== '__manual' ? values.customer_id : null
    let propertyId: string | null = quote?.property_id ?? null
    let customerName = values.customer_name
    const addressChanged = (values.address || '').trim() !== (quote?.address || '').trim()
    const customerChanged = (values.customer_id || '') !== (quote?.customer_id || '') || values.customer_id === '__manual'
    if (addressChanged || customerChanged || !customerId) {
      try {
        const ensured = await ensureCustomerAndProperty(
          supabase, user!.id,
          { customerId: values.customer_id, name: values.customer_name, address: values.address, phone: values.customer_phone, email: values.customer_email, source: values.acquisition_source },
          customers,
        )
        customerId = ensured.customerId
        customerName = ensured.customerName
        // A re-point to a DIFFERENT customer must never keep the old customer's
        // property: when resolution soft-fails (ensurePropertyForCustomer returns
        // null without throwing), falling back to quote.property_id would write
        // customer B's id with customer A's property on one row.
        propertyId = ensured.propertyId ?? (customerChanged ? null : propertyId)
      } catch {
        // Fail CLOSED, exactly like the create path (whose comment documents four
        // live orphan rows produced by this same swallow). Falling through here
        // wrote customer_id NULL — or the old customer's property under a new
        // customer's id — then returned true and toasted nothing: the quote lost
        // its Send card, its follow-up cron and its portal link, with a success
        // outcome on screen. Nothing has been written yet at this point, so
        // stopping is safe, and `return false` keeps the autosave draft (the
        // same contract this function already uses below).
        toast.error('Could not link this quote to a customer — nothing was saved. Check your connection and press Save again.')
        return false
      }
    } else {
      // Nothing identity-bearing changed → keep the existing linkage untouched.
      customerId = quote?.customer_id ?? customerId
      const c = customers.find(c => c.id === customerId)
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

    // ── Alternatives ─────────────────────────────────────────────────────────
    // ⛔ SETTLED ONCE CHOSEN. `selected_option_id` non-null means a real person
    // approved a specific alternative at a specific price; the composite FK's
    // ON DELETE RESTRICT would refuse the delete half of the rewrite anyway, and
    // a save that half-applied would be worse than one that doesn't try. So the
    // editor is read-only (optionsLockedName below) and this path leaves the rows
    // exactly as the customer saw them. Price corrections after approval go the
    // way they already do: edit the quote, with the "they approved $X" warning.
    const optionsSettled = !!quote?.selected_option_id
    const optionsOn = !!values.has_options && !optionsSettled
    // Edit saves as-entered — fee recovery was baked in at creation, same as the
    // single-service field one line up.
    const optionRows = optionsOn ? optionRowsFor(values.options || [], id, user!.id) : []
    const optionHeadline = optionsOn ? headlineOptionPrice(optionRows) : null

    // ADR-002: provenance moves WITH the price. Editing a quote re-uses the engine
    // surface (QuoteBuilder), so a re-applied recommendation — or a hand override —
    // strikes a NEW number under TODAY's config. When any price actually moves, record
    // which config produced it and the grade that priced it, exactly as the create path
    // does. When nothing moved, leave all four provenance columns untouched: the price
    // still belongs to its original config, and re-stamping an unmoved price is the same
    // lie this ADR forbids on a plain duplicate. This closes the gap ADR-002 named and
    // deferred — the one path that could re-price under a newer config yet keep the old
    // version id, silently making the row unreproducible.
    // The price this save is writing — one option's, or the classic sum of the
    // primary line and its extras. Named once so the provenance check below and
    // the update payload can never judge different numbers.
    const nextInitialPrice = optionsOn
      ? optionHeadline
      : (optionsSettled ? (quote?.initial_price ?? null) : (initialWithExtras > 0 ? initialWithExtras : null))

    const priceMoved =
      Number(nextInitialPrice || 0)      !== Number(quote?.initial_price || 0) ||
      Number(values.weekly_price || 0)   !== Number(quote?.weekly_price || 0) ||
      Number(values.biweekly_price || 0) !== Number(quote?.biweekly_price || 0) ||
      Number(values.monthly_price || 0)  !== Number(quote?.monthly_price || 0)

    let provenance: Record<string, unknown> = {}
    if (priceMoved) {
      // Fail-closed, exactly like the create path: a changed engine price we cannot
      // attribute to a config is the row quotes_engine_price_needs_config rejects — so
      // stop here with the edit still on screen rather than attempt a write the DB will
      // bounce or, worse, a misattributed one.
      const ver = await ensureCurrentPricingConfigVersion(supabase, user!.id)
      if (!ver.ok) {
        toast.error('Could not record which pricing settings this change used — nothing was saved. Check your connection and press Save again.')
        return false   // nothing saved — keep the autosave draft the toast relies on
      }
      provenance = {
        price_source: 'engine',
        pricing_config_version_id: ver.versionId,
        // The form carries a fresh grade only if a recommendation was re-applied in this
        // edit; a hand price-change leaves it null, so fall back to the grade the
        // customer already had. Never invent one — null only if none was ever computed.
        value_grade: values.value_grade ?? quote?.value_grade ?? null,
        nearby_count: values.nearby_count ?? quote?.nearby_count ?? null,
      }
    }

    // Scheduling-deposit rule — the ONE shared mapping (lib/payments/depositGate),
    // same fail-closed shape as provenance: an invalid rule stops the save with
    // the reason rather than silently writing a different gate than the owner set.
    const depositRule = depositRuleFromForm(values.deposit_type, values.deposit_value)
    if (!depositRule.ok) {
      toast.error(`Scheduling deposit: ${depositRule.error} Nothing was saved.`)
      return false
    }

    const { data, error } = await supabase
      .from('quotes')
      .update({
        ...provenance,
        ...depositRule.patch,
        customer_id: customerId,
        customer_name: customerName,
        property_id: propertyId,
        address: values.address,
        service_type: values.service_type,
        service_template_id: values.service_template_id || null,
        initial_price: nextInitialPrice,
        weekly_price: Number(values.weekly_price) > 0 ? Number(values.weekly_price) : null,
        biweekly_price: Number(values.biweekly_price) > 0 ? Number(values.biweekly_price) : null,
        monthly_price: Number(values.monthly_price) > 0 ? Number(values.monthly_price) : null,
        overgrowth_multiplier: mult,
        custom_travel_required: values.custom_travel_required,
        show_travel_separately: values.show_travel_separately,
        // Two audiences, two columns — never merged (lib/noteScope).
        notes: values.notes || null,
        internal_notes: values.internal_notes || null,
        hours: Number(values.hours),
        crew_size: Number(values.crew_size),
        rate: finalRate,
        travel_fee: Number(values.travel_fee),
        measured_sqft: Number(values.measured_sqft) || null,
        suggested_price: Number(values.suggested_price) || null,
        // QL-1: editing quote CONTENT never touches status. QuoteStatusControl is
        // the sole status writer (routes sent→markSentPatch, accepted→markWonPatch),
        // so a content edit can't downgrade a Sent quote or skip the expiry stamps.
      })
      .eq('id', id)
      .select()
      .single()

    if (data) {
      // Replace the service breakdown atomically-enough for a single owner:
      // clear + reinsert (rows exist ONLY for multi-service quotes).
      // Both steps used to be fire-and-forget: a failed DELETE meant the insert
      // DOUBLED every line (PDF and invoice conversion bill twice), a failed
      // INSERT meant the breakdown vanished while setServices([]) made the screen
      // agree — and either way the function returned true, so the owner watched a
      // clean save. supabase-js reports failure in the result object, never by
      // throwing, so ignoring the result IS swallowing the error.
      const { data: { user: u2 } } = await supabase.auth.getUser()

      // ── The alternatives, same clear-and-reinsert, same honesty about it ────
      // Skipped entirely when the choice is settled (see optionsSettled above) —
      // the rows are the record of what was offered and what was taken.
      if (!optionsSettled) {
        const delOpt = await supabase.from('quote_options').delete().eq('quote_id', id)
        if (delOpt.error) {
          toast.error('Saved the quote, but its options could not be updated: ' + delOpt.error.message + ' — press Save again.')
          return false
        }
        if (optionRows.length && u2) {
          const { data: optRows, error: optErr } = await supabase.from('quote_options')
            .insert(optionRows.map(r => ({ ...r, user_id: u2.id }))).select('*')
          if (optErr) {
            // The delete landed, so the quote genuinely has no options now — and
            // its `initial_price` was just written to one of them. Say so rather
            // than let the screen show a priced quote with nothing to choose.
            setOptions([])
            toast.error('Saved the quote, but its options were lost mid-save: ' + optErr.message + ' — press Save again to restore them.')
            return false
          }
          setOptions((optRows as QuoteOption[]) || [])
        } else {
          setOptions([])
        }
      }

      const del = await supabase.from('quote_services').delete().eq('quote_id', id)
      if (del.error) {
        // Old lines are still intact — nothing about the breakdown changed. The
        // quote row above DID update; a retry re-runs both, which is safe.
        toast.error('Saved the quote, but its service lines could not be updated: ' + del.error.message + ' — press Save again.')
        return false
      }
      if (extraLines.length && u2) {
        const { data: rows, error: insError } = await supabase.from('quote_services').insert([
          {
            user_id: u2.id, quote_id: id, sort_order: 0,
            service_type: values.service_type, service_template_id: values.service_template_id || null,
            quantity: 1, unit: 'each', unit_price: Number(values.initial_price) || 0,
            est_minutes: Math.round(Number(values.hours) * 60) || null,
            // ⚠️ See the twin of this line in quotes/new. PostgREST unifies the
            // COLUMN SET of a bulk insert and sends an explicit NULL for any key an
            // object is missing, rather than letting the column default apply. The
            // extras below carry `kind`, so row 0 arrived as NULL against a NOT NULL
            // column and the insert was rejected in full. Here that was worse than
            // in the create path: the DELETE above had already run, so editing any
            // multi-service quote wiped its breakdown and the retry this file
            // honestly asks for could never succeed.
            kind: 'service',
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
        if (insError) {
          // The delete above succeeded, so the DB genuinely holds no lines now —
          // reflect that truthfully rather than pretending. The autosave draft
          // still holds every line (return false keeps it), so pressing Save
          // again re-inserts the full breakdown.
          setServices([])
          toast.error('Saved the quote, but its service lines were lost mid-save: ' + insError.message + ' — press Save again to restore them.')
          return false
        }
        setServices((rows as QuoteService[]) || [])
      } else {
        setServices([])
      }
      setQuote(data)
      setEditing(false)
      // Keep the lawn size on the property in sync (it's a core attribute, not just
      // quote data). New/unchanged → silent; a CHANGED size replaces it non-blockingly
      // with a quick Undo (no up-front confirm).
      // MEAS-1: only a LAWN service syncs the lawn area, and it goes through the ONE
      // seam (lib/measure → property_measurements → mirror), never a direct lawn_sqft
      // write the DB guard would reject.
      const measuredSqft = Number(values.measured_sqft) || 0
      const isLawn = servicePricingKind(values.service_type, templates.find(t => t.id === values.service_template_id) ?? null) === 'lawn_recurring'
      if (propertyId && measuredSqft > 0 && isLawn) {
        const { data: prop } = await supabase.from('properties').select('lawn_sqft').eq('id', propertyId).maybeSingle()
        const prior = Number((prop as { lawn_sqft: number | null } | null)?.lawn_sqft) || 0
        const changed = Math.round(prior) !== Math.round(measuredSqft)
        if (changed) {
          const saved = await saveManual(supabase, { userId: user!.id, propertyId, kind: 'lawn', value: measuredSqft })
          if (!saved.ok) toast.error(`Saved the quote, but the lawn size didn’t sync: ${saved.error}`)
          else if (prior > 0) {
            const priorLawn = (prop as { lawn_sqft: number | null } | null)?.lawn_sqft ?? null
            toast.undo(`Saved lawn size updated to ${measuredSqft.toLocaleString()} ft²`, async () => {
              if (priorLawn != null) await saveManual(supabase, { userId: user!.id, propertyId, kind: 'lawn', value: priorLawn })
            })
          }
        }
      }
      return true
    }
    // Same contract as `else if (error)` — return false so the builder keeps the
    // draft — but reached by falling through, so a response carrying NEITHER a row
    // nor an error is reported too, instead of Update doing visibly nothing.
    toast.error(error ? 'Could not update quote: ' + error.message : 'Could not update quote. Your changes are still here — try again.')
    return false
  }

 // Returns TRUE only when the PDF actually reached the device — the caller gates the
 // "mark sent" write on it, so a failed render can never flip the quote to Sent.
 async function handleOpenPdf(): Promise<boolean> {
    if (!quote) return false
    setPdfLoading(true)
    try {
      const { renderQuoteBlob } = await import('@/components/quotes/QuotePDF')
      const blob = await renderQuoteBlob(quote, settings, services, options)
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
    // ── The scheduling guard ───────────────────────────────────────────────
    // An accepted quote whose required deposit hasn't been collected does not
    // schedule silently. The owner CAN — emergencies are real — but only through
    // an explicit, named override that stamps deposit_override_at (the audit
    // record) and leaves the money honestly still owed. Derived fresh from the
    // ledger AT CLICK TIME, never from the page's possibly-stale rows: the
    // customer may have paid while this tab sat open.
    if (quote.deposit_type && quote.status === 'accepted') {
      const { rows, error: rowsErr } = await loadQuoteDepositRows(supabase, quote.id)
      if (rowsErr) {
        toast.error('Couldn’t check the deposit ledger — try again. (Scheduling was not started: an unchecked deposit must not schedule as if paid.)')
        return
      }
      setDepositRows(rows)
      const gate = schedulingGate(quote, rows)
      if (gateBlocksScheduling(quote, gate)) {
        const ok = await confirmDialog({
          title: 'Schedule without the required deposit?',
          message: `This quote requires a ${formatCurrency(gate.required)} deposit before scheduling is confirmed, and ${gate.collected > 0 ? `only ${formatCurrency(gate.collected)} has been received — ${formatCurrency(gate.outstanding)} is still outstanding` : 'none of it has been received yet'}. Scheduling anyway books the visit with the deposit still owed — the customer's portal will keep asking for it.`,
          confirmLabel: 'Schedule without deposit',
          destructive: true,
        })
        if (!ok) return
        // The audit stamp — records that this was a decision, not an oversight.
        // Non-fatal on failure: the confirmed intent stands either way.
        await stampDepositOverride(supabase, quote.id)
      }
    }
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
        // AND say what did NOT happen: scheduleQuoteAsJob books ONE visit, never a
        // recurring schedule — deliberately (recurrence needs a day/frequency the
        // owner picks on the job). But for a quote whose customer chose a weekly
        // plan, "Job added" read as "done", the plan never became a schedule, and
        // every surface agreed the work was booked. The toast now carries the
        // remaining step instead of implying there isn't one.
        const cad = quote.selected_cadence && quote.selected_cadence !== 'one_time'
          ? quote.selected_cadence
          : (Number(quote.weekly_price) > 0 || Number(quote.biweekly_price) > 0 || Number(quote.monthly_price) > 0) ? 'recurring' : null
        const cadLabel = cad === 'weekly' ? 'weekly plan' : cad === 'biweekly' ? 'bi-weekly plan' : cad === 'monthly' ? 'monthly plan' : cad === 'recurring' ? 'recurring plan' : null
        toast(cadLabel
          ? `First visit added to today’s schedule. The ${cadLabel} isn’t a repeating schedule yet — open the job to set its recurrence.`
          : 'Job added to today’s schedule.', {
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
      // null = the invoice ledger read failed, so the next number is unknown.
      // Converting anyway would mint INV-0001 over an existing invoice; the quote
      // is safer left unconverted, and the owner can simply press Convert again.
      if (!invoiceNumber) {
        toast.error('Could not read your existing invoice numbers, so the quote was not converted. Check your connection and try again.')
        setConverting(false)
        return
      }

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
        // ⭐ AUDIENCE SURVIVES THE CONVERSION. The invoice has the same two
        // halves the quote does (invoices.notes prints, invoices.internal_notes
        // never does), so each side maps to its own counterpart. The one thing
        // that must never happen here is quote.internal_notes landing in
        // invoices.notes — that is a price floor on a customer's bill.
        notes: quote.notes,
        internal_notes: quote.internal_notes,
      })

      if (error) {
        toast.error('Could not create invoice: ' + error.message)
      } else {
        // Persist what just happened. The toast was the ONLY evidence, so a phone
        // lock or a navigate-and-return left the owner re-tapping Convert to find
        // out — and the answer came back as a red "already invoiced" error.
        setExistingInvoiceNumber(invoiceNumber)
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
        // ADR-002: a duplicate copies the PRICES verbatim, so it must copy the reasons
        // that explain them. Re-stamping today's config here would be a lie — this
        // price was struck under the original one and has not moved. (If the owner
        // later re-prices the copy, the write path that changes the number is what
        // records the new config.)
        price_source: quote.price_source,
        pricing_config_version_id: quote.pricing_config_version_id,
        value_grade: quote.value_grade,
        nearby_count: quote.nearby_count,
        overgrowth_multiplier: quote.overgrowth_multiplier,
        custom_travel_required: quote.custom_travel_required,
        show_travel_separately: quote.show_travel_separately,
        // A duplicate is the same quote again, so BOTH halves come along and
        // each stays on its own side. Copying `internal_notes` into `notes`
        // (or dropping it) would be the leak and the loss respectively.
        notes: quote.notes,
        internal_notes: quote.internal_notes,
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
        // Copy the multi-service breakdown onto the duplicate — and say so if it
        // fails. This insert was fire-and-forget, so a failed copy produced a
        // duplicate whose TOTAL was right but whose lines were silently gone; the
        // owner discovered it when the customer's PDF collapsed to one number.
        if (services.length) {
          const { error: lineErr } = await supabase.from('quote_services').insert(services.map(s => ({
            user_id: user!.id, quote_id: data.id, sort_order: s.sort_order,
            service_type: s.service_type, service_template_id: s.service_template_id,
            quantity: s.quantity, unit: s.unit, unit_price: s.unit_price,
            est_minutes: s.est_minutes, discount_type: s.discount_type,
            discount_value: s.discount_value, notes: s.notes,
            // Without this the duplicate silently demotes every material back to
            // a service — the copy would stop matching the quote it came from.
            kind: s.kind ?? 'service',
          })))
          if (lineErr) toast.error('Duplicated the quote, but its service lines did not copy: ' + lineErr.message + ' — re-add them on the copy.')
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

  // ── "They rang and said they want the Premium" ──────────────────────────────
  // The owner records the customer's choice through the SAME contract the portal
  // uses: `owner_select_quote_option` and `portal_accept_quote` are two doors into
  // one function (quote_apply_option_choice) that owns the money rule. There is no
  // second implementation of "an option's price becomes the quote's price" — which
  // is exactly how the owner's screen and the customer's screen would otherwise
  // start disagreeing about what was bought.
  const [choosing, setChoosing] = useState<string | null>(null)
  async function acceptOptionForCustomer(optionId: string) {
    if (!quote || choosing) return
    const opt = options.find(o => o.id === optionId)
    if (!opt) return
    const priced = Number(opt.price) + (Number(quote.travel_fee) || 0)
    const ok = await confirmDialog({
      title: `Record ${opt.name} as the customer’s choice?`,
      message: `This approves ${quote.quote_number} at ${formatCurrency(priced)} on ${quote.customer_name}’s behalf — the same as if they had approved it in their portal. The other options stay on the record as what was offered, and this can’t be swapped afterwards without sending a revised quote.`,
      confirmLabel: `Approve ${opt.name} — ${formatCurrency(priced)}`,
    })
    if (!ok) return
    setChoosing(optionId)
    try {
      const { data: applied, error } = await supabase.rpc('owner_select_quote_option', {
        p_quote_id: quote.id, p_option_id: optionId,
      })
      // ⚠️ A falsy result is a REFUSAL, not a success with nothing to show, and it
      // must never be reported as one. Re-read the row and let the database say
      // what happened rather than assuming either way.
      const { data: fresh } = await supabase.from('quotes').select('*').eq('id', quote.id).single()
      if (error || !applied) {
        if (fresh && (fresh as Quote).selected_option_id === optionId) {
          setQuote(fresh as Quote)   // it landed (another tab, a retry) — say the true thing
          toast.success(`${opt.name} recorded as the approved option.`)
        } else {
          toast.error(
            (fresh as Quote | null)?.selected_option_id
              ? 'This quote already has an approved option — send a revised quote to change it.'
              : 'Could not record that choice — check your connection and try again.',
          )
        }
        return
      }
      if (fresh) setQuote(fresh as Quote)
      toast.success(`${opt.name} recorded — ${quote.quote_number} is approved at ${formatCurrency(priced)}.`)
    } finally { setChoosing(null) }
  }

  async function markWon() {
    if (!quote || actionBusy) return
    // ⛔ An options quote cannot be "won" without saying WHICH option. Accepting
    // one through the plain patch would set status='accepted' and leave
    // selected_option_id NULL — an approved quote whose approved scope nobody can
    // name, which is the single state this whole feature exists to make
    // impossible. Point at the picker instead of half-recording the sale.
    if (options.length > 0) {
      toast.error('This quote offers options — pick the one the customer chose, just below.')
      document.getElementById('eq-quote-options')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
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
  // THE send rule, from the one engine that owns it (lib/quoteStatus). The PDF
  // action already asks it — but that path only hands a file to the OWNER'S OWN
  // device, while the Send card below texts/emails the customer a portal link
  // they can approve from. The dangerous path was the unguarded one: a $0 quote
  // could be delivered and accepted, which is exactly what the engine's own
  // comment forbids ("a quote in a customer's hands without a price is not a
  // quote"). Asking the same function here enforces the existing rule on the
  // path that needed it most — no new rule, no engine change.
  const sendBlock = sendBlockedReason(quote)

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
      {/* The customer's approval covered a SPECIFIC number. Edit was offered on
          accepted/scheduled/completed quotes with no acknowledgement that a deal
          existed — and the accepted_price snapshot the portal writes was read
          nowhere in the app, so rewriting an approved total looked identical to
          tweaking a draft. Warn, never block: price corrections after acceptance
          are legitimate (that's why Edit exists here), but they must be made
          knowing the customer hasn't agreed to the new number. */}
      {['accepted', 'scheduled', 'completed', 'paid'].includes(quote.status) && (
        <Banner tone="warn" icon={AlertTriangle}>
          <span className="font-semibold text-ink">
            The customer approved this quote{Number(quote.accepted_price) > 0 ? ` at ${formatCurrency(Number(quote.accepted_price))}` : ''}.
          </span>{' '}
          Changes here are not re-approved automatically — if the price moves, send it again or confirm with them before the work is billed.
        </Banner>
      )}
      <QuoteBuilder
        customers={customers}
        templates={templates}
        recentTemplateIds={recentTemplateIds}
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
          internal_notes: quote.internal_notes || '',
          status: quote.status,
          // A quote that HAS options opens with the switch on and the rows loaded
          // in the owner's saved order — never re-sorted, never re-seeded.
          has_options: options.length > 0,
          options: sortedOptions(options).map(o => ({
            id: o.id, name: o.name, description: o.description || '',
            price: Number(o.price) || 0, is_recommended: !!o.is_recommended,
          })),
          // The scheduling-deposit rule survives the edit round-trip. '' = none.
          deposit_type: (quote.deposit_type ?? '') as '' | 'percent' | 'fixed',
          deposit_value: Number(quote.deposit_value) || 0,
        }}
        // Non-null ⇒ the editor goes read-only and handleUpdate leaves the rows
        // alone. What was approved is not silently rewritten.
        optionsLockedName={activeOption(options, quote.selected_option_id)?.name ?? null}
        onSubmit={handleUpdate}
        isEdit
        autosaveKey={`quote:${quote.id}`}
        autosaveBaselineUpdatedAt={quote.updated_at}
        // Editing is a same-route state toggle — Cancel must return to the quote
        // VIEW, exactly where Save lands. router.back() (the default) popped
        // history out of the quote entirely: 2-3 taps to re-find it, plus a
        // did-it-save beat of doubt.
        onCancel={() => setEditing(false)}
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
            <Button onClick={handleSendQuote} size="sm" variant={quote.customer_id ? 'secondary' : 'primary'} loading={pdfLoading}
              title="Downloads the PDF to this device and marks the quote sent — it does not message the customer">
              {/* The label names BOTH halves. It read "Download PDF" while the handler
                  also ran markSentPatch — stamping sent_at + valid_until, starting the
                  expiry clock and arming the follow-up cron — so the owner learned the
                  status had moved only from the toast afterwards. Still distinct from
                  the customer-facing "Send quote" card below. */}
              <FileDown className="w-3.5 h-3.5" /> Download &amp; mark sent
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
          {/* Already billed → the action becomes the ANSWER. Replacement, not a
              disabled button: the convert guard makes a second conversion genuinely
              impossible, so offering it was offering a red error. Shown on ANY
              status (not just canInvoice) — "has this been billed?" is worth
              answering everywhere, and completing a visit auto-drafts one. */}
          {existingInvoiceNumber ? (
            <ButtonLink href={`/dashboard/invoices?invoice=${encodeURIComponent(existingInvoiceNumber)}`} variant="secondary" size="sm">
              <FileText className="w-3.5 h-3.5" /> Invoice {existingInvoiceNumber}
            </ButtonLink>
          ) : canInvoice ? (
            // Completed = converting is THE stage action, so it takes the one
            // primary slot; other stages have their own primary elsewhere.
            <Button onClick={handleConvertToInvoice} variant={quote.status === 'completed' ? 'primary' : 'secondary'} size="sm" loading={converting}>
              <FileText className="w-3.5 h-3.5" /> Convert to invoice
            </Button>
          ) : null}
          <Button onClick={() => setEditing(true)} variant="ghost" size="sm">
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </Button>
          {/* Save the SCOPE for reuse — distinct from Duplicate, which copies
              this whole quote (customer and all) once. Hidden on an options
              quote: alternatives carry no line items, so there is no scope to
              save, and offering the button would promise one. */}
          {!options.length && (
            <Button onClick={() => setShowSaveBundle(true)} variant="ghost" size="sm"
              aria-label="Save this scope as a bundle" title="Save this scope as a bundle">
              <Layers className="w-4 h-4" />
            </Button>
          )}
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

      {(quote.status === 'accepted' || quote.status === 'scheduled') && (() => {
        // The gate — derived from the ledger rows loaded above. rowsUnknown means
        // the read failed: say "checking" rather than a verdict either way.
        const rowsUnknown = quote.deposit_type ? depositRows == null : false
        const gate = schedulingGate(quote, depositRows ?? [])
        const prefLine = schedulingPreferenceLine(quote, formatDate)
        // A SCHEDULED quote that still owes its deposit — the override case, or a
        // payment that bounced after booking. The ask stays visible and recordable;
        // only the "schedule anyway" affordance drops (it already happened).
        const scheduledStillOwed = quote.status === 'scheduled'
          && gate.required > 0 && gate.status !== 'satisfied'
        if (quote.status === 'scheduled' && !scheduledStillOwed && !rowsUnknown) return null
        // ── Deposit still owed: the banner leads with the money, not the button ─
        if (quote.deposit_type && (rowsUnknown || gateBlocksScheduling(quote, gate) || scheduledStillOwed)) {
          return (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 space-y-2">
              <p className="text-sm font-medium text-ink flex items-center gap-2">
                <Wallet className="w-4 h-4 shrink-0 text-amber-400" />
                {rowsUnknown
                  ? `${quote.status === 'scheduled' ? 'Scheduled' : 'Accepted'} — checking the deposit ledger…`
                  : scheduledStillOwed
                    ? <>Scheduled{quote.deposit_override_at ? ' (your call)' : ''} — <span className="text-amber-400">{formatCurrency(gate.outstanding)} deposit still owed</span>{gate.collected > 0 ? <> ({formatCurrency(gate.collected)} received so far)</> : null}</>
                    : gate.collected > 0
                      ? <>Accepted — deposit {formatCurrency(gate.collected)} of {formatCurrency(gate.required)} received · <span className="text-amber-400">{formatCurrency(gate.outstanding)} still required</span></>
                      : <>Accepted — awaiting the <span className="text-amber-400">{formatCurrency(gate.required)}</span> deposit before scheduling</>}
              </p>
              {depositRowsError && <p className="text-xs text-red-400">{depositRowsError}</p>}
              <p className="text-xs text-ink-muted">
                {scheduledStillOwed
                  ? 'The customer’s portal keeps asking for it — record it here when it arrives another way.'
                  : 'Scheduling isn’t secured until the deposit is collected. The customer can pay from their portal.'}
                {prefLine ? <> · <span className="text-ink">Customer preference: {prefLine}</span></> : null}
                {quote.preferred_note ? <> · &ldquo;{quote.preferred_note}&rdquo;</> : null}
              </p>
              {!rowsUnknown && (
                <div className="flex items-center gap-2 flex-wrap">
                  {!recordingDeposit ? (
                    <Button size="sm" variant="secondary" onClick={() => { setRecordingDeposit(true); setDepAmount(String(gate.outstanding)) }}>
                      <Check className="w-3.5 h-3.5" /> Record deposit received
                    </Button>
                  ) : (
                    // Inline recorder for offline money: e-transfer, cash, a card
                    // charged elsewhere. Goes through recordDeposit — THE ledger
                    // door — with the quote link, so it satisfies the gate exactly
                    // the way a Stripe payment does. No second truth.
                    <div className="flex items-end gap-2 flex-wrap">
                      <label className="block">
                        <span className="block text-[11px] text-ink-muted mb-1">Amount ($)</span>
                        <input type="number" step="0.01" min="0" value={depAmount} onChange={e => setDepAmount(e.target.value)}
                          className="w-28 rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
                      </label>
                      <label className="block">
                        <span className="block text-[11px] text-ink-muted mb-1">How it arrived</span>
                        <select value={depMethod} onChange={e => setDepMethod(e.target.value)}
                          className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40">
                          {PAYMENT_METHODS.filter(mm => mm.value !== 'credit').map(mm => (
                            <option key={mm.value} value={mm.value}>{mm.label}</option>
                          ))}
                        </select>
                      </label>
                      <Button size="sm" loading={depBusy} onClick={async () => {
                        const amt = Number(depAmount)
                        if (!(amt > 0)) { toast.error('Enter the amount that was received.'); return }
                        if (!quote.customer_id) { toast.error('This quote has no customer to record the deposit against.'); return }
                        setDepBusy(true)
                        const { data: { user: u } } = await supabase.auth.getUser()
                        const res = await recordDeposit(supabase, {
                          userId: u!.id, customerId: quote.customer_id, amount: amt, method: depMethod,
                          quoteId: quote.id, notes: `Scheduling deposit — ${quote.quote_number}`,
                        })
                        setDepBusy(false)
                        if (res.error) { toast.error('Could not record the deposit: ' + res.error); return }
                        setRecordingDeposit(false)
                        await refreshDepositRows(quote.id)
                        // Undo deletes BOTH ledger legs — removing only the cash
                        // row would leave phantom customer credit. The delete is
                        // CHECKED: a failed undo must say so, not report a ledger
                        // row gone while it still stands (the undo contract).
                        const ids = res.paymentIds || []
                        toast.undo(`${formatCurrency(amt)} deposit recorded for ${quote.quote_number}.`, async () => {
                          if (ids.length) {
                            const { error: undoErr } = await supabase.from('payments').delete().in('id', ids)
                            if (undoErr) {
                              toast.error('Could not remove the recorded deposit — it still stands. ' + undoErr.message)
                              return
                            }
                          }
                          await refreshDepositRows(quote.id)
                        })
                      }}>
                        Record
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRecordingDeposit(false)}>Cancel</Button>
                    </div>
                  )}
                  {/* The override lives behind the SAME handler the normal button
                      uses — handleScheduleJob re-derives the gate at click time
                      and raises the explicit confirm. No silent bypass exists.
                      Absent once scheduled: the decision was already made. */}
                  {!scheduledStillOwed && (
                    <Button size="sm" variant="ghost" onClick={() => handleScheduleJob()} loading={scheduling}
                      title="Books the visit with the deposit still owed — asks you to confirm first">
                      Schedule without deposit…
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        }
        if (quote.status === 'scheduled') return null
        // ── No gate, or gate satisfied: READY TO SCHEDULE ─────────────────────
        return (
          <div className="flex items-center justify-between flex-wrap gap-3 text-sm bg-accent/10 border border-accent/20 rounded-xl px-4 py-3">
            <span className="text-ink font-medium flex items-center gap-2 flex-wrap">
              {gate.status === 'satisfied' ? (
                <>
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>Ready to schedule — <span className="text-emerald-400">{formatCurrency(gate.collected)} deposit received</span>.</span>
                </>
              ) : (
                <>
                  <CalendarPlus className="w-4 h-4 shrink-0 text-accent-text" /> Accepted — this job isn’t scheduled yet.
                </>
              )}
              {prefLine && <span className="text-xs text-ink-muted w-full sm:w-auto">Customer preference: {prefLine}{quote.preferred_note ? ` · “${quote.preferred_note}”` : ''}</span>}
            </span>
            <div className="flex items-center gap-2">
              {/* Honest label — this books the job on TODAY's route (move it after). */}
              <Button size="sm" onClick={() => handleScheduleJob()} loading={scheduling}>
                <CalendarPlus className="w-3.5 h-3.5" /> Schedule for today
              </Button>
              <Button size="sm" variant="ghost" onClick={() => router.push(`/dashboard/schedule?quote=${quote.id}`)}>Pick a day</Button>
            </div>
          </div>
        )
      })()}

      {/* Send this quote to the customer — the ONE shared Send Message dialog. */}
      {quote.customer_id && (
        <Card>
          <CardBody className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">
                {quote.status === 'draft' || quote.status === 'sent' ? 'Send this quote to the customer' : 'Resend this quote to the customer'}
              </p>
              {/* Blocked → say why and hand over the door, instead of letting the
                  owner open the composer and discover it mid-message (or worse,
                  deliver a $0 quote the customer can approve). */}
              {sendBlock ? (
                <p className="text-xs text-amber-400 mt-0.5">{sendBlockedLabel(sendBlock)}</p>
              ) : (
                <p className="text-xs text-ink-muted mt-0.5">
                  {quote.status === 'draft' || quote.status === 'sent'
                    ? <>Texts/emails a personalized message with a link to view &amp; accept it in their portal.</>
                    : <>Texts/emails them a copy with a link to their portal.</>}
                </p>
              )}
            </div>
            {/* The REAL send is the primary action while the quote awaits delivery.
                Blocked → the button becomes the FIX ("Add a price"), which opens the
                editor right here: one tap instead of hunting for Edit. */}
            {sendBlock === 'no_price' ? (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Edit2 className="w-4 h-4" /> Add a price
              </Button>
            ) : (
              <Button variant={quote.status === 'draft' || quote.status === 'sent' ? 'primary' : 'secondary'} onClick={() => setShowMessage(true)}>
                <MessageSquare className="w-4 h-4" /> {quote.status === 'draft' || quote.status === 'sent' ? 'Send quote' : 'Resend quote'}
              </Button>
            )}
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

      {showSaveBundle && (
        <SaveAsBundleDialog
          open
          onClose={() => setShowSaveBundle(false)}
          quote={quote}
          services={services}
          templates={templates}
          existingNames={bundleNames}
        />
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

          {/* ⭐ THE TWO NOTES, NEVER IN ONE BOX. This is the owner's preview of a
              document the customer receives, so the field that WILL be on it and
              the field that must never be are labelled by audience and visually
              separated. A shared "Notes" heading over both is precisely how a
              price floor ends up read aloud on a phone call. */}
          {quote.notes && (
            <div className="pt-3 border-t border-border">
              <p className="text-[10px] text-ink-faint uppercase tracking-wide font-semibold mb-1">
                {AUDIENCE_COPY.customer.label} <span className="text-ink-faint/70 normal-case font-normal">· on the PDF and in their portal</span>
              </p>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{quote.notes}</p>
            </div>
          )}

          {quote.internal_notes && (
            <div className="pt-3 border-t border-border">
              <p className="text-[10px] uppercase tracking-wide font-semibold mb-1 text-amber-400/90 flex items-center gap-1">
                <Lock className="w-3 h-3" aria-hidden /> {AUDIENCE_COPY.internal.label}
                <span className="text-ink-faint normal-case font-normal">· only your team</span>
              </p>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{quote.internal_notes}</p>
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-2">
            {quote.custom_travel_required && (
              <div className="flex items-center gap-2 text-xs text-amber-400 mb-1">Custom travel fee applied (beyond standard tiers)</div>
            )}
            {/* Section label — same treatment as "Measurements" / "Ongoing
                maintenance options" so the breakdown reads as a peer section. */}
            {/* Say what's actually in the list — mulch under a "Services" heading
                reads as labour to anyone skimming. */}
            <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">
              {options.length > 0
                ? (quote.selected_option_id ? 'Options offered' : 'Options — the customer picks one')
                : services.some(s => s.kind === 'material') ? 'Services & materials' : 'Services'}
            </p>
            {options.length > 0 ? (
              // ── The alternatives ────────────────────────────────────────────
              // ⛔ No subtotal, ever. These rows are alternatives to one another;
              // a column that added them would be the one lie this whole feature
              // was built to prevent. The quote's value is stated ONCE, below, as
              // the single option it currently rests on.
              <div id="eq-quote-options" className="space-y-2 scroll-mt-24">
                {sortedOptions(options).map(o => {
                  const chosen = quote.selected_option_id === o.id
                  const priced = Number(o.price) + (Number(quote.travel_fee) || 0)
                  return (
                    <div key={o.id}
                      className={`rounded-xl border p-3 ${chosen ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                        : quote.selected_option_id ? 'border-border bg-bg-secondary/40 opacity-70'
                        : o.is_recommended ? 'border-accent/30 bg-accent/[0.04]' : 'border-border bg-bg-secondary'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-ink">
                            {o.name}
                            {o.is_recommended && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent-text">Recommended</span>}
                            {chosen && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">Chosen</span>}
                          </p>
                          {o.description && <p className="text-xs text-ink-muted mt-0.5 whitespace-pre-wrap">{o.description}</p>}
                        </div>
                        <span className="text-sm font-semibold text-ink shrink-0 tabular-nums">{formatCurrency(priced)}</span>
                      </div>
                      {/* Owner-side acceptance, on the SAME contract as the portal.
                          Offered only while the quote is still undecided — after a
                          choice these rows are history, not buttons. */}
                      {!quote.selected_option_id && (quote.status === 'draft' || quote.status === 'sent') && (
                        <Button type="button" variant="secondary" size="sm" className="mt-2.5"
                          loading={choosing === o.id} disabled={!!choosing}
                          onClick={() => acceptOptionForCustomer(o.id)}>
                          <Check className="w-3.5 h-3.5" /> They chose {o.name}
                        </Button>
                      )}
                    </div>
                  )
                })}
                {/* ⭐ THE reporting sentence: is this figure PROPOSED or CHOSEN?
                    Derived from the selection state that already exists, via the
                    one helper every surface asks — never a second stored column. */}
                {(() => {
                  const basis = optionValueBasis(options, quote.selected_option_id)
                  const active = activeOption(options, quote.selected_option_id)
                  if (!basis || !active) return null
                  return (
                    <p className="text-[11px] text-ink-faint pt-0.5">
                      {optionValueBasisLabel(basis, active.name, options.length)}
                      {basis === 'proposed' && ' — this quote counts at that price in your pipeline until they pick.'}
                    </p>
                  )
                })()}
              </div>
            ) : services.length > 0 ? (
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
                        {s.kind === 'material' && <span className="text-[10px] text-ink-faint uppercase tracking-wide"> · material</span>}
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
                {/* Not `?? quote.subtotal` — that column is the legacy
                    hours × crew_size × rate fabrication (see QuotePDF). */}
                <span className="text-ink font-medium tabular-nums">{formatCurrency(Number(quote.initial_price ?? 0))}</span>
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
                {/* WHICH plan the customer picked (selected_cadence, snapshotted at
                    acceptance) was stored but shown nowhere — the owner read three
                    equal options on a quote whose customer had already chosen one,
                    and had to find the answer in the portal conversation. */}
                {([
                  { key: 'weekly', label: 'Weekly', price: quote.weekly_price },
                  { key: 'biweekly', label: 'Bi-Weekly', price: quote.biweekly_price },
                  { key: 'monthly', label: 'Monthly', price: quote.monthly_price },
                ] as const).map(p => p.price ? (
                  <div key={p.key} className="flex justify-between text-sm">
                    <span className="text-ink-muted">
                      {p.label}
                      {quote.selected_cadence === p.key && (
                        <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Customer’s choice</span>
                      )}
                    </span>
                    <span className="text-ink font-medium tabular-nums">{formatCurrency(p.price)}/visit</span>
                  </div>
                ) : null)}
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