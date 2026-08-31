'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronRight, Clock, FileSignature, FileText, History, Home, Leaf, Loader2, MapPin, MessageSquare, Receipt, Wallet, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { cn, formatCurrency, localTodayISO } from '@/lib/utils'
import { displayQuoteStatus } from '@/lib/quoteStatus'
// THE scheduling-deposit rule (lib/payments/depositGate) — the approve dialog and
// success banner name the exact ask the charge route will make, from one engine.
import { requiredDeposit } from '@/lib/payments/depositGate'
// THE payment-timing words (lib/payments/paymentTiming) — the same reader the
// quote card and Home render, so the sentence at the moment of commitment cannot
// contradict the one that led the customer here.
import { paymentTiming, approvalTimingLine } from '@/lib/payments/paymentTiming'
import type { QuoteStatus } from '@/types'
import { renderPortalInvoiceBlob, renderPortalQuoteBlob } from '@/lib/portalPdf'
import { REQUEST_PHOTO_BUCKET, requestPhotoExt, requestPhotoPath } from '@/lib/portalRequests'
import {
  buildPortalView, contactGap, normalizePortal, parsePortalDeepLink, primaryPortalAction,
  recentPaymentLanded, tabNavTarget,
  type AddContactResult, type PortalData, type SubmitRequestFn, type TabKey,
} from './model'
import type { PortalActions } from './components/shared'
import { HomeTab, ReviewCard, ConsentCard, ContactMethodCard } from './components/HomeTab'
import { PropertyTab } from './components/PropertyTab'
import { VisitsTab } from './components/VisitsTab'
import { BillingTab } from './components/BillingTab'
import { MessagesTab } from './components/MessagesTab'
import { RequestsTab } from './components/RequestsTab'

// ── Premium Customer Portal ─────────────────────────────────────────────────
// Public, no-login, scoped to the token's customer via get_portal_data — still
// THE only data source. One story across five surfaces
// (Home · Visits · Billing · Property · Contact) with all derivation in
// ./model.ts and all presentation in ./components/*. Every customer action
// remains a REQUEST that threads into the owner's ONE Messages hub — the portal
// never mutates the schedule or a plan on its own.

// THE tab alias, in one place because two call sites set the tab: goTab (pills,
// in-app navigation) and the deep-link effect, which calls setTab DIRECTLY.
// 'requests' folded into Contact but stays a valid link key — every old
// ?tab=requests link, and Home's own "Request a service" button, must resolve to
// a destination that actually renders. Selecting a folded key would leave the
// panel empty with no pill selected, which is a blank portal.
// `multiProperty` decides one of them: a single-address customer's Property tab
// folded into Visits (their address, measurements and provider note now open it),
// so ?tab=property must land on Visits for them and stay put for a landlord.
function resolveTab(t: TabKey, multiProperty: boolean): TabKey {
  if (t === 'requests') return 'messages'
  if (t === 'property' && !multiProperty) return 'visits'
  return t
}

