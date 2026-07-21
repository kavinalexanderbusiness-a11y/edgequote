'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clock, History, Home, Leaf, Loader2, MapPin, MessageSquare, MessageSquarePlus, Receipt, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { cn, formatCurrency, localTodayISO } from '@/lib/utils'
import { renderPortalInvoiceBlob, renderPortalQuoteBlob } from '@/lib/portalPdf'
import {
  buildPortalView, normalizePortal, parsePortalDeepLink, tabNavTarget,
  type PortalData, type SubmitRequestFn, type TabKey,
} from './model'
import type { PortalActions } from './components/shared'
import { HomeTab, ReviewCard, ConsentCard } from './components/HomeTab'
import { PropertyTab } from './components/PropertyTab'
import { VisitsTab } from './components/VisitsTab'
import { BillingTab } from './components/BillingTab'
import { MessagesTab } from './components/MessagesTab'
import { RequestsTab } from './components/RequestsTab'

// ── Premium Customer Portal ─────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data — still
// THE only data source. The 2026-07 redesign reorganizes one story across six
// surfaces (Home · Property · Visits · Billing · Messages · Requests) with all
// derivation in ./model.ts and all presentation in ./components/*. Every
// customer action remains a REQUEST that threads into the owner's ONE Messages
// hub — the portal never mutates the schedule or a plan on its own.

