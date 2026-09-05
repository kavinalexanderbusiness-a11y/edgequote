'use client'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/layout/PageContainer'
import { confirm as confirmDialog } from '@/lib/confirm'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { cacheLease, readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { custCacheKey, type CustomerPrefetch } from '@/lib/prefetch'
import { Customer, Property, Quote, Job, Invoice, JobRecurrence, CustomerFormValues } from '@/types'
import { WebsiteLead } from '@/lib/leads'
import { LeadSummary } from '@/components/leads/LeadSummary'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { bookingPhotosFromQuotes } from '@/lib/bookingPhotos'
import { normalizeTags, propertyLabel, propertyLinks, describePropertyLinks, deleteProperty } from '@/lib/customers'
import { describeSource } from '@/lib/attribution'
import { PropertySelect } from '@/components/ui/PropertySelect'
import { buildTimeline } from '@/lib/timeline'
import {
  loadCustomerTimelineSources, loadJobTimelineSources,
  type CustomerTimelineSources, type JobTimelineSources,
} from '@/lib/timelineData'
import { TimelineCard } from '@/components/timeline/TimelineCard'
import { HistoryPanel } from '@/components/audit/HistoryPanel'
import { needsFollowUp, daysSince } from '@/lib/followup'
import { isWon } from '@/lib/salesStage'
import { quotePriceState, quoteAmountOrNull, excludedNote, sumQuoteAmounts } from '@/lib/pricingState'
import { quoteNextAction, type PQuote, type PInvoice, type PCustomer } from '@/lib/pipeline'
import type { GateLedgerRow } from '@/lib/payments/depositGate'
import { scheduledQuoteIds } from '@/lib/dashboard/priorities'
import { recurrenceLabel, recurringCustomerLabel, buildServicePlans, ServicePlan, PlanStatus, PLAN_STATUS_LABEL } from '@/lib/recurrence'
import { jobVisitValue, effectiveFreq } from '@/lib/visitValue'
import { settingsToSeasons, DEFAULT_SEASONS, ServiceSeasons } from '@/lib/seasons'
import { invoiceBalance } from '@/lib/payments/ledger'
import { loadBusinessShape, showLawnFieldFor, SHAPE_LOADING, type BusinessShape } from '@/lib/businessShape'
import { resolvePrefs, prefSummary, hasAnyPref, monthShort } from '@/lib/preferences'
import { SchedulePrefsFields, PrefsDraft, EMPTY_DRAFT, toDraft, draftToRow } from '@/components/customers/SchedulePrefsFields'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { DetailHeader } from '@/components/layout/DetailHeader'
import { usePublishQuickAddContext } from '@/components/layout/QuickAddProvider'
import { Avatar } from '@/components/ui/Avatar'
import { Modal } from '@/components/ui/Modal'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { Banner } from '@/components/ui/Banner'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { CustomFieldsSection } from '@/components/customFields/CustomFieldsSection'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Button, ButtonLink } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Menu } from '@/components/ui/Menu'
import { Textarea } from '@/components/ui/Textarea'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { formatCurrency, formatDate, cn, localTodayISO } from '@/lib/utils'
import { ensurePortalToken, portalUrl, rotatePortalToken } from '@/lib/portal'
import { CustomerComms } from '@/components/customers/CustomerComms'
import { CommsHealth } from '@/components/customers/CommsHealth'
import { PreferredChannelCard } from '@/components/customers/PreferredChannel'
import { ReviewLifecycle } from '@/components/customers/ReviewLifecycle'
import { CustomerAiSummary } from '@/components/ai/CustomerAiSummary'
import { ReferralPanel } from '@/components/customers/ReferralPanel'
import { ConversationThread } from '@/components/messages/ConversationThread'
import { PaymentMethodCard } from '@/components/payments/PaymentMethodCard'
import {
  Phone, MessageSquare, FilePlus, CalendarPlus, Mail, MapPin, Repeat,
  FileText, Send, RotateCw, Receipt, DollarSign, Sparkles, Users,
  Edit2, ExternalLink, Ruler, AlertTriangle, StickyNote, Wallet, Timer, CalendarClock,
  Link2, Check, Cake, PartyPopper, Camera, History, Globe, Plus, Home, Tag, Trash2,
  ChevronDown, MoreHorizontal,
} from 'lucide-react'

const OPEN_INVOICE = new Set(['unpaid', 'sent', 'partial'])

// The four reads this page issues itself whose rows every figure below stands
// on. A slice whose LAST live read failed is NAMED here, never coerced to [] —
// `[]` is the answer "this customer has none"; a failed read has no answer.
type ReadSlice = 'Properties' | 'Quotes' | 'Jobs' | 'Invoices'

// Presentation for the engine's verbs. The engine owns WHAT to do; this file
// only decides how it looks — the same split the dashboard queue makes.
const ACTION_ICON: Partial<Record<string, typeof FileText>> = {
  follow_up: RotateCw, send_quote: Send, price_quote: FileText, link_customer: Users,
  schedule_work: CalendarPlus, collect_deposit: DollarSign, collect_payment: Receipt,
  send_invoice: Receipt, add_contact: Users,
}
const ACTION_TONE: Partial<Record<string, string>> = {
  follow_up: 'text-amber-400', send_quote: 'text-sky-400', price_quote: 'text-amber-400',
  link_customer: 'text-amber-400', schedule_work: 'text-accent-text',
  collect_deposit: 'text-red-400', collect_payment: 'text-red-400',
  send_invoice: 'text-sky-400', add_contact: 'text-ink-muted',
}

// Month + day from a 'YYYY-MM-DD' string (no timezone drift) — e.g. "Jun 25".
function mdLabel(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const p = String(dateStr).slice(0, 10).split('-')
  const m = Number(p[1]), d = Number(p[2])
  if (!m || !d) return null
  return `${monthShort(m - 1)} ${d}`
}