export function PortalClient({ token, initialData }: { token: string; initialData: unknown }) {
  const supabase = useMemo(() => createClient(), [])
  // Seeded from the server fetch → real content on first paint (no spinner). load()
  // below only runs as a fallback / for post-payment revalidation.
  const [data, setData] = useState<PortalData | null>(() => normalizePortal(initialData))
  // Mirrors `data` for the handlers that must read the CURRENT payload without
  // being re-created on every change (load()'s keep-what-we-have failure return,
  // and the visibility refetch's staleness check).
  const dataRef = useRef<PortalData | null>(null)
  // When the payload we're showing was last fetched — throttles the on-return
  // refetch below. Declared here (above load, which stamps it) rather than beside
  // its effect, so there is no doubt it exists before the first call.
  const lastLoadedAt = useRef(Date.now())
  const [loading, setLoading] = useState(initialData == null)
  const [tab, setTab] = useState<TabKey>('home')
  // Same fact model.ts derives as view.multiProperty (properties.length > 1), read
  // straight off the payload so it is available to the effects and handlers ABOVE
  // the view memo — the tab resolver needs it and runs in both places.
  const multiProperty = (data?.properties?.length ?? 0) > 1
  // THE tab actually shown. `tab` holds whatever was ASKED for — a pill, an in-app
  // navigate, or a deep link naming a folded destination — and this resolves it
  // against the payload. Resolving at render rather than at setTab time means the
  // answer is never guessed from data that hadn't loaded yet, and there is exactly
  // one place a folded key gets mapped.
  const activeTab = resolveTab(tab, multiProperty)
  const [accepting, setAccepting] = useState<string | null>(null)
  // Which change order is mid-decision (locks both buttons on that card).
  const [decidingChangeId, setDecidingChangeId] = useState<string | null>(null)
  const [paymentsEnabled, setPaymentsEnabled] = useState(false)
  const [payingId, setPayingId] = useState<string | null>(null)
  // 'confirming' = the customer came back from Stripe but our ledger hasn't recorded
  // it yet; 'confirmed' = a new payment row actually landed. Never conflate the two.
  const [justPaid, setJustPaid] = useState<'confirming' | 'confirmed' | null>(null)
  const [justAccepted, setJustAccepted] = useState(false)
  // The scheduling deposit the just-approved quote asks for (engine-derived at
  // accept time) — the success banner names the NEXT step instead of promising
  // "nothing else to do" about a booking that still needs securing.
  const [acceptedDepositAsk, setAcceptedDepositAsk] = useState<number | null>(null)
  const [payingQuoteId, setPayingQuoteId] = useState<string | null>(null)
  // Billing opens pre-filtered to what the customer came for (the quote signpost
  // filters to quotes, the balance path to invoices).
  const [docsCat, setDocsCat] = useState<'all' | 'quote' | 'invoice'>('all')
  // A one-shot: the document a deep link (?invoice=/?quote=) asked us to land on.
  // Billing scrolls it into view and clears it; never persisted.
  const [focusDocId, setFocusDocId] = useState<string | null>(null)
  // A one-shot seed for the Messages composer — set by "ask about this <doc>",
  // consumed by MessagesTab on open, then cleared so a later visit starts blank.
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  // The next-action banner the customer dismissed (by its stable key) — stays
  // gone until the situation changes (they pay, a new quote arrives), which
  // mints a new key and lets it return for the genuinely new thing.
  const [dismissedAction, setDismissedAction] = useState<string | null>(null)
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

  // Refetch the ONE data source. Returns the payload, or null when the token is
  // genuinely not valid — never on a network failure.
  //
  // This used to read only `data` and hand the result straight to setData. But
  // supabase-js does not throw on a dead connection: it RESOLVES with
  // { data: null, error }, so a flaky refetch was byte-identical to a revoked
  // token — and setData(null) drops the whole portal for the full-screen "This
  // link isn't valid. It may have expired." Every refetch path could trigger it
  // (the post-payment reload most cruelly: pay, walk out of wifi range, and the
  // portal tells you your link is dead seconds after taking your money). The
  // discriminator is `error`: a bad token returns SQL null with NO error, so
  // error != null means the network failed and the data we already have is still
  // the best truth we hold. Keep it, say so, and let the next attempt heal it.
  async function load(): Promise<PortalData | null> {
    const { data: d, error } = await supabase.rpc('get_portal_data', { p_token: token })
    setLoading(false)
    if (error) {
      setActionError('We couldn’t refresh your account just now — you’re seeing the last information we loaded. Check your connection and try again.')
      return dataRef.current
    }
    const pd = normalizePortal(d)
    setData(pd)
    dataRef.current = pd
    lastLoadedAt.current = Date.now()
    if (pd) setConsentState({ sms: !!pd.customer?.sms_opt_in, email: !!pd.customer?.email_opt_in })
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

  // Keep the ref in step with every setData (the optimistic accept patch included).
  useEffect(() => { dataRef.current = data }, [data])

  // Server already provided initialData → no client fetch on first paint.
  useEffect(() => { if (initialData == null) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when the customer comes BACK to the tab. The portal has no realtime
  // subscription and no polling, and it was loaded exactly once — so a tab opened
  // from a quote text and left alive (the normal phone pattern; the accept
  // handler's own comment concedes tabs live "overnight (or for a week)") kept
  // rendering the schedule, quotes and balances as they were the moment it
  // opened. The owner reschedules Thursday's visit or records an e-transfer, and
  // the customer's screen still shows the old date and an unpaid invoice with a
  // live Pay button — which is how a portal costs trust rather than building it.
  //
  // Refetch on return, throttled so tab-flicking can't hammer the RPC, and only
  // when the page is actually visible. Safe now that load() keeps what it has on
  // a failed refetch — before that guard this same effect would have turned every
  // backgrounded tab on a flaky connection into "This link isn't valid".
  const REFETCH_AFTER_MS = 60_000
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastLoadedAt.current < REFETCH_AFTER_MS) return
      lastLoadedAt.current = Date.now()
      void load()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    // pageshow fires on a bfcache restore (iOS Safari back-from-Stripe), where
    // neither visibilitychange nor focus is guaranteed.
    window.addEventListener('pageshow', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('pageshow', onWake)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Payments availability + return-from-Stripe. ?paid=1 → the webhook marks the
  // invoice paid a beat later, so refetch shortly after.
  useEffect(() => {
    let cancelled = false
    let paidTimer: ReturnType<typeof setTimeout> | undefined
    // ?portal=<token> — no session exists here, so the status route resolves the
    // OWNER (and their platform online_payments grant) from the token
    // server-side. Without it the answer would be the deployment-wide one, which
    // is wrong for a business the platform hasn't granted online payments.
    fetch(`/api/payments/status?portal=${encodeURIComponent(token)}`).then(r => r.json()).then(d => setPaymentsEnabled(!!d.enabled)).catch(() => {})
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      if (sp.get('paid') === '1') {
        // ?paid=1 only means the customer reached Stripe's return URL — the WEBHOOK
        // records the money. Confirm against the LEDGER before claiming it.
        //
        // This was one refetch, 1.5s after landing, comparing row COUNTS. Both
        // halves failed in production, in opposite directions:
        // • Too slow: a webhook that takes longer than 1.5s (a retry, a cold start)
        //   got no second look, so a customer who paid sat on "confirming…"
        //   indefinitely — unable to answer the one question that matters right
        //   after paying: did it work? A POLL fixes that half.
        // • Too fast: the webhook usually BEATS our return trip, so the row is
        //   already in the server-rendered payload the count is measured against.
        //   It can never increase, and no amount of polling helps — the count-delta
        //   test itself is what's wrong. Asking what the ledger HOLDS
        //   (recentPaymentLanded — a recent completed payment) answers both
        //   orderings with one question, and confirms on the FIRST paint when the
        //   money is already there.
        // Still strictly a ledger check: nothing here trusts the URL, and when the
        // window closes with nothing it stays honestly on "confirming" rather than
        // asserting a payment we cannot see.
        setJustPaid('confirming')
        window.history.replaceState({}, '', `/portal/${token}`)
        if (recentPaymentLanded(data?.payments, Date.now())) setJustPaid('confirmed')
        else {
          let tries = 0
          const MAX_TRIES = 9
          const poll = async () => {
            if (cancelled) return
            const pd = await load()
            if (cancelled) return
            if (recentPaymentLanded(pd?.payments, Date.now())) { setJustPaid('confirmed'); return }
            // Not recorded yet — try again, or leave it 'confirming' (the banner
            // already promises the receipt will appear here and not to pay again).
            if (++tries < MAX_TRIES) paidTimer = setTimeout(poll, 2000)
          }
          paidTimer = setTimeout(poll, 1500)
        }
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
        // The RAW key is stored; `activeTab` below resolves it at render, when the
        // payload — and therefore multiProperty — is actually known. Resolving here
        // would run before a non-SSR-seeded load returns, so a landlord deep-linked
        // to ?tab=property would be redirected to Visits on a guess.
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
    // Stop the post-payment poll if the customer leaves before it resolves.
    return () => { cancelled = true; if (paidTimer) clearTimeout(paidTimer) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active tab pill scrolled into view when the row overflows on a
  // phone — a deep link (or a later tab) can otherwise land selected but
  // off-screen, so the customer can't see where they are. inline:'nearest'
  // scrolls only the pill row horizontally; block:'nearest' avoids a page jump.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.getElementById(`porttab-${activeTab}`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTab])

  // ONE place a tab change happens — keeps state and the URL in step so a refresh
  // or a bookmark lands on the same tab instead of bouncing to Home. Billing's
  // category resets to 'all' unless a caller pre-filters it (the Home signpost).
  function goTab(rawNext: TabKey, cat?: 'all' | 'quote' | 'invoice') {
    const next = resolveTab(rawNext, multiProperty)
    setTab(next)
    if (cat) setDocsCat(cat)
    else if (next === 'billing') setDocsCat('all')
    if (typeof window !== 'undefined') {
      const qs = next === 'home' ? '' : `?tab=${next}`
      window.history.replaceState({}, '', `/portal/${token}${qs}`)
    }
  }

  function photoUrl(path: string) { return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl }

  async function accept(qid: string, optionId?: string, termsAck?: boolean) {
    if (accepting) return // double-click guard
    // Approving commits the customer to a quote value — never ask someone to
    // approve an amount without showing it, and always say that approving isn't
    // paying (the thing they're most afraid of when they tap).
    //
    // Re-read the quote from the server FIRST. portal_accept_quote snapshots
    // accepted_price from the row's CURRENT total, while this dialog quoted the
    // payload the tab loaded — which for a tab left open is however old that tab
    // is. An owner editing a still-'sent' quote (a supported flow that leaves the
    // status alone) meant the customer was shown $500, tapped approve, and the
    // business recorded consent to $800: the one number the whole screen exists to
    // agree on, and the two sides disagreed. One refetch before the dialog closes
    // that gap to a single round trip, and it also gives the expiry/status checks
    // below current data to judge instead of a week-old snapshot.
    setAccepting(qid)
    const fresh = await load()
    setAccepting(null)
    const q = (fresh ?? data)?.quotes.find(x => x.id === qid)
    if (!q) {
      setActionError('We couldn’t find that quote just now — please refresh, or message us below and we’ll help.')
      return
    }
    if (q.status !== 'sent') {
      // Someone (or something) moved it while this tab watched the old state:
      // already accepted in another tab, or withdrawn by the business.
      setActionError(q.status === 'accepted'
        ? 'This quote is already accepted — nothing more to do.'
        : 'This quote is no longer open for acceptance — message us below and we’ll sort it out.')
      return
    }
    // Expiry is judged AT CLICK TIME, not at page load. The render path already
    // labels an expired quote via the shared engine — but a portal tab left open
    // overnight (or for a week) still shows yesterday's button, and this handler
    // used to call the RPC regardless: a lapsed price could be accepted from a
    // stale tab. valid_until in the loaded payload is still the truth (expiry is
    // the DATE passing, not the data changing), so re-running the one shared
    // engine against TODAY closes the gap without touching any RPC.
    if (q && displayQuoteStatus({ status: q.status as QuoteStatus, valid_until: q.valid_until }, localTodayISO()) === 'expired') {
      setActionError('This quote has expired, so it can no longer be accepted from here — message us below and we’ll refresh the price for you.')
      // Re-derive the view so the button and label catch up with today.
      setData(d => d ? { ...d } : d)
      return
    }
    // ── Which alternative ─────────────────────────────────────────────────────
    // Re-resolved against the FRESH payload, never trusted from the click. The
    // refetch above exists because a tab left open can be quoting a stale price;
    // an option id from that same stale render deserves exactly as little trust.
    // If the named option is no longer on this quote (the owner revised it while
    // the tab sat open), stop — approving "whatever is there now" would record
    // consent to something the customer never read.
    const freshOpts = q?.options ?? []
    const chosenOpt = optionId ? freshOpts.find(o => o.id === optionId) ?? null : null
    if (optionId && !chosenOpt) {
      setActionError('That option isn’t on this quote any more — it may have been updated. Please refresh and take another look.')
      return
    }
    if (freshOpts.length > 0 && !chosenOpt) {
      // The button is disabled until one is picked, so this is a stale tab or a
      // replayed request — and the RPC would refuse it anyway. Say the useful
      // thing rather than let a silent false become "we couldn't record it".
      setActionError('This quote has a few options — please pick the one you want, then accept it.')
      return
    }

    const svc = (q?.service_type || '').trim()
    // ⭐ ONE money path. On an options quote the figure is the CHOSEN option plus
    // travel — the identical arithmetic quote_apply_option_choice performs when
    // it writes accepted_price — so the number in this dialog is the number the
    // business records. `q.total` still carries the recommended option at this
    // moment (nobody has chosen yet), and quoting it here would show one price
    // and bank another.
    const amount = chosenOpt
      ? Number(chosenOpt.price) + (Number(q?.travel_fee) || 0)
      : Number(q?.total) || 0
    // The dialog's whole job is stating what the customer commits to, so it must
    // match the doc row one tap beneath it:
    // • every plan price is PER VISIT (model.ts's own doc-row comment calls the
    //   "per month" reading a 4× misread the customer only discovers on their
    //   first bill — this dialog used to BE that misread, at the moment of
    //   commitment);
    // • several plan prices are OPTIONS — enumerate them instead of asserting
    //   the first as settled fact;
    // • a multi-service total must not be pinned on the primary service's name
    //   alone ("Mowing for $840" hides the other lines the row itemizes).
    const lineCount = q?.services?.length ?? 0
    const planBits = q ? [
      Number(q.weekly_price) > 0 ? `${formatCurrency(Number(q.weekly_price))} per weekly visit` : null,
      Number(q.biweekly_price) > 0 ? `${formatCurrency(Number(q.biweekly_price))} per bi-weekly visit` : null,
      Number(q.monthly_price) > 0 ? `${formatCurrency(Number(q.monthly_price))} per visit on the monthly plan` : null,
    ].filter((s): s is string => !!s) : []
    const plan = planBits.length > 1
      ? `Ongoing plan options: ${planBits.join(' · ')} — we'll confirm your schedule with you.`
      : planBits.length === 1 ? `Ongoing visits after that are ${planBits[0]}.` : null
    const gst = Number((fresh ?? data)?.business?.gst_percent) || 0
    // On an options quote the dialog must name the OPTION, not the service: the
    // whole decision the customer just made was which one, and confirming
    // "Landscape rebuild for $5,550" would echo back the part they didn't choose.
    const what = chosenOpt
      ? `the ${chosenOpt.name} option${svc ? ` of ${svc}` : ''} for ${formatCurrency(amount)}`
      : svc
        ? `${lineCount > 1 ? `${svc} + ${lineCount - 1} more service${lineCount > 2 ? 's' : ''}` : svc} for ${formatCurrency(amount)}`
        : formatCurrency(amount)
    // The scheduling deposit THIS approval will call for — the engine's own
    // figure over the amount being consented to (for an options quote, the
    // chosen option + travel: identical to what accepted_price will become).
    // Named at the moment of commitment: "approving doesn't charge you" must
    // not stand unqualified when a deposit request is the very next screen.
    //
    // ⭐ One object, read twice: `requiredDeposit` for the figure the banner and
    // the RPC path need, `paymentTiming` for the words. Both engines take the
    // SAME structural quote, so the sentence in the dialog and the number under
    // it are the same fact — the split that let a customer read "nothing is
    // charged" and then be asked for half the job cannot reopen here.
    const consented = {
      status: q.status, total: amount, accepted_price: amount,
      deposit_type: q.deposit_type ?? null, deposit_value: q.deposit_value ?? null,
    }
    const depositAsk = requiredDeposit(consented)
    const confirmed = await confirmDialog({
      // ⭐ ONE WORD, BOTH SIDES OF THE GLASS (Session 121). This dialog said
      // "Approve", the status pill said "Approved", the owner's own screen said
      // "Won", and four dashboard banners said "Accepted". The quote's state is
      // ACCEPTED everywhere now — including here, at the moment of commitment,
      // which is the one place the customer and the business must be using the
      // same word for the same act.
      title: chosenOpt ? `Accept ${chosenOpt.name} — ${formatCurrency(amount)}?` : `Accept ${formatCurrency(amount)}?`,
      message: [
        `You're accepting ${what}${gst > 0 ? `, plus GST (${gst}%) added on your invoice` : ''}.`,
        // Say what happens to the ones they didn't pick, at the moment of
        // commitment — "am I signing up for all three?" is the fear this whole
        // screen exists to answer, and it deserves answering here too.
        chosenOpt && freshOpts.length > 1
          ? `The other ${freshOpts.length - 1} option${freshOpts.length > 2 ? 's aren’t' : ' isn’t'} ordered and won’t be charged.`
          : null,
        plan,
        // ⭐ The timing sentence, from THE reader — no longer a pair of branches
        // this file maintains privately. The two strings it replaces were correct;
        // being correct in one file was never the problem.
        approvalTimingLine(paymentTiming(consented)),
      ].filter(Boolean).join(' '),
      confirmLabel: chosenOpt ? `Accept ${chosenOpt.name}` : `Accept ${formatCurrency(amount)}`,
    })
    if (!confirmed) return
    setAccepting(qid)
    setActionError(null)
    // The option argument is omitted, not null-defaulted, on an ordinary quote —
    // portal_accept_quote's plain path is reached exactly as it always was.
    //
    // ⭐ p_terms_ack is passed AS GIVEN, never coerced to true. The RPC refuses an
    // acceptance when the business has terms and this is false, and that refusal
    // is the point: an acknowledgement the customer did not make is worth less
    // than no acknowledgement at all, because it looks like one.
    const { data: ok } = await supabase.rpc('portal_accept_quote', {
      p_token: token, p_quote_id: qid, ...(chosenOpt ? { p_option_id: chosenOpt.id } : {}),
      p_terms_ack: !!termsAck,
    })
    if (ok) {
      // Carry the CHOICE into the optimistic patch, not just the status. Without
      // it the row would flip to Approved while still rendering three tappable
      // options — the customer's own decision missing from the screen that just
      // took it. (`total` is left alone: the next load brings the server's, and
      // guessing it here would be a second money path.)
      setData(d => d ? {
        ...d,
        quotes: d.quotes.map(q => q.id === qid
          ? { ...q, status: 'accepted', ...(chosenOpt ? { selected_option_id: chosenOpt.id } : {}) }
          : q),
      } : d)
      // Close the loop — the customer must SEE their approval registered, and
      // when a deposit stands between them and a booked date, the banner names
      // it rather than promising there's nothing left to do.
      setAcceptedDepositAsk(depositAsk > 0 ? depositAsk : null)
      setJustAccepted(true)
    } else {
      // A falsy result is NOT proof of failure. portal_accept_quote only matches a
      // row still in 'sent', so it returns false both when nothing happened AND
      // when the approval had already landed — the second tab of a link opened
      // twice, or a double-tap whose first call won. Telling that customer "we
      // couldn't record your approval — please try again" is the worst available
      // answer: it is false, and it invites them to keep tapping an approval that
      // already stands. Ask the server what is actually true before reporting.
      const after = await load()
      const now = after?.quotes.find(x => x.id === qid)
      if (now && now.status !== 'sent') {
        // It DID land (here or in the other tab) — say so, and let the refetched
        // payload render the real status.
        setJustAccepted(true)
        setActionError(null)
      } else {
        setActionError('We couldn’t record your acceptance — please try again, or reply to any message from us and we’ll take care of it.')
      }
    }
    setAccepting(null)
  }

  // ── Answering a change order ────────────────────────────────────────────────
  // ONE door (portal_respond_change_order): token-scoped, row-scoped, and it only
  // matches a row still 'pending'. So a second tap, a second tab, or a decision
  // the owner recorded a moment ago all land on the same honest answer instead of
  // a second approval — and, as with quote approval, a falsy result is NOT proof
  // of failure. Ask the server what is true before telling the customer anything.
  async function respondToChange(changeOrderId: string, decision: 'approve' | 'decline'): Promise<boolean> {
    if (decidingChangeId) return false
    setDecidingChangeId(changeOrderId)
    setActionError(null)
    const { data: res, error } = await supabase.rpc('portal_respond_change_order', {
      p_token: token, p_change_order_id: changeOrderId, p_decision: decision,
    })
    const ok = !!(res as { ok?: boolean } | null)?.ok
    if (ok) {
      await load()
      setDecidingChangeId(null)
      return true
    }
    // Not pending any more? Then it was already answered — here, in another tab,
    // or by the business recording the answer we gave them on the phone. Saying
    // "that didn't work" would be false and would invite another tap.
    const after = await load()
    const now = (after?.change_orders || []).find(c => c.id === changeOrderId)
    setDecidingChangeId(null)
    if (now && now.status !== 'pending') return true
    setActionError(error
      ? 'We couldn’t reach the server just now — please try again, or reply to any message from us.'
      : 'We couldn’t record that just now — please try again, or reply to any message from us and we’ll sort it out.')
    return false
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
  // Self-serve contact detail — fills a MISSING phone/email on this customer's own
  // record. Token-scoped RPC, same shape as saveConsent above: there is no customer
  // id to pass, because the token is the only thing that decides whose row moves.
  //
  // NOT optimistic, unlike consent. A wrong consent toggle is visibly wrong and one
  // tap from being fixed; a contact detail the portal *claims* to have saved and
  // hasn't is invisible to everyone until the day someone tries to use it. So the
  // card only reports success from the row state the RPC read back, and this
  // refetches so the prompt disappears because the FILE changed, not because the
  // client decided it had. A failed refetch leaves the card up — the write still
  // landed, and asking twice is cheaper than a silent gap.
  async function addContact(phone: string, email: string): Promise<AddContactResult> {
    setActionError(null)
    const { data, error } = await supabase.rpc('portal_add_contact', {
      p_token: token, p_phone: phone || null, p_email: email || null,
    })
    // supabase-js RESOLVES { data: null, error } on a dropped connection, so the
    // error object is the only thing separating "the server said no" from "we never
    // reached the server" — the discriminator load() documents.
    if (error) return { ok: false, reason: 'network' }
    const res = (data ?? { ok: false, reason: 'network' }) as AddContactResult
    if (res.ok) await load()
    return res
  }
  // Structured requests (appointment / reschedule / plan change / extra work) —
  // same pipeline, carrying structure alongside the human-readable message. The
  // RPC re-verifies that any referenced job/plan belongs to this token's
  // customer, and refuses (rather than silently drops) a photo path it doesn't
  // recognise.
  const submitRequest: SubmitRequestFn = async (opts) => {
    setActionError(null)
    const { data: ok, error } = await supabase.rpc('portal_submit_request', {
      p_token: token, p_message: opts.message, p_kind: opts.kind,
      p_preferred_date: opts.preferredDate ?? null, p_job_id: opts.jobId ?? null,
      p_recurrence_id: opts.recurrenceId ?? null, p_details: opts.details ?? null,
      p_photos: opts.photos?.length ? opts.photos : null,
    })
    if (error || !ok) { setActionError('Your request didn’t go through — please try again, or call us directly.'); return false }
    return true
  }

  // Photos attached to a request. They go to the SAME public bucket the booking
  // door and website intake already use — one anon-upload path for
  // customer-supplied photos, not a second one — and what we keep is the storage
  // PATH, never a URL: the bucket is named in code wherever these are rendered,
  // so a stored value can't address another bucket or an outside host. The
  // customer's own FILE NAME is discarded (the path is two UUIDs and an
  // extension), and the portal token is deliberately absent from it, because a
  // token in a public-bucket URL is a token anyone holding that URL now has.
  //
  // Returns the paths that actually landed plus how many failed, so the caller
  // can say so. A photo that didn't upload must never be presented as attached.
  async function uploadRequestPhotos(files: File[]): Promise<{ paths: string[]; failed: number }> {
    const batch = crypto.randomUUID()
    const paths: string[] = []
    let failed = 0
    for (const f of files) {
      const ext = requestPhotoExt(f.name, f.type)
      const path = ext ? requestPhotoPath(batch, crypto.randomUUID(), ext) : null
      if (!path) { failed++; continue }
      try {
        const { error } = await supabase.storage.from(REQUEST_PHOTO_BUCKET).upload(path, f, { upsert: false, contentType: f.type || undefined })
        if (error) failed++
        else paths.push(path)
      } catch { failed++ } // a thrown upload (offline, blocked) is one failed photo, never an aborted loop
    }
    return { paths, failed }
  }
  // The customer opened this invoice (PDF or pay) — stamp viewed_at once so the
  // owner's list shows 'Viewed'. Fire-and-forget; idempotent server-side.
  function markInvoiceViewed(invoiceId: string) {
    supabase.rpc('portal_mark_invoice_viewed', { p_token: token, p_invoice_id: invoiceId }).then(() => {}, () => {})
  }
  // Start Stripe checkout for a quote's SCHEDULING DEPOSIT. The mirror of pay()
  // below — same re-entry guard, same "the server decided" handling of 409s. The
  // amount is never sent: /api/portal/quote-deposit derives the outstanding ask
  // from the ledger server-side.
  async function payQuoteDeposit(quoteId: string) {
    if (payingQuoteId || payingId) return // never start two checkout sessions
    setPayingQuoteId(quoteId)
    try {
      const res = await fetch('/api/portal/quote-deposit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, quoteId }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.url) { window.location.href = d.url; return } // redirecting to Stripe — stay disabled
      // 404/409 = the server decided there is nothing to collect (already paid in
      // another tab, or the owner recorded an e-transfer) — resync and say so.
      if (res.status === 404 || res.status === 409) {
        await load()
        setActionError('This deposit looks already settled — we’ve refreshed your billing below. If you think that’s wrong, message us and we’ll check.')
      } else {
        setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
      }
    } catch {
      setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
    }
    setPayingQuoteId(null) // only reached on failure — a successful redirect left the page
  }

  // Save (or clear) the customer's scheduling preference — token-scoped RPC, one
  // writer. NOT optimistic: the form reports what the server kept, and a refetch
  // makes the echoed-back preference the proof it saved.
  async function savePreference(quoteId: string, pref: { date: string | null; date2: string | null; timing: string | null; note: string | null }): Promise<boolean> {
    setActionError(null)
    const { data: ok, error } = await supabase.rpc('portal_set_scheduling_preference', {
      p_token: token, p_quote_id: quoteId,
      p_date: pref.date, p_date_2: pref.date2, p_timing: pref.timing, p_note: pref.note,
    })
    if (error || !ok) {
      setActionError('We couldn’t save your preferred timing — please check the dates and try again.')
      return false
    }
    await load()
    return true
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
      // 404/409 mean the server has decided this invoice is NOT payable — almost
      // always because it is already settled (paid in another tab, or the owner
      // recorded the e-transfer) and this tab is showing a stale balance. The
      // generic "try again in a moment" sent that customer round a loop that could
      // never succeed, still looking at an amount they no longer owe. Re-sync from
      // the one data source and say what's true. Fixed copy either way — a
      // server-provided string is never rendered in the public portal.
      if (res.status === 404 || res.status === 409) {
        await load()
        setActionError('This invoice looks already settled — we’ve refreshed your billing below. If you think that’s wrong, message us and we’ll check.')
      } else {
        setActionError('We couldn’t start the payment — please try again in a moment, or contact us and we’ll sort it out.')
      }
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
    payQuoteDeposit, payingQuoteId, savePreference,
    paymentPending: justPaid === 'confirming',
    request: (message: string) => request(message),
    submitRequest, uploadRequestPhotos, photoUrl, markInvoiceViewed, refresh: load,
    navigate: (t, opts) => {
      goTab(t, opts?.docsCat)
      if (opts?.focusDocId) { setFocusDocId(opts.focusDocId); setTimeout(() => setFocusDocId(null), 4000) }
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
    },
    askAbout: (prefill) => {
      setComposerPrefill(prefill)
      goTab('messages')
      if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
    },
    respondToChange, decidingChangeId,
  }

  // Tab order = how often a customer reaches for each. Tabs whose surface would
  // be EMPTY are hidden (a fresh quote recipient sees Home/Billing/Requests, not
  // five dead ends) — each appears as soon as it has content. Messages and
  // Requests are always visible: their empty state IS the invitation.
  // ⚠️ CHANGE ORDERS COUNT AS DOCUMENTS. Billing is hidden when it would be
  // empty — but it is also where the record of changes lives, so a customer with
  // no quote and no invoice yet (a job raised straight onto the calendar, which
  // is a normal way for work to start here) had their approved and pending
  // changes rendered onto a tab they had no pill for. Caught by driving the real
  // portal at 375px: every figure was correct and none of it was reachable.
  const docCount = data.quotes.length + data.invoices.filter(i => i.status !== 'draft').length
    + (data.change_orders?.length ?? 0)
  // `unit` names the count for a screen reader — "Billing, 3 documents", not a
  // bare "Billing 3" that reads as an unlabelled number.
  const TABS: { key: TabKey; label: string; icon: typeof Home; n?: number; unit?: string }[] = ([
    { key: 'home', label: 'Home', icon: Home },
    { key: 'billing', label: 'Billing', icon: Receipt, n: docCount, unit: 'documents' },
    { key: 'visits', label: 'Visits', icon: History, n: view.derived.completed.length + view.derived.upcoming.length, unit: 'visits' },
    // Properties is a destination only for a landlord, where grouping the work BY
    // address is the whole information. A single-address customer's property
    // details (address, measurements, provider note) now open Visits instead —
    // one tab for "my place and what's been done to it" — so 50 of the 55 portals
    // in production lose a pill and lose nothing else.
    { key: 'property', label: 'Properties', icon: MapPin, n: view.properties.length, unit: 'properties' },
    // ONE way to reach a human. "Messages" and "Requests" were two separate pills
    // that both mean "talk to my provider" to a homeowner — one held the message
    // thread, the other the service catalogue and a free-text ask, and nothing on
    // either label said which was which. Six pills also wrapped onto two rows on a
    // 375px phone (they measure ~615px against ~343px of usable width), so the nav
    // itself was the second-biggest thing on the screen. They are one destination
    // now: ask for a service, or just say something. `requests` still resolves here
    // (see goTab) so existing deep links and Home's "Request a service" keep working.
    { key: 'messages', label: 'Contact', icon: MessageSquare },
  ] as { key: TabKey; label: string; icon: typeof Home; n?: number; unit?: string }[]).filter(t =>
    t.key === 'billing' ? (docCount > 0 || data.payments.length > 0) :
    t.key === 'visits' ? (data.jobs.length > 0 || data.photos.length > 0) :
    t.key === 'property' ? (view.hasProperty && view.multiProperty) :
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
            kept scrolled into view so a deep link never lands it off-screen.

            It WRAPS rather than scrolling sideways: six pills measure ~615px against
            ~343px of usable width on a 375px phone, so Messages and Requests — the two
            whose "empty state IS the invitation" — sat past the right edge with no fade,
            no chevron, nothing to suggest they existed. Someone who doesn't think to
            swipe a nav row never discovers they can message their provider from here.
            Two short rows show every section at once; the scroll-into-view below still
            covers the deep-link case, and the arrow keys already move in both axes, so
            wrapping costs the keyboard nothing (aria-orientation dropped for the same
            reason — the row is no longer strictly one-dimensional). */}
        <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-bg/90 backdrop-blur border-b border-border">
          <div role="tablist" aria-label="Your account sections" className="flex flex-wrap gap-1.5">
            {TABS.map((t, i) => {
              const active = activeTab === t.key
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
                  can check instead of wait — and when a deposit stands between
                  approval and a booked date, name that step instead of promising
                  there's nothing left to do. */}
              <span className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Quote accepted — thank you!{' '}
                  <span className="font-normal">
                    {acceptedDepositAsk != null
                      ? <>Next step: pay the {formatCurrency(acceptedDepositAsk)} deposit below to secure your booking — your preferred timing is confirmed once it&rsquo;s received.</>
                      : <>{biz?.company_name || 'We'}&rsquo;ll contact you to agree a date. Once it&rsquo;s booked, your visit appears on this page — nothing else to do for now.</>}
                  </span>
                </span>
              </span>
              <button onClick={() => { setJustAccepted(false); setAcceptedDepositAsk(null) }} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}
          {actionError && (
            <div className="mb-3 rounded-card border border-red-500/25 bg-red-500/10 text-red-400 text-sm font-medium px-4 py-3 flex items-start justify-between gap-3">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}

          {/* Your next action, from anywhere. Only on tabs where it isn't already
              in front of you (Home has the full attention section; Billing is
              where you'd act), only when something genuinely needs you, and
              dismissible so it's a convenience, never a nag. One tap lands on the
              exact document via the same scroll a deep link uses. */}
          {(() => {
            if (activeTab === 'home' || activeTab === 'billing') return null
            const a = primaryPortalAction(view.docItems, view.money, view.pendingChanges)
            if (!a || a.key === dismissedAction) return null
            return (
              <div className={cn('mb-3 rounded-card border flex items-center gap-1 pr-1',
                a.kind !== 'approve' ? 'border-amber-500/30 bg-amber-500/[0.08]' : 'border-accent/25 bg-accent/[0.08]')}>
                <button type="button"
                  onClick={() => actions.navigate('billing', { docsCat: a.docsCat, focusDocId: a.focusDocId })}
                  className="flex-1 flex items-center gap-2.5 px-4 py-3 text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  {/* A change awaiting a decision is not a bill — a wallet on that
                      banner would tell the customer money is owed when nothing is. */}
                  {a.kind === 'approve-change' ? <FileSignature className="w-4 h-4 shrink-0 text-amber-400" />
                    : a.kind !== 'approve' ? <Wallet className="w-4 h-4 shrink-0 text-amber-400" />
                      : <FileText className="w-4 h-4 shrink-0 text-accent-text" />}
                  <span className="text-sm font-medium text-ink">{a.headline}</span>
                  <ChevronRight className="w-4 h-4 text-ink-faint ml-auto shrink-0" />
                </button>
                <button type="button" onClick={() => setDismissedAction(a.key)} aria-label="Dismiss" className="shrink-0 p-2 text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
              </div>
            )
          })()}

          {/* The single live panel, labelled by the active tab — completes the
              tablist/tab/tabpanel relationship for assistive tech. Global status
              banners above stay outside it (they aren't tab content). */}
          <div id="portal-panel" role="tabpanel" aria-labelledby={`porttab-${activeTab}`} tabIndex={-1} className="focus-visible:outline-none">
            {activeTab === 'home' && <HomeTab view={view} actions={actions} suppressApproved={justAccepted} />}
            {/* Reachability outranks the review ask: a missing phone or email is
                why a visit can't be confirmed or an invoice sent. Renders nothing
                at all when the file is complete — and nothing when the payload is
                absent, because a read we didn't get is not a gap we can claim.
                It sits BELOW the customer's actual quotes, invoices and visits:
                a detail we're missing must never outrank what they came for. */}
            {activeTab === 'home' && contactGap(data.customer) !== 'none' && (
              <ContactMethodCard
                gap={contactGap(data.customer) as 'phone' | 'email' | 'both'}
                businessName={biz?.company_name ?? null}
                onSave={addContact} />
            )}
            {activeTab === 'home' && biz?.review_url && view.derived.lastCompleted && !data.customer.reviewed_at && !reviewDeclined && (
              <ReviewCard reviewUrl={biz.review_url} businessName={biz.company_name} reviewed={markedReviewed} onReviewed={markReviewed} onDecline={declineReview} />
            )}
            {activeTab === 'home' && consent && <ConsentCard token={token} consent={consent} onSave={saveConsent} />}
            {activeTab === 'property' && <PropertyTab view={view} actions={actions} />}
            {activeTab === 'visits' && <VisitsTab view={view} actions={actions} />}
            {activeTab === 'billing' && <BillingTab view={view} actions={actions} initialCat={docsCat} focusDocId={focusDocId} />}
            {/* Contact = ask for something, or say something. The catalogue leads
                because "I want another service" is the commoner errand and it is
                answerable without typing; the thread follows for everything else.
                Both already send through the same portal_request_service /
                portal_submit_request pipeline, so nothing about delivery changes. */}
            {activeTab === 'messages' && (
              <div className="space-y-3">
                <RequestsTab view={view} actions={actions} />
                <MessagesTab view={view} actions={actions} initialDraft={composerPrefill} onDraftConsumed={() => setComposerPrefill(null)} />
              </div>
            )}
          </div>
        </div>

        <p className="text-center text-[10px] text-ink-faint mt-10">Powered by EdgeQuote</p>
      </div>
      {/* Styled confirmation dialogs (card removal, quote approval…). */}
      <ConfirmHost />
    </div>
  )
}