export function PortalClient({ token, initialData }: { token: string; initialData: unknown }) {
  const supabase = useMemo(() => createClient(), [])
  // Seeded from the server fetch → real content on first paint (no spinner). load()
  // below only runs as a fallback / for post-payment revalidation.
  const [data, setData] = useState<PortalData | null>(() => normalizePortal(initialData))
  const [loading, setLoading] = useState(initialData == null)
  const [tab, setTab] = useState<TabKey>('home')
  const [accepting, setAccepting] = useState<string | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  // 'confirming' = the customer came back from Stripe but our ledger hasn't recorded
  // it yet; 'confirmed' = a new payment row actually landed. Never conflate the two.
  const [justPaid, setJustPaid] = useState<'confirming' | 'confirmed' | null>(null)
  const [justAccepted, setJustAccepted] = useState(false)
  // Billing opens pre-filtered to what the customer came for (the quote signpost
  // filters to quotes, the balance path to invoices).
  const [docsCat, setDocsCat] = useState<'all' | 'quote' | 'invoice'>('all')
  // A one-shot: the document a deep link (?invoice=/?quote=) asked us to land on.
  // Billing scrolls it into view and clears it; never persisted.
  const [focusDocId, setFocusDocId] = useState<string | null>(null)
  // One inline error surface for portal actions — fixed, friendly copy near the
  // top of the content, never a browser alert.
  const [actionError, setActionError] = useState<string | null>(null)
  const [consent, setConsentState] = useState<{ sms: boolean; email: boolean } | null>(() => {
    const pd = normalizePortal(initialData)
    return pd ? { sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in } : null
  })
  const [markedReviewed, setMarkedReviewed] = useState(false)
  // Seeded from the customer record, so a decline saved on an earlier visit keeps
  // the card down — the whole point of persisting it.
  const [reviewDeclined, setReviewDeclined] = useState(() => !!normalizePortal(initialData)?.customer?.review_declined_at)

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    const pd = normalizePortal(d)
    setData(pd)
    if (pd) setConsentState({ sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in })
    setLoading(false)
    return pd
  }

  // Self-serve consent — updates the customer record immediately (token-scoped RPC).
  async function saveConsent(next: { sms: boolean; email: boolean }, prefs?: Record<string, boolean>) {
    const prev = consent
    setConsentState(next)
    const { data: ok, error } = await supabase.rpc('portal_set_consent', { p_token: token, p_sms_opt_in: next.sms, p_email_opt_in: next.email, p_prefs: prefs ?? null })
    if (error || !ok) {
      setConsentState(prev) // roll back — never show a state the server didn't save
      setActionError('We couldn’t save your message preferences — please try again.')
    }
  }

  // Customer confirms they left a review → records it (notifies the owner, stops
  // future review-request messages). Optimistic with rollback; token-scoped RPC.
  async function markReviewed() {
    if (markedReviewed) return
    setMarkedReviewed(true)
    const { data: ok, error } = await supabase.rpc('portal_mark_reviewed', { p_token: token })
    if (error || !ok) setMarkedReviewed(false)
  }
  // "No thanks" — persisted via portal_decline_review so saying no means no
  // everywhere (the review cron suppresses on review_declined_at). Rolling back on
  // failure means the card reappears — right, because the decline wasn't saved.
  async function declineReview() {
    if (reviewDeclined) return
    setReviewDeclined(true)
    const { data: ok, error } = await supabase.rpc('portal_decline_review', { p_token: token })
    if (error || !ok) { setReviewDeclined(false); setActionError('We couldn’t save that — please try again.') }
  }

  // Server already provided initialData → no client fetch on first paint.
  useEffect(() => { if (initialData == null) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Payments availability + return-from-Stripe. ?paid=1 → the webhook marks the
  // invoice paid a beat later, so refetch shortly after.
  useEffect(() => {
    fetch('/api/payments/status').then(r => r.json()).then(d => setPaymentsEnabled(!!d.enabled)).catch(() => {})
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      if (sp.get('paid') === '1') {
        // ?paid=1 only means the customer reached Stripe's return URL — the WEBHOOK
        // records the money. Confirm against the reloaded ledger before claiming it.
        const before = data?.payments.length ?? 0
        setJustPaid('confirming')
        window.history.replaceState({}, '', `/portal/${token}`)
        setTimeout(async () => {
          const pd = await load()
          setJustPaid((pd?.payments.length ?? 0) > before ? 'confirmed' : 'confirming')
        }, 1500)
      }
      // Back from the hosted card-setup page — the webhook saves the card a beat
      // later, so reload shortly to show it.
      else if (sp.get('cardsaved') === '1') {
        setTab('billing')
        window.history.replaceState({}, '', `/portal/${token}`)
        setTimeout(() => load(), 1500)
      }
      // A deep link (?tab=/?invoice=/?quote=) — land where the link points, then
      // normalize the URL to a clean, persisted ?tab= form (dropping the one-shot
      // focus param). Runs only when this isn't a Stripe return, which owns its own
      // landing. A focus id that names no visible document just leaves Billing
      // unscrolled — the link can't lie about a document the customer can't see.
      else {
        const link = parsePortalDeepLink(window.location.search)
        if (link.tab) setTab(link.tab)
        if (link.docsCat) setDocsCat(link.docsCat)
        if (link.focusDocId) {
          setFocusDocId(link.focusDocId)
          // One-shot: stop it re-scrolling if they leave Billing and come back.
          setTimeout(() => setFocusDocId(null), 4000)
        }
        if (link.tab || link.focusDocId) {
          const qs = link.tab && link.tab !== 'home' ? `?tab=${link.tab}` : ''
          window.history.replaceState({}, '', `/portal/${token}${qs}`)
        }
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active tab pill scrolled into view when the row overflows on a
  // phone — a deep link (or a later tab) can otherwise land selected but
  // off-screen, so the customer can't see where they are. inline:'nearest'
  // scrolls only the pill row horizontally; block:'nearest' avoids a page jump.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.getElementById(`porttab-${tab}`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [tab])

  // ONE place a tab change happens — keeps state and the URL in step so a refresh
  // or a bookmark lands on the same tab instead of bouncing to Home. Billing's
  // category resets to 'all' unless a caller pre-filters it (the Home signpost).
  function goTab(next: TabKey, cat?: 'all' | 'quote' | 'invoice') {
    setTab(next)
    if (cat) setDocsCat(cat)
    else if (next === 'billing') setDocsCat('all')
    if (typeof window !== 'undefined') {
      const qs = next === 'home' ? '' : `?tab=${next}`
      window.history.replaceState({}, '', `/portal/${token}${qs}`)
    }
  }

  function photoUrl(path: string) { return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl }

  async function accept(qid: string) {
    if (accepting) return // double-click guard
    // Approving commits the customer to a quote value — never ask someone to
    // approve an amount without showing it, and always say that approving isn't
    // paying (the thing they're most afraid of when they tap).
    const q = data?.quotes.find(x => x.id === qid)
    const svc = (q?.service_type || '').trim()
    const amount = Number(q?.total) || 0
    const plan = q ? ([
      Number(q.weekly_price) > 0 ? `${formatCurrency(Number(q.weekly_price))} per weekly visit` : null,
      Number(q.biweekly_price) > 0 ? `${formatCurrency(Number(q.biweekly_price))} per bi-weekly visit` : null,
      Number(q.monthly_price) > 0 ? `${formatCurrency(Number(q.monthly_price))} per month` : null,
    ].filter(Boolean)[0] as string | undefined) : undefined
    const gst = Number(data?.business?.gst_percent) || 0
    const what = svc ? `${svc} for ${formatCurrency(amount)}` : formatCurrency(amount)
    const confirmed = await confirmDialog({
      title: `Approve ${formatCurrency(amount)}?`,
      message: [
        `You're approving ${what}${gst > 0 ? `, plus GST (${gst}%) added on your invoice` : ''}.`,
        plan ? `Ongoing visits after that are ${plan}.` : null,
        `Approving doesn't charge you — we'll confirm a date with you first, and you'll only get an invoice after the work is done.`,
      ].filter(Boolean).join(' '),
      confirmLabel: `Approve ${formatCurrency(amount)}`,
    })
    if (!confirmed) return
    setAccepting(qid)
    setActionError(null)
    const { data: ok } = await supabase.rpc('portal_accept_quote', { p_token: token, p_quote_id: qid })
    if (ok) {
      setData(d => d ? { ...d, quotes: d.quotes.map(q => q.id === qid ? { ...q, status: 'accepted' } : q) } : d)
      // Close the loop — the customer must SEE their approval registered.
      setJustAccepted(true)
    }
    else setActionError('We couldn’t record your approval — please try again, or reply to any message from us and we’ll take care of it.')
    setAccepting(null)
  }

  // Free-text / preset request. Returns success so the Requests tab can own its
  // sent/busy affordances locally.
  async function request(message: string): Promise<boolean> {
    if (!message.trim()) return false
    setActionError(null)
    const { data: ok } = await supabase.rpc('portal_request_service', { p_token: token, p_message: message.trim() })
    if (!ok) setActionError('Your request didn’t go through — please try again, or call us directly.')
    return !!ok
  }
  // Structured requests (appointment / reschedule / plan change) — same pipeline,
  // carrying structure alongside the human-readable message. The RPC re-verifies
  // that any referenced job/plan belongs to this token's customer.
  const submitRequest: SubmitRequestFn = async (opts) => {
    setActionError(null)
    const { data: ok, error } = await supabase.rpc('portal_submit_request', {
      p_token: token, p_message: opts.message, p_kind: opts.kind,
      p_preferred_date: opts.preferredDate ?? null, p_job_id: opts.jobId ?? null,
      p_recurrence_id: opts.recurrenceId ?? null, p_details: opts.details ?? null,
    })
    if (error || !ok) { setActionError('Your request didn’t go through — please try again, or call us directly.'); return false }
    return true
  }
  // The customer opened this invoice (PDF or pay) — stamp viewed_at once so the
  // owner's list shows 'Viewed'. Fire-and-forget; idempotent server-side.
  function markInvoiceViewed(invoiceId: string) {
    supabase.rpc('portal_mark_invoice_viewed', { p_token: token, p_invoice_id: invoiceId }).then(() => {}, () => {})
  }
  async function pay(invoiceId: string) {
    if (payingId) return // re-entry guard — never start two checkout sessions
    setPayingId(invoiceId)
    markInvoiceViewed(invoiceId)
    try {
      const res = await fetch('/api/portal/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, invoiceId }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return } // redirecting to Stripe — stay disabled
      // Public portal: show a FIXED message — never render a server-provided string.
      setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
    } catch {
      setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
    }
    setPayingId(null) // only reached on failure — a successful redirect already left the page
  }

  // ── The assembled view (ONE derivation pass; see model.ts) ──
  const view = useMemo(() => {
    if (!data) return null
    const fallbackAddress = data.property?.address || data.customer.address || null
    return buildPortalView(data, localTodayISO(), {
      quote: (qq) => renderPortalQuoteBlob(qq, data.customer.name, data.business),
      invoice: (ii) => renderPortalInvoiceBlob(ii, data.customer.name, fallbackAddress, data.business),
    }, markInvoiceViewed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-8">
      <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent-text" /></div>
      <p className="text-sm text-ink-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading your account…</p>
    </div>
  )
  if (!data || !view) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
        <Leaf className="w-10 h-10 text-ink-faint mb-3" />
        <p className="text-lg font-semibold text-ink">This link isn’t valid</p>
        <p className="text-sm text-ink-muted mt-1">It may have expired. Please contact your service provider for a new link.</p>
      </div>
    )
  }

  const biz = data.business
  const actions: PortalActions = {
    token, accept, accepting, pay, payingId, paymentsEnabled,
    request: (message: string) => request(message),
    submitRequest, photoUrl, markInvoiceViewed, refresh: load,
    navigate: (t, opts) => {
      goTab(t, opts?.docsCat)
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
    },
  }

  // Tab order = how often a customer reaches for each. Tabs whose surface would
  // be EMPTY are hidden (a fresh quote recipient sees Home/Billing/Requests, not
  // five dead ends) — each appears as soon as it has content. Messages and
  // Requests are always visible: their empty state IS the invitation.
  const docCount = data.quotes.length + data.invoices.filter(i => i.status !== 'draft').length
  // `unit` names the count for a screen reader — "Billing, 3 documents", not a
  // bare "Billing 3" that reads as an unlabelled number.
  const TABS: { key: TabKey; label: string; icon: typeof Home; n?: number; unit?: string }[] = ([
    { key: 'home', label: 'Home', icon: Home },
    { key: 'billing', label: 'Billing', icon: Receipt, n: docCount, unit: 'documents' },
    { key: 'visits', label: 'Visits', icon: History, n: view.derived.completed.length + view.derived.upcoming.length, unit: 'visits' },
    { key: 'property', label: view.multiProperty ? 'Properties' : 'Property', icon: MapPin, n: view.multiProperty ? view.properties.length : undefined, unit: 'properties' },
    { key: 'messages', label: 'Messages', icon: MessageSquare },
    { key: 'requests', label: 'Requests', icon: MessageSquarePlus },
  ] as { key: TabKey; label: string; icon: typeof Home; n?: number; unit?: string }[]).filter(t =>
    t.key === 'billing' ? (docCount > 0 || data.payments.length > 0) :
    t.key === 'visits' ? (data.jobs.length > 0 || data.photos.length > 0) :
    t.key === 'property' ? view.hasProperty :
    true)

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-5 pb-28">
        {/* Brand header */}
        <div className="flex items-center gap-3 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {biz?.logo_url ? <img src={biz.logo_url} alt="" className="h-10 w-auto object-contain" /> : <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center"><Leaf className="w-5 h-5 text-accent-text" /></div>}
          <div className="min-w-0">
            <p className="text-base font-bold text-ink truncate tracking-tight">{biz?.company_name || 'Your Service Provider'}</p>
            {/* Plain "Welcome" — a first-time quote recipient has never been here. */}
            <p className="text-xs text-ink-muted">Welcome, {view.firstName}</p>
          </div>
        </div>

        {/* Sticky tab bar — a real WAI-ARIA tablist: arrow keys move between tabs
            (roving tabindex), each pill meets the 44px gloved-thumb target on
            touch (.tap-target-y, pointer-coarse gated), and the active tab is
            kept scrolled into view so a deep link never lands it off-screen. */}
        <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/90 backdrop-blur border-b border-border">
          <div role="tablist" aria-label="Your account sections" aria-orientation="horizontal" className="flex gap-1.5 overflow-x-auto">
            {TABS.map((t, i) => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  id={`porttab-${t.key}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="portal-panel"
                  aria-label={t.n != null && t.n > 0 ? `${t.label}, ${t.n} ${t.unit ?? 'items'}` : t.label}
                  tabIndex={active ? 0 : -1}
                  onClick={() => goTab(t.key)}
                  onKeyDown={e => {
                    const target = tabNavTarget(e.key, i, TABS.length)
                    if (target === null) return
                    e.preventDefault()
                    const nextKey = TABS[target].key
                    goTab(nextKey)
                    document.getElementById(`porttab-${nextKey}`)?.focus()
                  }}
                  className={cn('tap-target-y shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-2 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    active ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                  <t.icon className="w-3.5 h-3.5" aria-hidden="true" /> {t.label}{t.n != null && t.n > 0 && <span className="opacity-70 tabular-nums" aria-hidden="true">{t.n}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-4">
          {justPaid === 'confirmed' && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Payment received — thank you!{' '}
                  <button onClick={() => goTab('billing')} className="underline underline-offset-2 hover:opacity-80">View your receipt →</button>
                </span>
              </span>
              <button onClick={() => setJustPaid(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {justPaid === 'confirming' && (
            <div className="mb-3 rounded-card border border-border bg-bg-tertiary text-ink-muted text-sm px-4 py-3 flex items-start justify-between gap-3">
              <span className="flex items-start gap-2 font-medium">
                <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Checkout completed — confirming your payment…{' '}
                  <span className="font-normal">Your receipt will appear here once it&rsquo;s confirmed. You don&rsquo;t need to pay again.</span>
                </span>
              </span>
              <button onClick={() => setJustPaid(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {justAccepted && (
            <div className="mb-3 rounded-card border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              {/* Say who will reach out and where the answer will appear, so they
                  can check instead of wait. */}
              <span className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Quote approved — thank you!{' '}
                  <span className="font-normal">{biz?.company_name || 'We'}&rsquo;ll contact you to agree a date. Once it&rsquo;s booked, your visit appears on this page — nothing else to do for now.</span>
                </span>
              </span>
              <button onClick={() => setJustAccepted(false)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {actionError && (
            <div className="mb-3 rounded-card border border-red-500/25 bg-red-500/10 text-red-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}

          {/* The single live panel, labelled by the active tab — completes the
              tablist/tab/tabpanel relationship for assistive tech. Global status
              banners above stay outside it (they aren't tab content). */}
          <div id="portal-panel" role="tabpanel" aria-labelledby={`porttab-${tab}`} tabIndex={-1} className="focus-visible:outline-none">
            {tab === 'home' && <HomeTab view={view} actions={actions} suppressApproved={justAccepted} />}
            {tab === 'home' && biz?.review_url && view.derived.lastCompleted && !data.customer.reviewed_at && !reviewDeclined && (
              <ReviewCard reviewUrl={biz.review_url} businessName={biz.company_name} reviewed={markedReviewed} onReviewed={markReviewed} onDecline={declineReview} />
            )}
            {tab === 'home' && consent && <ConsentCard token={token} consent={consent} onSave={saveConsent} />}
            {tab === 'property' && <PropertyTab view={view} actions={actions} />}
            {tab === 'visits' && <VisitsTab view={view} actions={actions} />}
            {tab === 'billing' && <BillingTab view={view} actions={actions} initialCat={docsCat} focusDocId={focusDocId} />}
            {tab === 'messages' && <MessagesTab view={view} actions={actions} />}
            {tab === 'requests' && <RequestsTab view={view} actions={actions} />}
          </div>
        </div>

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
      {/* Styled confirmation dialogs (card removal, quote approval…). */}
      <ConfirmHost />
    </div>
  )
}