// At-a-glance messaging eligibility beside a contact method: whether this channel
// is allowed to send. No silent guessing — the profile says on or off.
function ConsentBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      title={on ? `${label} allowed — automatic and one-tap messages can send.` : `${label} off — turn it on in Communication below to message this customer here.`}
      className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border shrink-0',
        on ? 'text-emerald-400 border-emerald-500/25 bg-emerald-500/10' : 'text-ink-faint border-border bg-bg-tertiary')}>
      {label} {on ? 'on' : 'off'}
    </span>
  )
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [tick, setTick] = useState(0)   // bump to re-run load() (used by realtime)
  // Which full load is current. Every run of the load effect advances it; a narrow
  // refetch captures it when it starts, so a run that began earlier can never land
  // over one that began later (the effect itself retires through its cleanup).
  const loadGen = useRef(0)

  const [customer, setCustomer] = useState<Customer | null>(null)
  const [referrer, setReferrer] = useState<{ id: string; name: string } | null>(null)
  const [referredRevenue, setReferredRevenue] = useState(0)
  const [properties, setProperties] = useState<Property[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  // Signed cash keyed by the booking it secures. NULL until read — the pipeline
  // engine SKIPS the scheduling gate while this is null rather than announcing a
  // paid booking is unsecured (see quoteNextAction's depositRows contract).
  const [depositRows, setDepositRows] = useState<Record<string, GateLedgerRow[]> | null>(null)
  const [recurrences, setRecurrences] = useState<JobRecurrence[]>([])
  const [lead, setLead] = useState<WebsiteLead | null>(null)
  // Raw rows for every source lib/timelineData pulls; the engine turns them into
  // events. quotes/jobs/invoices already live in their own state above, so they're
  // handed to buildTimeline directly rather than fetched twice.
  const [tlSources, setTlSources] = useState<CustomerTimelineSources & JobTimelineSources>({})
  // Names of the timeline sources whose read failed. The history is assembled from
  // a dozen reads and supabase-js resolves failures as empty, so without this a
  // dropped connection renders as "No history yet" — a claim about the customer
  // that the data never made. See lib/timelineData.
  const [loaderMissing, setLoaderMissing] = useState<string[]>([])
  const [seasons, setSeasons] = useState<ServiceSeasons>(DEFAULT_SEASONS)
  // What this business does, derived from its own catalogue and jobs — never asked.
  // Starts SHOWING everything, so a lawn field can't blink out mid-load.
  const [shape, setShape] = useState<BusinessShape>(SHAPE_LOADING)
  const [gstPercent, setGstPercent] = useState(0)
  const [pausing, setPausing] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // ── Read honesty ──────────────────────────────────────────────────────────
  // Which of this page's own slices the figures are allowed to stand on, and
  // where the rows on screen came from. A cached snapshot is a memory of the
  // last visit — shown, labelled, and never presented as today's answer until a
  // live read replaces it. (S111 audit: a failed quotes/jobs/invoices read used
  // to paint as $0 · "Nothing needs action" · a red retention alarm, and was
  // then CACHED as empty for two minutes; a failed refresh after a cached paint
  // was silent because loadError rendered only when no customer was on screen.)
  const [readMissing, setReadMissing] = useState<ReadSlice[]>([])
  const [source, setSource] = useState<'none' | 'cache' | 'live'>('none')
  const [portalBusy, setPortalBusy] = useState(false)
  const [portalCopied, setPortalCopied] = useState(false)
  const [showMessage, setShowMessage] = useState(false)
  // Edit core details in place — the profile could show a customer but not fix a
  // typo in their email without leaving for the list. Same shared form, in a modal.
  const [editing, setEditing] = useState(false)
  const [addingProperty, setAddingProperty] = useState(false)
  const [allCustomers, setAllCustomers] = useState<Customer[]>([])

  async function copyPortalLink() {
    if (!customer) return
    setPortalBusy(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const token = await ensurePortalToken(supabase, user.id, customer.id)
      if (!token) { toast.error('Could not create the portal link. Run the customer-portal migration first.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { toast('Portal link (copy manually): ' + url, { duration: 20000 }) }
      setPortalCopied(true); setTimeout(() => setPortalCopied(false), 2500)
    } finally { setPortalBusy(false) }
  }

  // Turn the old link off and hand back a new one. The portal has no password —
  // the link IS the credential — so when one gets forwarded to the wrong person,
  // or a phone goes missing, this is the only answer. The database has enforced
  // `revoked` all along; until now nothing could set it.
  async function resetPortalLink() {
    if (!customer) return
    const ok = await confirmDialog({
      title: 'Reset the portal link?',
      message: `${customer.name}’s current link stops working immediately, including any copy of it already sent. You’ll get a new link to send them.`,
      confirmLabel: 'Reset link', destructive: true,
    })
    if (!ok) return
    setPortalBusy(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const token = await rotatePortalToken(supabase, user.id, customer.id)
      // A failed rotate leaves the OLD link live. Saying "done" here would tell
      // the owner a leaked link was closed when it wasn't.
      if (!token) { toast.error('Could not reset the link — the old one is still active. Try again.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { toast('New portal link (copy manually): ' + url, { duration: 20000 }) }
      toast.success('Old link is off. The new link is on your clipboard.')
      setPortalCopied(true); setTimeout(() => setPortalCopied(false), 2500)
    } finally { setPortalBusy(false) }
  }

  async function openEdit() {
    // Lazy-load the name list once so the "Referred by" picker works while editing
    // (dup detection is off in edit mode, so id+name is all the form needs).
    if (allCustomers.length === 0) {
      const { data } = await supabase.from('customers').select('id, name').neq('id', id).order('name')
      setAllCustomers((data as Customer[]) || [])
    }
    setEditing(true)
  }

  // Customer V2: this form edits the RELATIONSHIP only. The two-table address
  // sync that used to live here (and once half-applied, sending a crew to the
  // wrong house) is gone with its cause — addresses are edited on the property
  // itself, in its own section below, one table, one write.
  // Resolves FALSE when the update failed, so the form keeps its autosave draft rather
  // than clearing it on a save that never landed.
  async function handleSaveEdit(values: CustomerFormValues): Promise<boolean> {
    // Explicit WHITELIST (found in review): reset() keeps unregistered keys, so a
    // pre-V2 autosave draft can still carry address fields — a spread would write
    // them back invisibly. Consent stays out too: it's audited through the shared
    // engine and owned by the profile's Communication card.
    const patch = {
      name: values.name,
      email: values.email,
      phone: values.phone,
      notes: values.notes,
      acquisition_source: values.acquisition_source || null,
      referred_by_customer_id: values.referred_by_customer_id || null,
      birthday: values.birthday || null,
      anniversary: values.anniversary || null,
      tags: normalizeTags(values.tags || []),
    }
    const { error } = await supabase.from('customers').update(patch).eq('id', id)
    if (error) { toast.error('Could not save the customer: ' + error.message); return false }   // keep the form open — and its draft — to retry
    setEditing(false)
    reload()
    return true
  }

  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  // load() reruns on every realtime tick (payments, messages, jobs, quotes,
  // invoices, portal requests — see below) and re-seeds notesValue from the server.
  // That is right when the field is idle, but if the owner is mid-note when one of
  // those events fires, the re-seed wipes what they were typing. A ref (not a dep of
  // the load effect, which must NOT re-run each time the editor opens) lets load()
  // see "is the owner editing right now?" and skip the re-seed if so.
  const editingNotesRef = useRef(false)
  useEffect(() => { editingNotesRef.current = editingNotes }, [editingNotes])

  // Scheduling preferences (customer default + per-property override).
  const [editingPrefs, setEditingPrefs] = useState(false)
  const [prefsDraft, setPrefsDraft] = useState<PrefsDraft>(EMPTY_DRAFT)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [editingPropPrefs, setEditingPropPrefs] = useState<string | null>(null)
  const [propPrefsDraft, setPropPrefsDraft] = useState<PrefsDraft>(EMPTY_DRAFT)
  const [savingPropPrefs, setSavingPropPrefs] = useState(false)
  // Remove-property: which property is mid-check/mid-delete, and the "can't
  // remove because…" explanation pinned to its card (cleared on retry/success).
  const [removingProp, setRemovingProp] = useState<string | null>(null)
  const [blockedProp, setBlockedProp] = useState<{ id: string; message: string } | null>(null)

  // Instant paint from a warm cache (hover prefetch on the list, or a prior
  // visit). The load effect below revalidates right after, so it's never stale-stuck.
  useEffect(() => {
    const cached = readCache<CustomerPrefetch>(custCacheKey(id), CACHE_TTL.short)
    if (cached?.customer) {
      setCustomer(cached.customer)
      setNotesValue(cached.customer.notes || '')
      setProperties(cached.properties)
      setQuotes(cached.quotes)
      setJobs(cached.jobs)
      setInvoices(cached.invoices)
      setReadMissing([])          // a snapshot is only ever written clean (see load)
      setSource('cache')          // …and is a memory until the live read lands
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    // ONE run owns the screen. reload() (tick) re-runs this effect, and React runs
    // the previous run's cleanup first — which retires it: after any await a
    // retired run applies nothing (no state, no banner, no cache write), so the
    // run that started LAST is the only one that can land. Without this, a slow
    // first load resolving after a Try-again / realtime reload overwrote the
    // fresher rows (and re-cached them), or raised its stale failure banner over
    // a successful retry. This is about ORDER within one customer, not identity:
    // an id change already unmounts this instance — the [id] segment is keyed by
    // its value — so no run here ever sees another customer's id.
    let active = true
    loadGen.current += 1
    async function load() {
      const lease = cacheLease()
      // Local session read (no GoTrue round-trip). ONE batch for everything that
      // depends only on the customer id / user id — the referrer name + referred-revenue
      // are the only reads that need a prior result, so they run in a tiny second
      // round-trip below. This replaces ~5 serial hops that also re-ran in full on every
      // realtime refresh.
      const { data: { session } } = await supabase.auth.getSession()
      if (!active) return
      const user = session?.user
      // No session must not strand the skeleton forever.
      if (!user) { setLoading(false); return }
      const [cRes, pRes, qRes, jRes, iRes, refRes, recRes, depRes, setRes, lRes, shapeRes, tlCustomer] = await Promise.all([
        supabase.from('customers').select('*').eq('id', id).eq('user_id', user!.id).single(),
        supabase.from('properties').select('*').eq('customer_id', id).order('is_primary', { ascending: false }),
        supabase.from('quotes').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
        supabase.from('jobs').select('*').eq('customer_id', id).order('scheduled_date', { ascending: true }),
        supabase.from('invoices').select('*').eq('customer_id', id).order('created_at', { ascending: false }),
        // Advocates this customer referred (needs only id).
        supabase.from('customers').select('id, name').eq('referred_by_customer_id', id),
        supabase.from('job_recurrences').select('*').eq('customer_id', id),
        // Quote-linked deposit ledger rows — the scheduling gate's input, so this
        // page's open items agree with the Pipeline board and the dashboard queue
        // about which bookings are secured.
        supabase.from('payments').select('quote_id, amount, kind, provider, status').eq('customer_id', id).not('quote_id', 'is', null),
        supabase.from('business_settings').select('service_seasons, gst_percent').eq('user_id', user!.id).maybeSingle(),
        // Newest website lead — the full intake detail (service/address/budget/schedule/contact/source).
        supabase.from('website_leads').select('*').eq('customer_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        // Does this business do lawn work? Derived from the owner's own catalogue
        // and job history (see lib/businessShape) — rides along in the batch that
        // was already going out. Never blocks the page: on failure the shape falls
        // back to showing everything, which is how the page behaved before it existed.
        loadBusinessShape(supabase, user!.id).catch(() => SHAPE_LOADING),
        // Every customer-scoped timeline source, in ONE place — lib/timelineData.
        // Still part of this batch, so it stays as parallel as it was inline.
        loadCustomerTimelineSources(supabase, user!.id, id),
      ])
      if (!active) return
      // A transient/network error must NOT render as "Customer not found." Only a
      // genuine no-rows result (.single() → PGRST116) means the customer is truly gone.
      if (cRes.error && cRes.error.code !== 'PGRST116') { setLoadError('Could not load this customer — check your connection.'); setLoading(false); return }
      setLoadError(null)
      const cust = cRes.data as Customer | null
      setCustomer(cust)
      // Keep the notes field in sync with the server ONLY while it's idle. Mid-edit,
      // a background refresh must not overwrite the owner's in-progress note (Cancel
      // still restores from the freshly-loaded `customer`). The rest of the page
      // stays live — this guards the one editable draft, nothing else.
      if (!editingNotesRef.current) setNotesValue(cust?.notes || '')
      // ⭐ A failed slice keeps whatever is on screen (last known good, or
      // nothing) and is NAMED in readMissing; the figures it feeds render as
      // "not loaded", not as zero. The realtime narrow path below already kept
      // last-known-good — the full load now follows the same rule.
      if (!pRes.error) setProperties((pRes.data as Property[]) || [])
      if (!qRes.error) setQuotes((qRes.data as Quote[]) || [])
      if (!jRes.error) setJobs((jRes.data as Job[]) || [])
      if (!iRes.error) setInvoices((iRes.data as Invoice[]) || [])
      const failedSlices = [
        ...(pRes.error ? ['Properties'] : []), ...(qRes.error ? ['Quotes'] : []),
        ...(jRes.error ? ['Jobs'] : []), ...(iRes.error ? ['Invoices'] : []),
      ] as ReadSlice[]
      setReadMissing(failedSlices)
      setSource('live')
      // A FAILED read stays null (gate skipped), never an empty map — an empty map
      // would claim every gated booking is unpaid.
      if (depRes.error) { setDepositRows(null) } else {
        const byQuote: Record<string, GateLedgerRow[]> = {}
        for (const r of (depRes.data as ({ quote_id: string | null } & GateLedgerRow)[]) || []) {
          if (r.quote_id) (byQuote[r.quote_id] ||= []).push(r)
        }
        setDepositRows(byQuote)
      }
      // Warm the cache so the next open (or a back-nav) paints instantly — but
      // ONLY a clean snapshot. A failed slice cached as [] replayed as "no
      // quotes" for two minutes, on every hover and back-nav, after the network
      // was back. (The lease, taken at fetch start, still decides the owner.)
      if (cust && failedSlices.length === 0) writeCache<CustomerPrefetch>(custCacheKey(id), {
        customer: cust, properties: (pRes.data as Property[]) || [], quotes: (qRes.data as Quote[]) || [],
        jobs: (jRes.data as Job[]) || [], invoices: (iRes.data as Invoice[]) || [],
      }, { lease })

      if (recRes.data) setRecurrences(recRes.data as JobRecurrence[])
      // Same rule the customer read above states: a transient error must not
      // render as an ANSWER. A failed lead read used to clobber the card into
      // "never submitted a lead"; now it keeps the last-known-good lead.
      if (!lRes.error) setLead((lRes.data as WebsiteLead | null) ?? null)
      setShape(shapeRes)
      setSeasons(settingsToSeasons((setRes.data as { service_seasons: unknown } | null)?.service_seasons))
      setGstPercent(Number((setRes.data as { gst_percent?: number | null } | null)?.gst_percent) || 0)

      // Dependent tail — the reads that need a prior result: the referrer's name (needs
      // cust.referred_by_customer_id), the revenue from people this customer referred
      // (needs the referred list), and the job-scoped timeline sources (need the job
      // ids). Run them together, not serially.
      const referredList = (refRes.data as { id: string; name: string }[]) || []
      const jobIds = ((jRes.data as Job[]) || []).map(j => j.id)
      const [referrerRes, referredRevRes, tlJob] = await Promise.all([
        cust?.referred_by_customer_id
          ? supabase.from('customers').select('id, name').eq('id', cust.referred_by_customer_id).maybeSingle()
          : null,
        referredList.length > 0
          ? supabase.from('quotes').select('total, status').in('customer_id', referredList.map(r => r.id))
          : null,
        loadJobTimelineSources(supabase, jobIds),
      ])
      if (!active) return

      // Hand the engine the rows; it decides what an event is. The page no longer
      // knows how a credit differs from a refund.
      setTlSources({ ...tlCustomer.sources, ...tlJob.sources })
      // The loader's own missing sources. quotes/jobs/invoices are this page's
      // slices and are named in readMissing; the Timeline card receives both.
      setLoaderMissing([...tlCustomer.missing, ...tlJob.missing])
      if (referrerRes?.data) setReferrer(referrerRes.data as { id: string; name: string })
      if (referredRevRes?.data) {
        // Referral revenue: the same exclusion rule as every other money
        // roll-up — an unpriced won quote is unknown, not a zero contribution.
        const rev = sumQuoteAmounts(
          (referredRevRes.data as { total: number; status: string }[]).filter(q => isWon(q.status)),
        ).total
        setReferredRevenue(rev)
      }

      setLoading(false)
    }
    load()
    return () => { active = false }
  }, [id, tick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live timeline: a new message, payment, quote/job/invoice change, or portal
  // request for THIS customer refreshes the page — no manual refresh. Tables must
  // be on the realtime publication (migration 2026-06-24d); unpublished ones just
  // stay quiet.
  //
  // SCOPED, not shotgun: a single inbound SMS used to re-run the ENTIRE load()
  // (~20 queries — every table, the timeline sources, the referrer tail). Each
  // table now enqueues its SCOPE and one dispatcher, after a short gather
  // window, refetches only what that scope actually feeds. The rules encode the
  // couplings the data layer has:
  //   payments  → also refetches invoices (recompute_invoice_paid_for mutates
  //               the invoice row server-side; its own event is belt-and-braces)
  //   jobs      → also reloads the job-scoped timeline sources (they key off
  //               the job-id list)
  //   customers → FULL reload (that row shapes referrer chain, notes, header)
  //   ≥6 scopes → FULL reload (that's a tab-wake/reconnect firing every
  //               subscription — exactly one load(), same as before)
  // buildTimeline consumes the per-table state slices + tlSources, so a narrow
  // path yields an identical timeline. The prefetch cache stays warmed by the
  // full path only — narrow paths never write a partial snapshot.
  const reload = () => setTick(t => t + 1)
  const pendingScopes = useRef<Set<string>>(new Set())
  const gatherTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const narrowRefetch = useCallback(async (scopes: Set<string>) => {
    // A full load that starts after this narrow refetch supersedes it: a slice
    // lands only while no newer full run has begun (the effect's own rule, from
    // the other side). A narrow refetch that starts DURING a full load is not
    // retired by it and may still be overwritten by that older run's slices —
    // a known limit, recorded in the guard.
    const gen = loadGen.current
    const live = () => gen === loadGen.current
    const tasks: PromiseLike<unknown>[] = []
    // A narrow refetch that fails must say so too, and one that succeeds must
    // clear the name — the same two-way rule the timeline warning follows.
    const noteSlice = (slice: ReadSlice, ok: boolean) =>
      setReadMissing(prev => ok ? prev.filter(s => s !== slice) : prev.includes(slice) ? prev : [...prev, slice])
    if (scopes.has('quotes')) tasks.push(
      supabase.from('quotes').select('*').eq('customer_id', id).order('created_at', { ascending: false })
        .then(r => { if (!live()) return; noteSlice('Quotes', !r.error); if (!r.error) setQuotes((r.data as Quote[]) || []) }),
    )
    if (scopes.has('jobs')) tasks.push((async () => {
      const r = await supabase.from('jobs').select('*').eq('customer_id', id).order('scheduled_date', { ascending: true })
      if (!live()) return
      noteSlice('Jobs', !r.error)
      if (r.error) return
      const rows = (r.data as Job[]) || []
      setJobs(rows)
      const tlJob = await loadJobTimelineSources(supabase, rows.map(j => j.id))
      if (!live()) return
      setTlSources(prev => ({ ...prev, ...tlJob.sources }))
    })())
    if (scopes.has('invoices') || scopes.has('payments')) tasks.push(
      supabase.from('invoices').select('*').eq('customer_id', id).order('created_at', { ascending: false })
        .then(r => { if (!live()) return; noteSlice('Invoices', !r.error); if (!r.error) setInvoices((r.data as Invoice[]) || []) }),
    )
    if (scopes.has('payments') || scopes.has('messages') || scopes.has('service_requests')) tasks.push((async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!live()) return
      const uid = session?.user?.id
      if (!uid) return
      const tlCust = await loadCustomerTimelineSources(supabase, uid, id)
      if (!live()) return
      setTlSources(prev => ({ ...prev, ...tlCust.sources }))
      // A realtime refetch that drops a source must state it too — and a clean
      // refetch must clear a stale warning, or the card cries wolf forever.
      setLoaderMissing(tlCust.missing)
    })())
    await Promise.all(tasks)
  }, [supabase, id])
  const narrowRefetchRef = useRef(narrowRefetch)
  narrowRefetchRef.current = narrowRefetch

  // Stable handler identities (built once, state via refs) — the realtime
  // hook's burst-coalescing keys on callback identity, so these must not churn.
  const scopeHandlers = useMemo(() => {
    const run = () => {
      const scopes = new Set(pendingScopes.current)
      pendingScopes.current.clear()
      if (scopes.size === 0) return
      if (scopes.has('customers') || scopes.size >= 6) { reload(); return }
      narrowRefetchRef.current(scopes)
    }
    const enqueue = (scope: string) => () => {
      pendingScopes.current.add(scope)
      // Gather the sibling subscriptions' debounce timers (they land within a
      // few ms of each other on a burst or wake) into ONE decision.
      if (gatherTimer.current) clearTimeout(gatherTimer.current)
      gatherTimer.current = setTimeout(() => { gatherTimer.current = null; run() }, 50)
    }
    return {
      quotes: enqueue('quotes'), jobs: enqueue('jobs'), invoices: enqueue('invoices'),
      messages: enqueue('messages'), payments: enqueue('payments'),
      service_requests: enqueue('service_requests'), customers: enqueue('customers'),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => { if (gatherTimer.current) clearTimeout(gatherTimer.current) }, [])

  const custFilter = id ? `customer_id=eq.${id}` : null
  useRealtimeRefresh('quotes', custFilter, scopeHandlers.quotes)
  useRealtimeRefresh('jobs', custFilter, scopeHandlers.jobs)
  useRealtimeRefresh('invoices', custFilter, scopeHandlers.invoices)
  useRealtimeRefresh('messages', custFilter, scopeHandlers.messages)
  useRealtimeRefresh('payments', custFilter, scopeHandlers.payments)
  useRealtimeRefresh('service_requests', custFilter, scopeHandlers.service_requests)
  useRealtimeRefresh('customers', id ? `id=eq.${id}` : null, scopeHandlers.customers)

  async function saveNotes() {
    if (!customer) return
    setSavingNotes(true)
    const patch = { notes: notesValue || null }
    try {
      const outcome = await queueOrRun(
        { kind: 'customer.update', payload: { id: customer.id, patch, baseUpdatedAt: customer.updated_at }, label: `Note · ${customer.name}` },
        async () => { const { error } = await supabase.from('customers').update(patch).eq('id', customer.id); if (error) throw new Error(error.message) },
      )
      setCustomer({ ...customer, notes: patch.notes })
      setEditingNotes(false)
      if (outcome === 'queued') toast.info('Saved offline — syncs when you’re back online.')
    } catch (e) {
      toast.error('Could not save the note: ' + (e instanceof Error ? e.message : 'unknown error'))   // keep the editor open
    } finally { setSavingNotes(false) }
  }

  function startEditPrefs() {
    setPrefsDraft(toDraft(customer))
    setEditingPrefs(true)
  }
  async function savePrefs() {
    if (!customer) return
    setSavingPrefs(true)
    const row = draftToRow(prefsDraft)
    try {
      const outcome = await queueOrRun(
        { kind: 'customer.update', payload: { id: customer.id, patch: row, baseUpdatedAt: customer.updated_at }, label: `Edit · ${customer.name}` },
        async () => { const { error } = await supabase.from('customers').update(row).eq('id', customer.id); if (error) throw new Error(error.message) },
      )
      setCustomer({ ...customer, ...row })
      setEditingPrefs(false)
      if (outcome === 'queued') toast.info('Saved offline — syncs when you’re back online.')
    } catch { toast.error('Could not save changes.') }   // keep the editor open — a failed save must not discard the draft
    finally { setSavingPrefs(false) }
  }

  function startEditPropPrefs(p: Property) {
    setPropPrefsDraft(toDraft(p))
    setEditingPropPrefs(p.id)
  }
  async function savePropPrefs(propId: string) {
    setSavingPropPrefs(true)
    const row = draftToRow(propPrefsDraft)
    const { error } = await supabase.from('properties').update(row).eq('id', propId)
    setSavingPropPrefs(false)
    if (error) {
      // Keep the editor open so the edit isn't lost — same behavior as saveNotes/savePrefs.
      toast.error('Could not save the override: ' + error.message)
      return
    }
    setProperties(prev => prev.map(p => p.id === propId ? { ...p, ...row } : p))
    setEditingPropPrefs(null)
  }

  // Remove a property — through THE seam (lib/customers.deleteProperty), which
  // refuses unless NOTHING refers to the address. The live-DB rule it enforces:
  // history FKs are SET NULL (a delete would strip identity off invoices/jobs/
  // quotes) and job_photos CASCADE (a delete would destroy them) — so linked
  // properties are blocked with the exact reasons, never archived (properties
  // have no archive), never cascaded. "0 jobs" alone proves nothing: photos,
  // measurements, quotes, invoices and leads are all checked too.
  //
  // Honest states, in order: checking (button busy) → blocked (inline reasons,
  // property stays) → confirm (names the address) → removing → removed (row
  // leaves the list ONLY after the delete PROVED a row went) → or failed
  // (toast; property remains — nothing optimistic anywhere in this path).
  async function removeProperty(p: Property) {
    if (removingProp) return
    setRemovingProp(p.id)
    setBlockedProp(null)
    try {
      const { links, error } = await propertyLinks(supabase, p.id)
      // A failed check is never an answer — refuse to open the confirm at all.
      if (error) { toast.error('Could not check this property’s records: ' + error); return }
      const held = links.filter(l => l.count > 0)
      if (held.length > 0) { setBlockedProp({ id: p.id, message: describePropertyLinks(held) }); return }
      const ok = await confirmDialog({
        title: `Remove ${propertyLabel(p)}?`,
        message: 'Nothing refers to this address — no visits, quotes, invoices, photos, measurements or leads. Removing it can’t be undone.',
        confirmLabel: 'Remove property', destructive: true,
      })
      if (!ok) return
      const res = await deleteProperty(supabase, { propertyId: p.id, customerId: customer!.id })
      if (res.error) { toast.error('Could not remove the property: ' + res.error); return }
      if (res.blocked) { setBlockedProp({ id: p.id, message: describePropertyLinks(res.blocked) }); return }
      // Confirmed gone — only now does the UI let go of it (and the roll-up
      // counts, which derive from this state, follow).
      setProperties(prev => prev.map(x => res.promotedId && x.id === res.promotedId ? { ...x, is_primary: true } : x).filter(x => x.id !== p.id))
      if (res.promoteError) toast(`Property removed — but the primary address couldn’t be reassigned (${res.promoteError}). Mark one of the remaining properties primary.`, { tone: 'error', duration: 12000 })
      else toast.success(`Removed ${propertyLabel(p)}.`)
    } finally {
      setRemovingProp(null)
    }
  }

  // Pause a schedule: cancel its FUTURE scheduled/in-progress visits (past visits
  // and the recurrence row are preserved, so it can be rebuilt later). Reuses the
  // jobs.status='cancelled' system — no new "paused" state needed.
  async function pauseSchedule(plan: ServicePlan) {
    const todayISO = localTodayISO()
    const futureIds = jobs
      .filter(j => j.recurrence_id === plan.recurrenceId && j.scheduled_date >= todayISO && (j.status === 'scheduled' || j.status === 'in_progress'))
      .map(j => j.id)
    if (futureIds.length === 0) return
    const ok = await confirmDialog({
      title: `Cancel ${futureIds.length} upcoming visit${futureIds.length !== 1 ? 's' : ''}?`,
      message: `This cancels every upcoming ${plan.serviceName} visit. Completed visits are kept. There is no pause to undo — restarting means scheduling the work again.`,
      confirmLabel: 'Cancel upcoming visits',
    })
    if (!ok) return
    setPausing(plan.recurrenceId)
    const { error } = await supabase.from('jobs').update({ status: 'cancelled' }).in('id', futureIds)
    if (error) toast.error('Could not cancel the upcoming visits: ' + error.message)
    else setJobs(prev => prev.map(j => futureIds.includes(j.id) ? { ...j, status: 'cancelled' } : j))
    setPausing(null)
  }

  // Heavy derivations, memoized and hoisted above the guards (Rules of Hooks) so editing
  // the controlled Notes / Prefs inputs on this page doesn't rebuild the service plans and
  // the full activity timeline on every keystroke — only when the underlying data changes.
  // Photos the customer attached during online booking (stored as URLs on the draft
  // quote's lead_meta.photos). Rendered read-only through the shared gallery/lightbox.
  const bookingPhotos = useMemo(() => bookingPhotosFromQuotes(quotes as unknown as { lead_meta?: unknown; created_at?: string | null }[]), [quotes])

  const servicePlans = useMemo(() => {
    const t = localTodayISO()
    const quotesById: Record<string, Quote> = {}
    for (const q of quotes) quotesById[q.id] = q
    const recsById: Record<string, JobRecurrence> = {}
    for (const r of recurrences) recsById[r.id] = r
    const planValueOf = (j: Job) => {
      const q = j.quote_id ? quotesById[j.quote_id] : null
      const rec = j.recurrence_id ? recsById[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq, j.is_initial_visit)
    }
    return buildServicePlans(recurrences, jobs, seasons, t, planValueOf)
  }, [quotes, recurrences, jobs, seasons])

  // ── Per-property roll-up ───────────────────────────────────────────────────
  // What's happening at each address, from the rows this page ALREADY loaded — no
  // extra query, no second source of truth. A customer with one property gets the
  // same answer they always had; a landlord with forty can see which of them is
  // actually earning without opening forty pages.
  //
  // Service plans come from buildServicePlans (THE recurrence engine), whose
  // propertyId is itself inferred from the series' child jobs — job_recurrences has
  // no property_id column. That works precisely because jobs are 100% property-
  // populated; it is the reason JobForm's hidden auto-select above is a real bug and
  // not a cosmetic one.
  // ONE balance engine for every owed figure on this page. invoiceBalance is the
  // same GST-inclusive, discount-aware rule the invoices page, the portal and the
  // GST return read — it replaces `amount * gstMult - amount_paid`, which was
  // hand-rolled in three places here (a fourth parallel copy of the balance rule
  // that could drift from the canonical per-component rounding). FeeSettings needs
  // only gst_percent, which is all this page loads.
  const feeSettings = useMemo(() => ({ gst_percent: gstPercent }), [gstPercent])
  const propRollup = useMemo(() => {
    const t = localTodayISO()
    const byProp: Record<string, {
      plans: ServicePlan[]; upcoming: Job[]; openQuotes: Quote[]; outstanding: number; lastServiceDate: string | null
    }> = {}
    const ensure = (pid: string) => (byProp[pid] ||= { plans: [], upcoming: [], openQuotes: [], outstanding: 0, lastServiceDate: null })
    for (const p of properties) ensure(p.id)
    for (const plan of servicePlans) if (plan.propertyId && byProp[plan.propertyId] && plan.status === 'active') byProp[plan.propertyId].plans.push(plan)
    for (const j of jobs) {
      if (!j.property_id || !byProp[j.property_id]) continue
      const e = byProp[j.property_id]
      if (j.scheduled_date >= t && (j.status === 'scheduled' || j.status === 'in_progress')) e.upcoming.push(j)
      if (j.status === 'completed' && (!e.lastServiceDate || j.scheduled_date > e.lastServiceDate)) e.lastServiceDate = j.scheduled_date
    }
    // "Open" = still awaiting an answer. Same terminal rule lib/followup leans on:
    // anything that left 'sent'/'draft' has been decided.
    for (const q of quotes) {
      if (!q.property_id || !byProp[q.property_id]) continue
      if (q.status === 'sent' || q.status === 'draft') byProp[q.property_id].openQuotes.push(q)
    }
    // GST-inclusive balance, cancelled/draft excluded — the same basis as the
    // Outstanding figure above, so a property's share can never exceed the total.
    for (const inv of invoices) {
      if (!inv.property_id || !byProp[inv.property_id]) continue
      if (inv.status === 'draft' || inv.status === 'cancelled') continue
      const bal = invoiceBalance(inv, feeSettings).balance
      if (bal > 0.01) byProp[inv.property_id].outstanding += bal
    }
    return byProp
  }, [properties, servicePlans, jobs, quotes, invoices, feeSettings])

  // The customer-level totals, summed from the same per-property figures so the
  // header and the rows can never disagree.
  const rollupTotals = useMemo(() => {
    const vals = Object.values(propRollup)
    return {
      properties: properties.length,
      activeServices: vals.reduce((s, v) => s + v.plans.length, 0),
      upcoming: vals.reduce((s, v) => s + v.upcoming.length, 0),
      openQuotes: vals.reduce((s, v) => s + v.openQuotes.length, 0),
      outstanding: vals.reduce((s, v) => s + v.outstanding, 0),
    }
  }, [propRollup, properties])

  // ONE engine builds the history — see lib/timeline.ts. The page only supplies rows;
  // TimelineCard does the filtering, searching and grouping over what comes back.
  const allEvents = useMemo(
    () => buildTimeline({ ...tlSources, quotes, jobs, invoices, gstPercent }),
    [tlSources, quotes, jobs, invoices, gstPercent],
  )

  // Tell the mobile + who is on screen, so "Quote" and "Visit" arrive already
  // knowing. Published as null until the row is actually here — an unpublished
  // context gives the plain sheet, which is the honest answer while loading.
  // `properties` is ordered is_primary first, so [0] is the address of record.
  // ⚠️ Above the early returns: a hook that runs conditionally is a hook that
  // changes order between renders.
  usePublishQuickAddContext(useMemo(() => (customer ? {
    kind: 'customer' as const,
    customerId: customer.id,
    customerName: customer.name,
    propertyId: properties[0]?.id ?? null,
  } : null), [customer, properties]))

  if (loading) return <PageContainer><SkeletonTiles count={4} /><SkeletonRows count={5} /></PageContainer>
  // Cached customer (if any) keeps showing on a revalidation blip; only when there's
  // genuinely nothing to show do we branch error-vs-not-found.
  if (!customer) return loadError ? (
    <div className="text-center py-16 text-sm">
      <p className="text-red-400">{loadError}</p>
      <Button size="sm" variant="secondary" className="mt-2" onClick={reload}>Retry</Button>
    </div>
  ) : (
    <div className="text-center py-16 text-sm">
      <p className="text-red-400">Customer not found — they may have been deleted.</p>
      <Link href="/dashboard/customers" className="mt-2 inline-block underline font-medium text-accent-text">Back to Customers</Link>
    </div>
  )

  const today = localTodayISO()

  // ── Read status ────────────────────────────────────────────────────────────
  // What each figure below may stand on. A slice in readMissing has no current
  // answer, so anything derived from it is shown as "not loaded" — never as 0,
  // never as "none", never as a retention alarm.
  const missing = new Set<ReadSlice>(readMissing)
  const unknownFrom = (...slices: ReadSlice[]) => slices.some(s => missing.has(s))
  const quotesUnknown = unknownFrom('Quotes')
  const jobsUnknown = unknownFrom('Jobs')
  const moneyUnknown = unknownFrom('Invoices')
  const openUnknown = (['Quotes', 'Jobs', 'Invoices'] as ReadSlice[]).filter(s => missing.has(s))
  const notLoaded = (slice: string) => `${slice} could not be loaded`
  // The Timeline card names both this page's failed slices and the loader's.
  const tlMissing = [...readMissing.filter(s => s !== 'Properties'), ...loaderMissing]

  // ── Revenue (three separate truths) ──
  const wonQuotes = quotes.filter(q => isWon(q.status))
  // ⛔ WAS `s + Number(q.total || 0)` across every won quote. An unpriced won
  // quote contributed a silent 0 to Booked Revenue AND a full 1 to the divisor
  // of the average — so the figure was wrong twice, and confidently.
  // Unknowns are now EXCLUDED and COUNTED, and the card says so. Excluding them
  // is honest; pretending they were zero is not.
  const wonPriced = wonQuotes.filter(q => quotePriceState(q) !== 'unpriced')
  const wonUnpriced = wonQuotes.length - wonPriced.length
  const bookedRevenue = wonPriced.reduce((s, q) => s + (quoteAmountOrNull(q) ?? 0), 0)
  // Collected = money actually received (ledger amount_paid, incl. partial payments);
  // Outstanding = remaining balance across issued invoices.
  const collectedRevenue = invoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0)
  // GST-inclusive + cancelled excluded — agrees with the Invoices page ledger math
  // because it IS that math: invoiceBalance, not a re-derivation.
  const outstandingRevenue = invoices
    .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
    .reduce((s, i) => s + Math.max(0, invoiceBalance(i, feeSettings).balance), 0)
  // Divide by what was actually SUMMED. Dividing a priced-only total by the
  // full won count is how an unpriced quote silently halves the average.
  const avgJobValue = wonPriced.length > 0 ? bookedRevenue / wonPriced.length : 0
  // "Open" = still awaiting an answer — the SAME 'sent'/'draft' rule the per-property
  // roll-up uses below, applied customer-wide for the header answer strip.
  const openQuotesAll = quotes.filter(q => q.status === 'sent' || q.status === 'draft')
  const openPriced = openQuotesAll.filter(q => quotePriceState(q) !== 'unpriced')
  const openUnpriced = openQuotesAll.length - openPriced.length
  const openQuoteValue = openPriced.reduce((s, q) => s + (quoteAmountOrNull(q) ?? 0), 0)

  // ── Upcoming + retention ──
  const upcoming = jobs
    .filter(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
  const nextVisit = upcoming[0] || null
  const completed = jobs.filter(j => j.status === 'completed')
  const lastServicedDate = completed.length > 0
    ? completed.map(j => j.scheduled_date).sort().slice(-1)[0]
    : null
  const lastServicedDays = daysSince(lastServicedDate)
  const hasRecurring = recurrences.length > 0 || jobs.some(j => j.recurrence_id)
  const primaryRec = recurrences[0] || null
  const recurringStatus = primaryRec
    ? recurringCustomerLabel(primaryRec.interval_unit, primaryRec.interval_count, primaryRec.freq)
    : hasRecurring ? 'Recurring' : null
  const remainingVisits = (rid: string) =>
    jobs.filter(j => j.recurrence_id === rid && j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress')).length

  const warnings: { tone: 'red' | 'amber'; text: string }[] = []
  // Every one of these is a statement about the JOBS slice; with that slice
  // missing, "no future visits" is not known, so no alarm is raised.
  if (!jobsUnknown && hasRecurring && upcoming.length === 0) {
    warnings.push({ tone: 'red', text: 'Recurring customer with no future visits scheduled — their series has run out.' })
  } else if (!jobsUnknown && upcoming.length === 0 && completed.length > 0) {
    warnings.push({ tone: 'amber', text: 'No upcoming visits scheduled.' })
  }
  if (!jobsUnknown && lastServicedDays != null && lastServicedDays > 60) {
    warnings.push({ tone: 'amber', text: `Last serviced ${lastServicedDays} days ago — may be worth a check-in.` })
  }

  // ── Open items (what needs action) ──
  // THE pipeline engine, one quote at a time (lib/pipeline quoteNextAction) —
  // the same verbs, the same rules and the same order the Pipeline board and the
  // dashboard queue use. This block used to be a THIRD opinion, and it was wrong
  // in a way nobody could see: its Schedule rule was `status === 'accepted'` with
  // no check for an existing job, so once you booked the work it kept telling you
  // to book it — forever, on the customer's own profile.
  interface OpenItem { key: string; icon: typeof FileText; label: string; sub: string; href: string; tone: string }
  const openItems: OpenItem[] = []
  {
    const booked = scheduledQuoteIds(jobs as unknown as { quote_id: string | null; status: string }[])
    // The invoice worth acting on for a quote: the one that still wants something.
    const invByQuote: Record<string, PInvoice> = {}
    for (const inv of invoices) {
      if (!inv.quote_id) continue
      const held = invByQuote[inv.quote_id]
      if (!held || held.status === 'cancelled' || (invoiceBalance(held, feeSettings).balance <= 0.01 && invoiceBalance(inv as unknown as PInvoice, feeSettings).balance > 0.01)) {
        invByQuote[inv.quote_id] = inv as unknown as PInvoice
      }
    }
    for (const q of quotes) {
      const action = quoteNextAction(q as unknown as PQuote, {
        booked,
        invoice: invByQuote[q.id] ?? null,
        customer: customer as unknown as PCustomer,
        depositRows: depositRows ? (depositRows[q.id] ?? []) : undefined,
        feeSettings, today,
      })
      // `wait` is not an open item — the profile lists what needs doing, and a
      // quote sent yesterday needs nothing. `log_loss` is optional by design and
      // is asked at the decline door, not nagged for here.
      if (!action || action.kind === 'wait' || action.kind === 'log_loss') continue
      openItems.push({
        key: `q-${q.id}`,
        icon: ACTION_ICON[action.kind] ?? FileText,
        label: `${action.label}: ${q.quote_number}`,
        sub: `${q.service_type}${q.total ? ` · ${formatCurrency(Number(q.total))}` : ''} · ${action.detail}`,
        href: action.href,
        tone: ACTION_TONE[action.kind] ?? 'text-amber-400',
      })
    }
    // Invoices with no quote behind them — one-off billing the loop above cannot
    // reach. Without this they would silently vanish from the profile.
    for (const inv of invoices.filter(i => OPEN_INVOICE.has(i.status) && !i.quote_id)) {
      const overdue = !!inv.due_date && inv.due_date < today
      // What's still OWED, not the invoice's face value. Same balance engine as everywhere else.
      const remaining = invoiceBalance(inv, feeSettings).balance
      openItems.push({ key: `inv-${inv.id}`, icon: Receipt, label: `${overdue ? 'Overdue' : inv.status === 'partial' ? 'Partially paid' : 'Unpaid'} invoice ${inv.invoice_number}`, sub: `${formatCurrency(remaining)}${inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}`, href: `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`, tone: overdue ? 'text-red-400' : 'text-amber-400' })
    }
  }

  const phone = customer.phone
  const isHighValue = bookedRevenue >= 2000

  // Service history from check-in/check-out data — real durations, not estimates.
  const timedVisits = completed.filter(j => Number(j.actual_minutes) > 0)
  const avgDuration = timedVisits.length
    ? Math.round(timedVisits.reduce((s, j) => s + Number(j.actual_minutes), 0) / timedVisits.length)
    : null

  const revenueCards = [
    // ⭐ The subtitle carries the exclusion. A total that quietly dropped records
    // is the same lie as one that counted them as zero — the reader cannot tell
    // either from a complete figure unless the figure says so.
    // A figure whose slice did not load is "—" with the reason as its subtitle:
    // the same honesty as the exclusion note, for the case where nothing came.
    {
      label: 'Booked Revenue',
      value: quotesUnknown ? '—' : formatCurrency(bookedRevenue),
      sub: quotesUnknown ? notLoaded('Quotes') : (excludedNote(wonUnpriced, 'quote') ?? 'Won quotes'),
      icon: DollarSign,
      color: 'text-accent-text',
    },
    { label: 'Collected', value: moneyUnknown ? '—' : formatCurrency(collectedRevenue), sub: moneyUnknown ? notLoaded('Invoices') : 'Invoices paid', icon: Wallet, color: 'text-emerald-400' },
    { label: 'Outstanding', value: moneyUnknown ? '—' : formatCurrency(outstandingRevenue), sub: moneyUnknown ? notLoaded('Invoices') : 'Billed, unpaid', icon: AlertTriangle, color: 'text-amber-400' },
    {
      label: 'Service History',
      value: jobsUnknown ? '—' : `${completed.length} visit${completed.length !== 1 ? 's' : ''}`,
      sub: jobsUnknown ? notLoaded('Jobs') : `${avgDuration != null ? `~${avgDuration} min avg` : 'No timed visits yet'}${lastServicedDate ? ` · last ${formatDate(lastServicedDate)}` : ''}`,
      icon: Timer, color: 'text-sky-400',
    },
  ]

  return (
    <PageContainer>
      {/* THE shared DetailHeader — same back/title/action anatomy as quotes/[id]. */}
      <DetailHeader
        title={customer.name}
        description={`Customer since ${formatDate(customer.created_at)}`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={openEdit} title="Edit name, contact and address">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button size="sm" variant="secondary" loading={portalBusy}
              title="Copy a private link the customer can use to view quotes, invoices, history & photos and accept quotes"
              onClick={copyPortalLink}>
              {portalCopied ? <><Check className="w-3.5 h-3.5" /> Link copied</> : <><Link2 className="w-3.5 h-3.5" /> Portal link</>}
            </Button>
            {/* Tucked behind the overflow, not beside Copy: resetting is rare and
                it breaks a link the customer may be using right now. */}
            <Menu align="end" width={240} ariaLabel="More customer actions" items={[
              {
                key: 'reset-portal', label: 'Reset portal link', icon: RotateCw, danger: true,
                description: 'Turns the current link off and issues a new one',
                onSelect: resetPortalLink,
              },
            ]}>
              {({ toggle, triggerProps }) => (
                <IconButton icon={MoreHorizontal} label="More customer actions" size="sm"
                  onClick={toggle} {...triggerProps} />
              )}
            </Menu>
          </div>
        }
      />

      {/* ── Read status — BEFORE any figure below claims to be the answer ──
          Three honest states, one banner each: a refresh that failed (the rows
          stay, labelled as the last visit's or the last loaded, with Retry —
          what the customers list does); a cached snapshot still refreshing (a
          memory, not today's answer); a live read with slices missing (named,
          and the figures they feed say "not loaded"). */}
      {loadError ? (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>
          {loadError}{' '}
          {source === 'cache'
            ? 'Showing details from your last visit — they may be out of date.'
            : 'Showing the last loaded details — they may be out of date.'}
        </Banner>
      ) : source === 'cache' ? (
        <Banner tone="info" icon={RotateCw}>
          Showing details from your last visit — refreshing now.
        </Banner>
      ) : readMissing.length > 0 ? (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>
          {readMissing.join(', ')} could not be loaded — the figures that depend on {readMissing.length > 1 ? 'them are' : 'it is'} shown as not loaded, not as zero.
        </Banner>
      ) : null}

      {/* Retention warnings — top, highly visible (THE shared Banner) */}
      {warnings.map((w, i) => (
        <Banner key={i} tone={w.tone === 'red' ? 'danger' : 'warn'} icon={AlertTriangle}>{w.text}</Banner>
      ))}

      {/* Identity + quick actions.
          ⭐ ON A PHONE THE ACTIONS COME BEFORE THE DOSSIER. Measured at 375×844:
          Call sat at y=380 under a header, a badge row, a contact line and a
          wrapping strip of up to eight metadata chips (source · referred by ·
          owes · next visit · open quotes · last serviced · birthday ·
          anniversary). Those chips are things to READ; Call, Message, Quote and
          Schedule are the things you opened this page to DO — and the page is
          most often opened with the customer already on the phone.
          Flex `order` rather than a second copy of either block: one DOM, no
          hydration seam, and `sm:` puts the desktop layout back exactly as it
          was (where nothing is below the fold anyway).
          gap-4 rather than space-y-4 on purpose — space-y hangs its margin on
          DOM order, which `order` then moves out from under it. */}
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="order-1 flex items-start gap-4">
            <Avatar name={customer.name} seed={customer.id} size="lg" />
            <div className="min-w-0 flex-1">
              {/* Name lives in the DetailHeader above — here we lead with status +
                  contact so the same name isn't stacked twice. */}
              {(isHighValue || recurringStatus || (customer.tags?.length ?? 0) > 0) && (
                <div className="flex items-center gap-2 flex-wrap">
                  {isHighValue && (
                    <span className="text-[10px] uppercase tracking-wide text-accent-text border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                      <Sparkles className="w-3 h-3" /> High value
                    </span>
                  )}
                  {recurringStatus && (
                    <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                      <Repeat className="w-3 h-3" /> {recurringStatus}
                    </span>
                  )}
                  {/* Owner-defined tags — edited via the customer form. Derived
                      badges above keep their colours; tags stay neutral so the
                      two vocabularies never blur. */}
                  {(customer.tags || []).map(t => (
                    <span key={t} className="text-[10px] uppercase tracking-wide text-ink-muted border border-border-strong bg-bg-tertiary rounded px-1.5 py-0.5 font-semibold flex items-center gap-1">
                      <Tag className="w-3 h-3" /> {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-x-4 gap-y-1 mt-1 flex-wrap text-sm">
                {customer.phone && (
                  <span className="flex items-center gap-1.5">
                    <a href={`tel:${customer.phone}`} className="flex items-center gap-1 text-accent-text hover:underline"><Phone className="w-3.5 h-3.5" />{customer.phone}</a>
                    <ConsentBadge on={!!customer.sms_opt_in} label="Texts" />
                  </span>
                )}
                {customer.email && (
                  <span className="flex items-center gap-1.5">
                    <a href={`mailto:${customer.email}`} className="flex items-center gap-1 text-ink-muted hover:text-ink"><Mail className="w-3.5 h-3.5" />{customer.email}</a>
                    <ConsentBadge on={!!customer.email_opt_in} label="Email" />
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* The dossier strip — everything above is WHO, this is WHAT WE KNOW.
              Lifted out of the avatar column so `order` can move it below the
              actions on a phone; `sm:ml-16` restores the desktop indent it had
              inside that column (avatar w-12 + gap-4). */}
          <div className="order-3 sm:order-2 sm:ml-16 -mt-2 sm:-mt-3">
              <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
                {/* THE source vocabulary lives in lib/attribution — this used to run
                    its own inline regex ('formspree|webhook|api|zapier' → 'Website'),
                    which was a second mapping of the same question in a file with no
                    business owning one. Same badge, one engine behind it, and the raw
                    words are still shown when they say more than the category does. */}
                {(() => {
                  const s = describeSource(customer.acquisition_source)
                  if (s.category === 'unknown') return null
                  const isWeb = s.category === 'online_form'
                  return (
                    <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                      {isWeb && <Globe className="w-2.5 h-2.5 text-ink-faint" />}{isWeb ? 'From website' : (s.detail ?? s.label)}
                    </span>
                  )
                })()}
                {referrer && (
                  <Link href={`/dashboard/customers/${referrer.id}`} className="text-xs text-ink-muted hover:text-ink flex items-center gap-1">
                    <Users className="w-3 h-3" /> Referred by {referrer.name}
                  </Link>
                )}
                {/* The answer strip — the two phone-call questions ("how much do I
                    owe?", "when are you coming?") were already computed on this page
                    but rendered many cards down. Same figures, beside the name. */}
                {moneyUnknown ? (
                  <span className="text-xs text-ink-faint flex items-center gap-1" title={notLoaded('Invoices')}>
                    <DollarSign className="w-3 h-3" /> Owed: not loaded
                  </span>
                ) : outstandingRevenue > 0 && (
                  <a href="#customer-revenue" className="text-xs text-amber-400 hover:underline flex items-center gap-1">
                    <DollarSign className="w-3 h-3" /> Owes {formatCurrency(outstandingRevenue)}
                  </a>
                )}
                {jobsUnknown ? (
                  <span className="text-xs text-ink-faint flex items-center gap-1" title={notLoaded('Jobs')}>
                    <CalendarClock className="w-3 h-3" /> Next visit: not loaded
                  </span>
                ) : nextVisit && (
                  <span className="text-xs text-ink-muted flex items-center gap-1">
                    <CalendarClock className="w-3 h-3" /> Next visit {formatDate(nextVisit.scheduled_date)}
                  </span>
                )}
                {!quotesUnknown && openQuotesAll.length > 0 && (
                  <span className="text-xs text-ink-muted flex items-center gap-1">
                    <FileText className="w-3 h-3" /> {openQuotesAll.length} open quote{openQuotesAll.length !== 1 ? 's' : ''} · {formatCurrency(openQuoteValue)}
                    {/* The count and the money come from DIFFERENT sets when a
                        quote is unpriced — say which, rather than letting the
                        reader assume the figure covers all of them. */}
                    {openUnpriced > 0 && <span className="text-ink-faint"> ({openUnpriced} not priced)</span>}
                  </span>
                )}
                {lastServicedDays != null && (
                  <span className="text-xs text-ink-faint">Last serviced {lastServicedDays}d ago</span>
                )}
                {mdLabel(customer.birthday) && (
                  <span className="text-xs text-ink-faint flex items-center gap-1"><Cake className="w-3 h-3" /> {mdLabel(customer.birthday)}</span>
                )}
                {mdLabel(customer.anniversary) && (
                  <span className="text-xs text-ink-faint flex items-center gap-1"><PartyPopper className="w-3 h-3" /> {mdLabel(customer.anniversary)}</span>
                )}
              </div>
          </div>

          {/* Quick actions — one tap, large targets. order-2 on a phone puts
              them directly under the name and contact line; sm: restores the
              desktop order (dossier, then actions). */}
          <div className="order-2 sm:order-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Link href={`/dashboard/quotes/new?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium bg-accent text-black hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <FilePlus className="w-4 h-4" /> New quote
            </Link>
            <Link href={`/dashboard/schedule?customer=${customer.id}`} className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <CalendarPlus className="w-4 h-4" /> Schedule
            </Link>
            {/* Booking a visit to PRICE the work, which is not the same door as
                booking the work — see lib/estimateAppointments. */}
            <Link href={`/dashboard/schedule?estimate=new&customer=${customer.id}`} title="Book a visit to look at the work and quote it" className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <Ruler className="w-4 h-4" /> Estimate
            </Link>
            <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone} className={`h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-50'}`}>
              <Phone className="w-4 h-4" /> Call
            </a>
            {/* Opens the ONE shared Send Message dialog (templates + editable body,
                logged to the thread) — not a device-only sms: deep link. */}
            <button onClick={() => setShowMessage(true)}
              className="h-11 rounded-xl flex items-center justify-center gap-1.5 text-sm font-medium border bg-surface border-border text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <MessageSquare className="w-4 h-4" /> Message
            </button>
          </div>
          <SendMessageDialog open={showMessage} onClose={() => setShowMessage(false)}
            customerId={customer.id} customerName={customer.name} />
        </CardBody>
      </Card>

      {/* Website lead — the full intake detail (service · address · budget · schedule
          · contact · source), shown identically to the Messages inbox card. */}
      {lead && <LeadSummary lead={lead} />}

      {/* Photos the customer attached when booking — the SAME read-only gallery +
          lightbox (thumbnails · enlarge · download) used everywhere else. */}
      {bookingPhotos.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-accent-text" />
            <h2 className="text-sm font-semibold text-ink">Customer photos</h2>
            <span className="ml-auto text-xs text-ink-faint">{bookingPhotos.length} from booking</span>
          </CardHeader>
          <CardBody>
            <JobPhotos propertyId={null} variant="gallery" readOnly initialPhotos={bookingPhotos} />
          </CardBody>
        </Card>
      )}

      {/* Open items — "what needs action for this customer" comes FIRST, right under
          the identity card (it was buried five cards deep). */}
      <Card className={openItems.length > 0 ? 'border-amber-500/30' : ''}>
        <CardHeader className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-ink">Open Items</h2>
          {openItems.length > 0 && <span className="ml-auto text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">{openItems.length}</span>}
        </CardHeader>
        <CardBody className="p-0">
          {/* "Nothing needs action" is a claim about quotes, jobs and invoices
              together; with any of them missing it is not known. */}
          {openUnknown.length > 0 && (
            <p className="px-5 py-2 text-xs text-amber-400 border-b border-border">
              {openUnknown.join(', ')} could not be loaded — items from {openUnknown.length > 1 ? 'those' : 'it'} may be missing here.
            </p>
          )}
          {openItems.length === 0 ? (
            <InlineEmpty className="py-6">{openUnknown.length > 0 ? 'Could not check what needs action — use Try again above.' : 'Nothing needs action right now.'}</InlineEmpty>
          ) : (
            <div className="divide-y divide-border">
              {openItems.map(item => {
                const Icon = item.icon
                return (
                  <Link key={item.key} href={item.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-raised transition-colors">
                    <Icon className={`w-4 h-4 shrink-0 ${item.tone}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate">{item.label}</p>
                      <p className="text-xs text-ink-muted truncate">{item.sub}</p>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Notes & access info — prominent, quick-edit */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><StickyNote className="w-4 h-4 text-accent-text" /> Notes & Access Info</h2>
          {!editingNotes && (
            <button onClick={() => setEditingNotes(true)} className="text-xs text-accent-text hover:underline flex items-center gap-1">
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
        </CardHeader>
        <CardBody>
          {editingNotes ? (
            <div className="space-y-3">
              <Textarea
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                // ⌘/Ctrl+Enter saves, Escape cancels — the same keyboard contract
                // ui/Modal already gives every dialog, so the busiest inline editor
                // in the app doesn't force a trip to the mouse mid-note. Mirrors the
                // Save/Cancel buttons below exactly (Cancel restores the saved value).
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!savingNotes) saveNotes() }
                  else if (e.key === 'Escape') { e.preventDefault(); setNotesValue(customer.notes || ''); setEditingNotes(false) }
                }}
                rows={4}
                autoFocus
                placeholder="Gate codes, dog info, preferred contact, billing notes, access instructions, equipment restrictions..."
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveNotes} loading={savingNotes}>Save note</Button>
                <Button size="sm" variant="ghost" onClick={() => { setNotesValue(customer.notes || ''); setEditingNotes(false) }}>Cancel</Button>
              </div>
            </div>
          ) : customer.notes ? (
            <p className="text-sm text-ink whitespace-pre-wrap">{customer.notes}</p>
          ) : (
            <button onClick={() => setEditingNotes(true)} className="text-sm text-ink-faint hover:text-ink-muted transition-colors">
              No notes yet — add gate codes, dog info, access instructions…
            </button>
          )}
        </CardBody>
      </Card>

      {/* The owner's own attributes for a customer. Renders nothing at all when
          this business has defined none, so an account that never opens Settings
          › Custom fields never sees a trace of the feature. */}
      <CustomFieldsSection entity="customer" recordId={customer.id} />

      {/* Revenue + service history — anchor target for the header's "Owes" chip */}
      <div id="customer-revenue" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {revenueCards.map(c => {
          const Icon = c.icon
          return (
            <Card key={c.label} className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-[0.14em]">{c.label}</p>
                <Icon className={`w-4 h-4 ${c.color}`} />
              </div>
              <p className="text-xl sm:text-2xl font-bold text-ink tracking-tight tabular-nums mt-2">{c.value}</p>
              <p className="text-xs text-ink-faint mt-1">{c.sub}</p>
            </Card>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted -mt-2">
        <span>Accepted jobs: <span className="text-ink font-medium">{quotesUnknown ? '—' : wonQuotes.length}</span> of {quotesUnknown ? '—' : quotes.length}</span>
        <span>Avg job value: <span className="text-ink font-medium">{quotesUnknown ? '—' : formatCurrency(avgJobValue)}</span></span>
      </div>

      {/* Current Service Plan — the recurring schedule at a glance */}
      {servicePlans.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Repeat className="w-4 h-4 text-accent-text" />
            <h2 className="text-sm font-semibold text-ink">Current Service Plan</h2>
          </CardHeader>
          <CardBody className="space-y-3">
            {servicePlans.map(plan => (
              <ServicePlanRow
                key={plan.recurrenceId}
                plan={plan}
                customerId={id}
                pausing={pausing === plan.recurrenceId}
                onPause={() => pauseSchedule(plan)}
              />
            ))}
          </CardBody>
        </Card>
      )}

      {/* Upcoming work */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <CalendarPlus className="w-4 h-4 text-accent-text" />
          <h2 className="text-sm font-semibold text-ink">Upcoming Work</h2>
          {nextVisit && <span className="ml-auto text-xs text-ink-muted">Next visit: <span className="text-accent-text font-semibold">{formatDate(nextVisit.scheduled_date)}</span></span>}
        </CardHeader>
        <CardBody className="space-y-3">
          {recurrences.length > 0 && servicePlans.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {recurrences.map(r => {
                const remaining = remainingVisits(r.id)
                return (
                  <span key={r.id} className="text-xs flex items-center gap-1 text-accent-text border border-accent/20 bg-accent/10 rounded-lg px-2.5 py-1">
                    <Repeat className="w-3 h-3" /> {recurrenceLabel(r.interval_unit, r.interval_count, r.freq)}
                    {r.end_date ? ` until ${formatDate(r.end_date)}` : r.end_count ? ` · ${remaining} of ${r.end_count} left` : ' · ongoing'}
                    {!r.end_date && !r.end_count && remaining > 0 ? ` · ${remaining} upcoming` : ''}
                  </span>
                )
              })}
            </div>
          )}
          {upcoming.length === 0 ? (
            // Empty state leads to the fix, not just the fact (the warning banner
            // above already states it).
            <p className="text-sm text-ink-muted">
              No upcoming visits scheduled.{' '}
              <Link href={`/dashboard/schedule?customer=${customer.id}`} className="text-accent-text font-medium hover:underline">Schedule a visit →</Link>
            </p>
          ) : (
            <div className="divide-y divide-border -mx-2">
              {upcoming.map(j => (
                <div key={j.id} className="flex items-center justify-between px-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate flex items-center gap-1.5">
                      {j.recurrence_id && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}{j.title}
                    </p>
                    {j.service_type && <p className="text-xs text-ink-muted truncate">{j.service_type}</p>}
                  </div>
                  <span className="text-sm text-ink-muted shrink-0">{formatDate(j.scheduled_date)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Properties — the ADDRESS, and the per-property Maps / Quote / Job actions.
          It sat 18th of 19 cards, below a 440px conversation pane and two panels
          prod data says nobody uses. This is where someone standing in a driveway
          looks, so it belongs with the other daily-use cards, not after them. */}
      {/* Properties */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-accent-text" />
          <h2 className="text-sm font-semibold text-ink">Properties</h2>
          {properties.length > 0 && <span className="text-xs text-ink-faint tabular-nums">{properties.length}</span>}
          {/* A customer could own a second house and there was no way to say so from
              their profile — every properties.insert in the app was first-property-
              only (new customer, CSV import, or implied by a quote's address). The
              second address was reachable only by typing it into a quote. */}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAddingProperty(true)}>
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {/* The roll-up: what this customer's whole portfolio is doing, before the
              per-address detail. Summed from the rows already on the page, so it
              cannot disagree with the figures elsewhere on this profile. Hidden for
              a one-property customer — "1 property · 1 active service" is just their
              only property, restated. */}
          {properties.length > 1 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <RollupStat icon={Home} label="Properties" value={String(rollupTotals.properties)} />
              {/* Each stat stands on one slice; a slice that did not load is "—". */}
              <RollupStat icon={Repeat} label="Active services" value={jobsUnknown ? '—' : String(rollupTotals.activeServices)} />
              <RollupStat icon={CalendarClock} label="Upcoming visits" value={jobsUnknown ? '—' : String(rollupTotals.upcoming)} />
              <RollupStat icon={FileText} label="Open quotes" value={quotesUnknown ? '—' : String(rollupTotals.openQuotes)} />
              {(moneyUnknown || rollupTotals.outstanding > 0.01) && (
                <RollupStat icon={DollarSign} label="Outstanding" value={moneyUnknown ? '—' : formatCurrency(rollupTotals.outstanding)} tone="text-amber-400" />
              )}
            </div>
          )}
          {addingProperty && (
            <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
              {/* THE shared picker's inline-create, reused rather than a second address
                  form: it calls ensurePropertyForCustomer, so an address added here and
                  the same address typed into a quote resolve to ONE property. */}
              <PropertySelect
                properties={properties}
                value=""
                onChange={() => {}}
                customerId={id}
                onCreated={p => { setProperties(prev => [...prev, p]); setAddingProperty(false); toast.success(`${p.address} added.`) }}
                label="Add a property"
                hint="Search to check it isn’t already here, or add a new address."
                autoFocus
              />
              <div className="flex justify-end pt-2">
                <Button variant="ghost" size="sm" onClick={() => setAddingProperty(false)}>Done</Button>
              </div>
            </div>
          )}
          {unknownFrom('Properties') && properties.length === 0 && !addingProperty ? (
            <InlineEmpty className="py-6">Properties could not be loaded — use Try again above.</InlineEmpty>
          ) : properties.length === 0 && !addingProperty ? (
            // Properties are created from the customer's address, so "none" almost
            // always means "this customer has no address" — which is why they can't
            // be scheduled, measured or priced. Say that, and offer the fix.
            <InlineEmpty className="py-6">
              No properties on file — so there’s no address to schedule, measure or price.
              <button type="button" onClick={() => setAddingProperty(true)}
                className="block mx-auto mt-1.5 text-xs font-medium text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                Add their address →
              </button>
            </InlineEmpty>
          ) : properties.map(p => {
            const jobCount = jobs.filter(j => j.property_id === p.id).length
            // Lawn is the one measurement here that doesn't apply to every trade, so
            // it renders when the business does lawn work OR when THIS property
            // already holds a lawn size — never hide data someone entered. The rest
            // (fence, mulch, rock, driveway, lot) are generic property facts, and are
            // untouched.
            //
            // The `!= null` behind the gate is deliberately left as it was: a lawn
            // business with lawn_sqft = 0 still gets today's "Lawn 0 ft²" chip. It's
            // arguably noise, but it is EXISTING noise, and this change is not
            // allowed to alter what a lawn business sees.
            // fence/mulch/rock/driveway use `> 0`, not `!= null`: zero feet of
            // fence is not a measurement, it is the absence of one, and "Fence
            // 0 ft" would state a fact nobody established. (These four have no
            // writer anywhere in the app and are 0/62 populated in production —
            // so this changes nothing on screen today. It makes the rule true in
            // the code rather than true by accident, which is what stops the next
            // person wiring a writer that defaults them to 0.)
            const measures = [
              showLawnFieldFor(shape, p.lawn_sqft) && p.lawn_sqft != null && `Lawn ${Number(p.lawn_sqft).toLocaleString()} ft²`,
              Number(p.fence_length) > 0 && `Fence ${Number(p.fence_length).toLocaleString()} ft`,
              Number(p.mulch_area) > 0 && `Mulch ${Number(p.mulch_area).toLocaleString()} ft²`,
              Number(p.rock_area) > 0 && `Rock ${Number(p.rock_area).toLocaleString()} ft²`,
              Number(p.driveway_area) > 0 && `Driveway ${Number(p.driveway_area).toLocaleString()} ft²`,
              p.lot_size != null && `Lot ${Number(p.lot_size).toLocaleString()} ft²`,
            ].filter(Boolean) as string[]
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`
            return (
              <div key={p.id} className="rounded-xl border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  {/* Into this address's own history — for a customer with more than
                      one property, the profile timeline mixes them together. */}
                  <Link href={`/dashboard/properties/${p.id}`}
                    className="text-sm font-medium text-ink hover:text-accent-text transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    {/* propertyLabel adds the city when the street alone is ambiguous —
                        two "100 Main St" in different towns must not read as one. */}
                    {propertyLabel(p, { primaryTag: true })}
                  </Link>
                  <span className="text-xs text-ink-muted shrink-0">{jobCount} job{jobCount !== 1 ? 's' : ''}</span>
                </div>
                {/* What this ADDRESS is doing — the roll-up's per-property half. A job
                    count alone says how busy it's been, never whether it's earning,
                    booked, or owing. Each figure is omitted when it's zero: a quiet
                    property should read as quiet, not as a row of noughts. */}
                {(() => {
                  const r = propRollup[p.id]
                  if (!r) return null
                  const facts = [
                    r.plans.length > 0 && { icon: Repeat, text: r.plans.map(pl => pl.cadenceLabel).join(', '), tone: 'text-accent-text' },
                    r.upcoming.length > 0 && { icon: CalendarClock, text: `Next ${formatDate(r.upcoming[0].scheduled_date)}${r.upcoming.length > 1 ? ` · ${r.upcoming.length} booked` : ''}`, tone: 'text-ink-muted' },
                    r.openQuotes.length > 0 && { icon: FileText, text: `${r.openQuotes.length} open quote${r.openQuotes.length !== 1 ? 's' : ''}`, tone: 'text-ink-muted' },
                    r.outstanding > 0.01 && { icon: DollarSign, text: `${formatCurrency(r.outstanding)} outstanding`, tone: 'text-amber-400' },
                    !r.plans.length && !r.upcoming.length && r.lastServiceDate && { icon: History, text: `Last serviced ${formatDate(r.lastServiceDate)}`, tone: 'text-ink-faint' },
                  ].filter(Boolean) as { icon: typeof Repeat; text: string; tone: string }[]
                  if (!facts.length) return null
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                      {facts.map(f => (
                        <span key={f.text} className={`text-[11px] inline-flex items-center gap-1 ${f.tone}`}>
                          <f.icon className="w-3 h-3 shrink-0" /> {f.text}
                        </span>
                      ))}
                    </div>
                  )
                })()}
                {measures.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {measures.map(m => <span key={m} className="text-[11px] text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5">{m}</span>)}
                  </div>
                )}
                <p className="text-[11px] text-ink-faint mt-2">
                  {p.lat != null && p.lng != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'No coordinates yet'}
                </p>
                {/* Property actions — one tap each (2-up on phones for bigger targets).
                    Measure traces a LAWN boundary and writes lawn_sqft, so it's the one
                    action here that a plumber has no use for. It stays for anyone who
                    does lawn work, and for any property already measured (re-measure
                    must never become unreachable). The grid drops to 3 columns rather
                    than leaving a hole where it was. */}
                {(() => { const showMeasure = showLawnFieldFor(shape, p.lawn_sqft); return (
                <div className={`grid grid-cols-2 gap-1.5 mt-3 ${showMeasure ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                  <a href={mapsUrl} target="_blank" rel="noopener noreferrer" title="Open in Google Maps" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> Maps
                  </a>
                  <Link href={`/dashboard/quotes/new?customer=${customer.id}&property=${p.id}`} title="New quote" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                    <FilePlus className="w-3.5 h-3.5" /> Quote
                  </Link>
                  <Link href={`/dashboard/schedule?customer=${customer.id}&property=${p.id}`} title="Schedule a visit" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                    <CalendarPlus className="w-3.5 h-3.5" /> Job
                  </Link>
                  {showMeasure && (
                    <Link href={`/dashboard/properties/measure?id=${p.id}`} title="Re-measure property" className="h-9 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-colors">
                      <Ruler className="w-3.5 h-3.5" /> Measure
                    </Link>
                  )}
                </div>
                ) })()}

                {/* Scheduling override for this property (falls back to the customer default) */}
                <div className="mt-3 pt-3 border-t border-border">
                  {editingPropPrefs === p.id ? (
                    <div className="space-y-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
                        <CalendarClock className="w-3.5 h-3.5 text-accent-text" /> Scheduling override
                      </p>
                      <SchedulePrefsFields value={propPrefsDraft} onChange={setPropPrefsDraft} />
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={() => savePropPrefs(p.id)} loading={savingPropPrefs}>Save override</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingPropPrefs(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => startEditPropPrefs(p)} className="w-full text-left flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink transition-colors">
                      <CalendarClock className="w-3.5 h-3.5 text-accent-text shrink-0" />
                      <span className="min-w-0 truncate">
                        {hasAnyPref(p)
                          ? <>Override: {prefSummary(resolvePrefs(null, p))}</>
                          : prefSummary(resolvePrefs(customer))
                            ? <>Using customer default · {prefSummary(resolvePrefs(customer))}</>
                            : 'Set a scheduling override'}
                      </span>
                      <Edit2 className="w-3 h-3 shrink-0 ml-auto opacity-50" />
                    </button>
                  )}
                </div>

                {/* Remove — deliberately the quietest thing on the card, below the
                    fold of every routine action, so it cannot be hit reaching for
                    Maps/Quote/Job. The seam refuses unless nothing refers to this
                    address; when blocked, the reasons render right here instead of
                    a toast that outlives the context. */}
                <div className="mt-2 flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => removeProperty(p)}
                    disabled={removingProp !== null}
                    className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-red-400 disabled:opacity-50 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Trash2 className="w-3 h-3" aria-hidden />
                    {removingProp === p.id ? 'Checking records…' : 'Remove property'}
                  </button>
                  {blockedProp?.id === p.id && (
                    <p className="text-[11px] text-amber-400 text-right max-w-sm" role="status">
                      {blockedProp.message}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </CardBody>
      </Card>

      {/* Relationship history — THE answer to "what actually happened with this
          customer", built by lib/timeline.ts from the records that already own each
          event. It sits OUT of the disclosure below, and that is the point of this
          surface: understanding the relationship is why the profile gets opened, and
          a history needing a tap on "More about this customer" (whose summary line
          is hidden on a phone, so it never even says History there) is a history the
          owner does not have.

          Placed here deliberately: BELOW today's work (Open Items · Upcoming ·
          Properties) because history is context, not the next action — and ABOVE the
          AI brief and the 440px conversation pane, because those are the DETAIL and
          this is the summary of it. Measured at 375px: this position puts it ~640px
          nearer the top than sitting after the thread. Its own 8-event cap keeps the
          card to ~690px, about one screen. verify:mobile-shell pins both halves.

          Keyed by customer: navigating profile→profile (via "Referred by") keeps this
          component mounted, and a search typed for one customer must not silently
          filter the next one's history. */}
      <TimelineCard key={id} events={allEvents} missing={tlMissing} onRetry={reload} />

      {/* The comms cluster — health, AI brief, live thread, then consent + reference.
          It follows the daily-use cards above: the phone-call answers (owed · notes ·
          schedule) must never sit below a 440px conversation pane. */}
      {/* Communication health — opt-in/contact mismatches (only shows when relevant) */}
      <CommsHealth customer={customer} onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Preferred contact — what a message would ACTUALLY do, and what they asked
          for. Above the fold-out because "how do I contact them right now" is a
          phone-call question, like owed/notes/schedule. Consent itself stays in
          the Communication card below; this can never override it. */}
      <PreferredChannelCard customer={customer} onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* AI brief — on-demand summary of this customer's history (renders nothing
          when no AI key is configured; never automatic, never stored) */}
      <CustomerAiSummary customerId={customer.id} />

      {/* Conversation — two-way SMS + portal thread */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-ink">Conversation</h2>
          <p className="text-xs text-ink-faint mt-0.5">Two-way SMS &amp; portal messages with this customer.</p>
        </CardHeader>
        <CardBody>
          <div className="h-[440px]"><ConversationThread customerId={customer.id} /></div>
        </CardBody>
      </Card>

      {/* ── Everything below is REFERENCE, not today's work ──────────────────
          Measured on a phone before this: the profile ran 6,649px — 7.9 screens —
          with fourteen sections all expanded at equal weight. The parts an owner
          opens the page FOR (what's owed, what's booked, which properties) end
          about halfway down; the rest is consent settings, scheduling defaults,
          card-on-file, the full event history and referrals. Useful, but not what
          you came for, and scrolling past all of it to re-find Open Items is the
          friction. Behind one disclosure they cost a line instead of half the page,
          and NOTHING is removed — one tap restores every card exactly as it was. */}
      <MoreAboutCustomer>
      {/* Change history — WHO changed what on this customer's records.
          Deliberately NOT a second timeline: TimelineCard above says what happened
          WITH this customer (quotes, visits, money, messages) and is the reason the
          page gets opened; this answers the different question of who changed it and
          what it was before. It lives in the disclosure because that is reference
          material — and because the relationship history must keep the position
          verify:mobile-shell pins for it. */}
      <Card>
        <CardBody>
          <HistoryPanel
            filter={{ customerId: customer.id }}
            title="Change history"
            emptyText="No recorded changes for this customer yet."
            pageSize={10}
          />
        </CardBody>
      </Card>

      {/* Communication — consent + history */}
      <CustomerComms customerId={customer.id} smsOptIn={!!customer.sms_opt_in} emailOptIn={!!customer.email_opt_in}
        onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Review lifecycle — ask, then record the outcome (stops asking once done) */}
      <ReviewLifecycle customer={customer} onChange={patch => setCustomer({ ...customer, ...patch })} />

      {/* Scheduling preferences — customer-wide default (properties can override) */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CalendarClock className="w-4 h-4 text-accent-text" /> Scheduling Preferences</h2>
          {!editingPrefs && (
            <button onClick={startEditPrefs} className="text-xs text-accent-text hover:underline flex items-center gap-1">
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
        </CardHeader>
        <CardBody>
          {editingPrefs ? (
            <div className="space-y-3">
              <SchedulePrefsFields value={prefsDraft} onChange={setPrefsDraft} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={savePrefs} loading={savingPrefs}>Save preferences</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingPrefs(false)}>Cancel</Button>
              </div>
            </div>
          ) : prefSummary(resolvePrefs(customer)) ? (
            <p className="text-sm text-ink">{prefSummary(resolvePrefs(customer))}</p>
          ) : (
            <button onClick={startEditPrefs} className="text-sm text-ink-faint hover:text-ink-muted transition-colors text-left">
              No preferences set — add preferred/avoid days or a time window (e.g. “always Fridays, mornings”).
            </button>
          )}
        </CardBody>
      </Card>

      {/* Payment method + AutoPay (card-on-file for recurring customers) */}
      <PaymentMethodCard customer={customer} onCustomerChange={patch => setCustomer({ ...customer, ...patch })} />


      {/* Referrals — advocates this customer brought in (with statuses + rewards) */}
      <ReferralPanel customer={customer} referrer={referrer} referredRevenue={referredRevenue} />
      </MoreAboutCustomer>

      {/* Edit core details — the ONE shared customer form, in a modal (no page leave) */}
      <Modal open={editing} onClose={() => setEditing(false)} title="Edit customer" icon={Edit2} size="lg">
        <CustomerForm
          isEdit
          customers={allCustomers}
          autosaveKey={`customer:${customer.id}`}
          // A draft older than the stored row is stale — never offer it. Without this
          // baseline, a month-old abandoned draft is presented as "unsaved changes" over
          // a record that has since been edited, and one tap on Restore silently reverts
          // the newer name/email/phone/tags.
          baselineUpdatedAt={customer.updated_at}
          defaultValues={{
            name: customer.name || '',
            email: customer.email || '',
            phone: customer.phone || '',
            notes: customer.notes || '',
            acquisition_source: customer.acquisition_source || '',
            referred_by_customer_id: customer.referred_by_customer_id || '',
            birthday: customer.birthday || '',
            anniversary: customer.anniversary || '',
            tags: customer.tags || [],
          }}
          onSubmit={handleSaveEdit}
          onCancel={() => setEditing(false)}
        />
      </Modal>
    </PageContainer>
  )
}

// One figure in the portfolio roll-up. Deliberately a plain fact with a label and
// no trend, sparkline or delta: the question it answers is "how many, right now".
function RollupStat({ icon: Icon, label, value, tone = 'text-ink' }: {
  icon: typeof Home; label: string; value: string; tone?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">
        <Icon className="w-3 h-3 shrink-0" /> {label}
      </p>
      <p className={`text-sm font-bold tabular-nums ${tone}`}>{value}</p>
    </div>
  )
}

// One recurring schedule, summarised — visible without opening the calendar.
// What a stopped plan says, per status. One sentence each, and each one says
// something DIFFERENT to do — the old copy said "schedule it again to resume"
// to a customer whose season simply hadn't come round yet.
const PLAN_STATUS_DETAIL: Record<PlanStatus, string> = {
  active: '',
  dormant: 'Out of season — nothing to do until it comes round again',
  ended: 'Every visit on this plan has been delivered',
  cancelled_ahead: 'The upcoming visits were cancelled — schedule again to restart',
  ran_dry: 'No visits left on the calendar — schedule again to keep it going',
}

function ServicePlanRow({ plan, customerId, pausing, onPause }: {
  plan: ServicePlan; customerId: string; pausing: boolean; onPause: () => void
}) {
  const stopped = plan.status !== 'active'
  return (
    <div className={`rounded-xl border p-3 ${stopped ? 'border-border bg-bg-tertiary' : 'border-accent/20 bg-accent/5'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink flex flex-wrap items-center gap-1.5">
            <Repeat className={`w-3.5 h-3.5 shrink-0 ${stopped ? 'text-ink-faint' : 'text-accent-text'}`} />
            {plan.serviceName}
            {stopped && <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded px-1.5 py-0.5">{PLAN_STATUS_LABEL[plan.status]}</span>}
          </p>
          <p className="text-xs text-ink-muted mt-0.5">
            {plan.cadenceLabel}
            {plan.weekday && <> · {plan.weekday}</>}
            {plan.windowLabel && <> · {plan.windowLabel}</>}
          </p>
          <p className="text-xs mt-0.5">
            {stopped
              ? <span className="text-ink-faint">{PLAN_STATUS_DETAIL[plan.status]}</span>
              : <span className="text-accent-text font-semibold">{plan.remaining} visit{plan.remaining !== 1 ? 's' : ''} remaining{plan.nextVisitDate ? ` · next ${formatDate(plan.nextVisitDate)}` : ''}</span>}
          </p>
          {/* Initial vs recurring pricing — only when they actually differ */}
          {(plan.recurringPrice ?? 0) > 0 && (
            <p className="text-[11px] text-ink-muted mt-0.5">
              {plan.initialPrice != null && plan.initialPrice !== plan.recurringPrice
                ? <>First visit <span className="font-semibold text-ink">{formatCurrency(plan.initialPrice)}</span>, then <span className="font-semibold text-ink">{formatCurrency(plan.recurringPrice!)}</span>/visit</>
                : <><span className="font-semibold text-ink">{formatCurrency(plan.recurringPrice!)}</span>/visit</>}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-2.5">
        {/* One entry into the schedule — focuses this plan when it has an upcoming visit. */}
        <ButtonLink
          href={!stopped && plan.nextVisitDate ? `/dashboard/schedule?focus=${plan.recurrenceId}` : `/dashboard/schedule?customer=${customerId}`}
          variant="secondary" size="sm">
          Open schedule
        </ButtonLink>
        {/* Named for what it DOES. There is no pause primitive: this cancels the
            upcoming visits, and the link below opens a new-job form rather than
            restoring anything — calling that pair Pause/Resume promised a state
            the product does not have. */}
        {!stopped && plan.remaining > 0 && (
          <Button variant="ghost" size="sm" loading={pausing} onClick={onPause}>
            Cancel upcoming visits
          </Button>
        )}
        {/* A finished plan and a dormant season are not waiting to be re-booked;
            offering "Schedule again" there invents work the owner didn't ask for. */}
        {(plan.status === 'cancelled_ahead' || plan.status === 'ran_dry') && (
          <ButtonLink href={`/dashboard/schedule?customer=${customerId}`} variant="secondary" size="sm">
            Schedule again
          </ButtonLink>
        )}
      </div>
    </div>
  )
}

// ── "More about this customer" ────────────────────────────────────────────────
// A profile answers a short list of questions: who is this, how do I reach them,
// what do they owe, what's booked, which property. Everything else — consent
// settings, review state, scheduling defaults, card-on-file, the full event
// history, referrals — is reference material the owner looks up occasionally and
// scrolls past constantly. Measured before this existed: 6,649px on a phone,
// fourteen expanded sections, and the actionable half ended around y=3,300.
//
// Deliberately a DISCLOSURE and not a deletion: every card inside still exists,
// unchanged, one tap away. It is closed by default because the common case is
// "check this customer", not "audit this customer" — and the collapsed label names
// what is inside, so nothing becomes unfindable.
//
// Not the shared ui/Collapsible: that primitive draws its own bordered container,
// and each child here already renders a full <Card>, which would nest two borders.
function MoreAboutCustomer({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-3.5 text-left rounded-card border border-border bg-bg-secondary hover:bg-surface-raised/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <History className="w-4 h-4 text-ink-muted shrink-0" />
        <span className="text-sm font-semibold text-ink shrink-0">More about this customer</span>
        {!open && (
          <span className="text-xs text-ink-faint truncate min-w-0 hidden sm:inline">
            Messages &amp; consent · Review · Scheduling preferences · Payment method · Referrals
          </span>
        )}
        <ChevronDown className={cn('w-4 h-4 text-ink-faint ml-auto shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-6 animate-fade">{children}</div>}
    </div>
  )
}
