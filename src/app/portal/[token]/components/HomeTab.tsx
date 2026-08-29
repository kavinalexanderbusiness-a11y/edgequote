'use client'

// ── Home tab — "the story of now" ───────────────────────────────────────────
// Top to bottom: who takes care of you → what needs you → what's next → what
// just happened → your ongoing plans → recent activity. Every fact comes from
// the view-model (../model) — this file derives NOTHING money- or status-shaped
// on its own. Every customer action is a REQUEST that threads into the owner's
// ONE Messages hub — nothing here mutates jobs or plans directly.
//
// ReviewCard + ConsentCard are preserved verbatim at the bottom of this file
// and exported with their ORIGINAL prop signatures: PortalClient owns their
// visibility state (reviewed/declined outlive this component) and wires them
// exactly as before, below <HomeTab />.

import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock, Check, CheckCircle2, ChevronDown, CreditCard, FileText, Globe,
  Loader2, Mail, MessageSquare, MessageSquarePlus,
  Navigation, PauseCircle, Phone, Receipt, Repeat, SkipForward, Star,
  UserRound, Wallet, XCircle,
} from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { PLAN_STATUS_CUSTOMER_LABEL } from '@/lib/recurrence'
import { Button } from '@/components/ui/Button'
import { confirm as confirmDialog } from '@/lib/confirm'
import { createClient } from '@/lib/supabase/client'
import {
  daysAwayLabel, invoiceDepositPaidNote, invoicePaymentNote, isUsableEmail, isUsablePhone,
  liveStatusOf, primaryPortalAction, recentPayments, visitToCalendarEvent, visitDay,
  type AddContactResult, type ContactGap, type Derived, type PortalJob, type PortalView, type SubmitRequestFn,
} from '../model'
import { AddToCalendar, PortalSection, StatusPill, StatusStepper, Thumb, type TabProps } from './shared'
import { PendingChangeCard } from './ChangesCard'

// ── Home ────────────────────────────────────────────────────────────────────
// `suppressApproved` is the one prop beyond the tab contract: PortalClient
// passes its `justAccepted` flag so the "your quote has been approved" hero
// doesn't flash the instant someone taps Approve (their success state is the
// accept flow's own confirmation, not this reassurance card).
export function HomeTab({ view, actions, suppressApproved }: TabProps & { suppressApproved?: boolean }) {
  const { data, derived, todayISO } = view
  const biz = data.business
  const next = derived.nextService

  // A quote awaiting approval is usually WHY the customer opened this link —
  // signpost it up top instead of making them discover the documents list.
  // An EXPIRED quote is not awaiting anything: DocItem.status is the DISPLAY
  // status (lib/quoteStatus), the same engine as the row it taps through to,
  // so the two can never disagree about whether the price still stands.
  const awaiting = view.docItems.filter(d => d.kind === 'quote' && d.status === 'sent')
  // A pure prospect (quote in hand, no visits or invoices yet) came to review
  // the quote — skip the empty "no visit scheduled" hero that would push it
  // down and invite the wrong action.
  const prospect = awaiting.length > 0 && !next && derived.completed.length === 0 && (data.invoices || []).length === 0
  // Approved but nothing on the calendar yet — reassure instead of the generic
  // "no upcoming visit" message (they just said yes; the ball is in our court).
  const approvedPending = !next && !suppressApproved && (data.quotes || []).some(q => q.status === 'accepted')

  const last = derived.lastCompleted
  const lastPhotos = last ? (view.photosByJob.get(last.id) || []).slice(0, 3) : []
  // Money that has moved lately — the one row class the old activity feed carried
  // that Home could not say any other way. Pure + verify-pinned in ../model.
  const payments = useMemo(() => recentPayments(view.data.payments, todayISO), [view.data.payments, todayISO])

  // THE ranked next action — the one engine that knows overdue beats balance-due beats
  // quote-awaiting. It already powers the cross-tab banner; Home ignored it and always
  // put quotes first, so someone with a past-due invoice AND a new quote met two
  // identical amber cards in the wrong order. Same engine, so the two surfaces can't
  // disagree about what matters most.
  const topAction = primaryPortalAction(view.docItems, view.money, view.pendingChanges)
  const payFirst = topAction?.kind === 'pay'
  // The ranked engine put the SCHEDULING DEPOSIT first — an approved quote whose
  // booking isn't secured yet. One card, one figure (the gate's outstanding — the
  // same number the charge route will ask for), one action.
  const depositDoc = topAction?.kind === 'pay-deposit' && topAction.focusDocId
    ? view.docItems.find(d => d.rawId === topAction.focusDocId) || null
    : null
  const depositGate = depositDoc?.schedulingDeposit ?? null
  // When the ranked action names exactly ONE document, the real button belongs HERE.
  // This is the surface a texted link lands on; making someone tap through to a list
  // to find the thing they came to do is a tap we can spend for them. Several
  // documents keeps the signpost — we can't guess which one they meant.
  // ⛔ …but NOT when that one quote offers alternatives. Approving it takes a
  // choice, and there is nowhere on this card to read three scopes and compare
  // them — a one-tap Approve here would either commit the customer to a price
  // they never picked or (correctly) be refused by the RPC and read as a broken
  // button. The signpost above still carries them to Billing, where the
  // comparison lives; that tap buys the decision they're being asked to make.
  const oneQuoteDoc = topAction?.kind === 'approve' && topAction.focusDocId
    ? view.docItems.find(d => d.rawId === topAction.focusDocId) || null
    : null
  const oneQuoteId = oneQuoteDoc && !(oneQuoteDoc.options?.length) ? oneQuoteDoc.rawId : null
  const oneInvoice = topAction?.kind === 'pay' && topAction.focusDocId
    ? view.docItems.find(d => d.rawId === topAction.focusDocId) || null
    : null
  // Pay inline only when Stripe is actually on AND one invoice is named — an
  // e-transfer/cash business has no checkout to send them to, and the Billing card
  // (with the Ways-to-pay block beneath it) is the honest destination there.
  // Hidden while a completed checkout is still confirming — see BillingTab's note:
  // the balance shown is pre-payment, and a second tap is a second real charge.
  const canPayInline = !!oneInvoice && actions.paymentsEnabled && !actions.paymentPending && oneInvoice.balance > 0

  // Money already received on the ONE invoice being asked about, in the words the
  // Billing row already uses. Null when nothing has been paid yet (a plain bill is
  // its own explanation) or when several invoices make up the figure.
  const paidContext = (() => {
    if (!oneInvoice) return null
    const depPaid = invoiceDepositPaidNote(oneInvoice)
    if (depPaid) return `Deposit of ${depPaid.paid} received — this is the rest of ${formatCurrency(oneInvoice.amount)}`
    const note = invoicePaymentNote(oneInvoice)
    if (note) return `${note.paid} already paid of ${formatCurrency(oneInvoice.amount)} — this is what’s left`
    return null
  })()

  // "Outstanding" is collections vocabulary — it lands like an accusation on the one
  // banner someone reads when they're already tense about money.
  const dueBanner = view.money.due > 0 ? (
    <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] card-lift animate-rise stagger-2">
      <button type="button" onClick={() => actions.navigate('billing', { docsCat: 'invoice' })}
        className="w-full text-left p-4 rounded-card hover:border-amber-500/50 active:scale-[0.99] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><Receipt className="w-4 h-4" /></div>
            <div className="min-w-0">
              {/* When the ONE named invoice's ask is a deposit, the landing card must
                  say so — "Amount due · $4,000" over a button that charges $2,000 is
                  the display-vs-charge split all over again, on the exact surface the
                  deposit_request text links to. payIsDeposit/payAmount are the
                  engine's verdict (the same depositChargeAmount the pay route runs). */}
              {oneInvoice?.payIsDeposit ? (
                <>
                  <p className="text-sm font-semibold text-ink">
                    Deposit due · <span className="tabular-nums text-amber-400">{formatCurrency(oneInvoice.payAmount)}</span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    of {formatCurrency(oneInvoice.amount)} total — the rest is due after the work
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-ink">
                    Amount due · <span className="tabular-nums text-amber-400">{formatCurrency(view.money.due)}</span>
                  </p>
                  {/* What that figure is the REST OF. A customer who has already part-paid
                      met their own payment twice on one screen with nothing linking them:
                      "Amount due · $347.50" here, and "Payment received · Card · $347.50"
                      in the activity feed a screen below — the same number, once as a debt
                      and once as a receipt, which reads as the payment not having landed.
                      Billing's row has always said it properly; this is the same sentence
                      from the same verify-pinned helpers (invoiceDepositPaidNote /
                      invoicePaymentNote — the engine's figures, no arithmetic here), said
                      on the surface a texted link actually opens. Only when ONE invoice is
                      named: with several, no single breakdown can speak for the sum. */}
                  <p className="text-xs text-ink-muted">{paidContext ?? (
                    view.money.owingCount === 1 ? '1 invoice — view and pay whenever you’re ready'
                      : `${view.money.owingCount} invoices — view and pay whenever you’re ready`
                  )}</p>
                </>
              )}
            </div>
          </div>
          <span className="text-xs font-semibold text-amber-400 shrink-0">View →</span>
        </div>
      </button>
      {canPayInline && oneInvoice && (
        <div className="px-4 pb-4">
          <Button className="w-full" onClick={() => actions.pay(oneInvoice.rawId)} loading={actions.payingId === oneInvoice.rawId}>
            {/* payAmount, never balance — the engine's answer, identical to what the
                checkout will actually ask for (BillingTab's button says the same). */}
            <CreditCard className="w-4 h-4" /> Pay {formatCurrency(oneInvoice.payAmount)}{oneInvoice.payIsDeposit ? ' deposit' : ''}
          </Button>
          <p className="text-[11px] text-ink-faint mt-1.5 text-center">Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.</p>
        </div>
      )}
    </div>
  ) : null

  return (
    <div className="space-y-3">
      {/* 1 · Needs your attention — no-pressure framing on purpose. Rendered in the
          ranked order above; each card keeps its whole-surface tap AND, when it names
          one document, carries the real action so the decision happens right here. */}
      {payFirst && dueBanner}
      {/* The scheduling deposit — the one thing between an approved quote and a
          confirmed booking. States stay separate on the card itself: APPROVED is
          said as done, the DEPOSIT is asked for, and nothing claims a schedule. */}
      {depositDoc && depositGate && (
        <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] card-lift animate-rise stagger-2">
          <button type="button" onClick={() => actions.navigate('billing', { docsCat: 'quote', focusDocId: depositDoc.rawId })}
            className="w-full text-left p-4 rounded-card hover:border-amber-500/50 active:scale-[0.99] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><Wallet className="w-4 h-4" /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    Deposit to secure scheduling · <span className="tabular-nums text-amber-400">{formatCurrency(depositGate.outstanding)}</span>
                  </p>
                  <p className="text-xs text-ink-muted">
                    {depositGate.collected > 0
                      ? `${formatCurrency(depositGate.collected)} of ${formatCurrency(depositGate.required)} received — your quote is approved`
                      : 'Your quote is approved — your timing is confirmed once the deposit is received'}
                  </p>
                </div>
              </div>
              <span className="text-xs font-semibold text-amber-400 shrink-0">View →</span>
            </div>
          </button>
          {actions.paymentsEnabled && !actions.paymentPending && (
            <div className="px-4 pb-4">
              <Button className="w-full" onClick={() => actions.payQuoteDeposit(depositDoc.rawId)} loading={actions.payingQuoteId === depositDoc.rawId}>
                <CreditCard className="w-4 h-4" /> Pay {formatCurrency(depositGate.outstanding)} deposit
              </Button>
              <p className="text-[11px] text-ink-faint mt-1.5 text-center">Secure checkout by Stripe — you&rsquo;ll confirm on the next screen.</p>
            </div>
          )}
        </div>
      )}
      {/* Extra work waiting on a decision. Rendered as the real card, with the
          real buttons, on the surface a texted link opens — approving is two taps
          from the message, which is the whole promise of the feature. Ranked
          below the money asks and above the quote signpost by
          primaryPortalAction; this list is that ranking made visible. */}
      {view.pendingChanges.map(co => (
        <PendingChangeCard key={co.id} co={co}
          originalTotal={view.changesByJob.get(co.job_id)?.original ?? null}
          actions={actions}
          deciding={actions.decidingChangeId}
          onDecide={(c, d) => { void actions.respondToChange(c.id, d) }} />
      ))}
      {awaiting.length > 0 && (
        <div className="rounded-card border border-amber-500/30 bg-amber-500/10 card-lift animate-rise stagger-2">
          <button type="button" onClick={() => actions.navigate('billing', { docsCat: 'quote' })}
            className="w-full text-left p-4 rounded-card hover:border-amber-500/50 active:scale-[0.99] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><FileText className="w-4 h-4" /></div>
                <div className="min-w-0">
                  {/* No `truncate`: this is the single sentence the whole card exists to
                      say, and on a 390px phone it clipped to "3 quotes are ready for your
                      re…". A headline that runs to two lines costs one line; a headline
                      that stops mid-word costs the message. */}
                  <p className="text-sm font-semibold text-ink">
                    {awaiting.length === 1
                      ? (awaiting[0].title !== 'Quote' ? `Your ${awaiting[0].title} quote is ready` : 'Your quote is ready')
                      : `${awaiting.length} quotes are ready for your review`}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {awaiting.length === 1
                      // A quote with an unmade choice has no single price yet, so
                      // this line says what there IS to do instead of asserting
                      // the recommended option as the figure.
                      ? (awaiting[0].options?.length
                        ? `${awaiting[0].options.length} options — pick one and approve it`
                        : `${formatCurrency(awaiting[0].amount)} — review and approve when you're ready`)
                      : `Review and approve when you're ready`}
                  </p>
                  {/* The quote's OWN expiry, or nothing. This used to print issue-date +
                      30 days as fact — inventing a deadline for the 2 in 3 live quotes
                      that carry no valid_until at all ("null = it never lapses"), and
                      contradicting the Billing card, which has always read the real
                      field. A made-up deadline on the one screen someone reads while
                      deciding is pressure we have no right to apply. */}
                  {awaiting.length === 1 && awaiting[0].validUntil && (
                    <p className="text-[11px] text-ink-faint mt-0.5">Valid until {formatDate(awaiting[0].validUntil)}</p>
                  )}
                </div>
              </div>
              <span className="text-xs font-semibold text-amber-400 shrink-0">Review →</span>
            </div>
          </button>
          {oneQuoteId && (
            <div className="px-4 pb-4">
              <Button className="w-full" onClick={() => actions.accept(oneQuoteId)} loading={actions.accepting === oneQuoteId}>
                <Check className="w-4 h-4" /> Approve — {formatCurrency(awaiting[0].amount)}
              </Button>
              {/* ⭐ The model's ONE payment-timing sentence, not this card's own.
                  It used to read "Nothing is charged when you approve." on every
                  quote — true of the tap, materially false on a quote whose very
                  next screen asks for a deposit. Same string the Billing card and
                  the approval dialog use, so the customer cannot be told two
                  different things about their own money in two taps. */}
              <p className="text-[11px] text-ink-faint mt-1.5 text-center">{oneQuoteDoc?.paymentTimingLine}</p>
            </div>
          )}
        </div>
      )}
      {!payFirst && dueBanner}

      {/* 3 · Next service hero (hidden for a pure prospect — the quote card above is their whole visit) */}
      {!prospect && (
      <div className="rounded-card border border-accent/20 hero-aurora p-4 animate-rise stagger-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text mb-1">Next service</p>
        {next ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-bold text-ink tracking-tight">{next.service_type || next.title}</p>
              <StatusPill s={liveStatusOf(next)} />
            </div>
            <p className="text-sm text-ink-muted mt-0.5">
              {formatDate(next.scheduled_date)}
              {(() => { const a = daysAwayLabel(next.scheduled_date, todayISO); return a ? <span className="text-ink font-medium"> · {a}</span> : null })()}
            </p>
            <StatusStepper s={liveStatusOf(next)} />
            {liveStatusOf(next) === 'on_my_way' && <p className="text-xs text-sky-400 mt-2 flex items-center gap-1"><Navigation className="w-3.5 h-3.5" /> Your provider is on the way!</p>}
            {/* Rescheduling used to mean composing a free-text message from scratch.
                Only offered while the visit is still merely scheduled — once someone
                is on their way, a date-change form is the wrong tool. */}
            {liveStatusOf(next) === 'scheduled' && (
              <>
                {/* A booked visit carries a DATE, never a time — PortalJob has no
                    time field, so the customer sees "Thu, Jul 30" and is left to
                    wonder "but when?". Name the expectation honestly, and point at
                    the live signal they already have: this hero flips to "On the
                    way" (and the on_my_way text goes out) the moment the crew sets
                    out. No business rule here — just saying what already happens. */}
                <p className="text-xs text-ink-muted mt-2 flex items-start gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-0.5" />
                  <span>We don&rsquo;t book an exact time — expect us any time that day. You&rsquo;ll see &lsquo;On the way&rsquo; here when we&rsquo;re heading over.</span>
                </p>
                <RescheduleRequest key={next.id} job={next} todayISO={todayISO} submitRequest={actions.submitRequest} />
                {/* Put the visit in their own calendar — one tap, no account, no
                    backend. All-day on the scheduled date (we have a date, not a
                    time, and won't invent one). */}
                <AddToCalendar
                  visits={[visitToCalendarEvent(next, biz, view.propsById)]}
                  filename={`${(next.service_type || 'visit').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'visit'}.ics`}
                  calName={biz?.company_name ? `${biz.company_name} visits` : 'Service visits'}
                  className="mt-2"
                />
              </>
            )}
          </>
        ) : approvedPending ? (
          <div>
            <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Your quote has been approved.
            </p>
            {/* This is the screen someone stares at for days after saying yes. "Will contact
                you shortly" gives them nothing to do but wonder — tell them where the answer
                will land and that reaching out is welcome. */}
            {/* When a scheduling deposit is still owed, "we're arranging your
                visit" is untrue — the ball is in the customer's court, and the
                card above holds the action. Say which state they're actually in. */}
            {depositGate ? (
              <p className="text-sm text-ink-muted mt-1">
                The {formatCurrency(depositGate.outstanding)} deposit above secures your booking — once it&rsquo;s received, we&rsquo;ll confirm your date and it will appear here.
              </p>
            ) : (
              <p className="text-sm text-ink-muted mt-1">
                We&rsquo;re arranging your first visit. The date will appear here as soon as it&rsquo;s booked
                {biz && (biz.phone || biz.email_primary) ? ' — and you can call or email us any time using the card above.' : '.'}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-sm text-ink-muted mb-3">No upcoming visit scheduled.</p>
            <Button onClick={() => actions.navigate('requests')} className="w-full sm:w-auto">
              <MessageSquarePlus className="w-4 h-4" /> Request a service
            </Button>
          </div>
        )}
      </div>
      )}

      {/* 4 · Latest visit — proof of work, straight from derived.lastCompleted */}
      {last && (
        <div className="animate-rise stagger-4">
          <PortalSection title="Latest visit"
            action={
              <button type="button" onClick={() => actions.navigate('visits')}
                className="text-xs font-semibold text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                See all visits →
              </button>
            }>
            <div className="rounded-card border border-border bg-bg-secondary p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink tracking-tight flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> {last.service_type || last.title}</p>
                {/* THE day the visit actually happened (visitDay) — a rain-delayed
                    visit shows the day the customer remembers, not the plan. */}
                <span className="text-xs text-ink-muted">{formatDate(visitDay(last))}</span>
              </div>
              {lastPhotos.length > 0 && (
                <div className="grid grid-cols-3 gap-2 mt-3">
                  {lastPhotos.map(p => (
                    <Thumb key={p.id} href={actions.photoUrl(p.storage_path)} src={actions.photoUrl(p.storage_path)} alt={p.caption || 'Visit photo'} />
                  ))}
                </div>
              )}
            </div>
          </PortalSection>
        </div>
      )}

      {/* 5 · Your service plan — straight from the shared engine, so every fact here
          (cadence, day, window, next visit, price) is the same one the owner sees. */}
      {derived.plans.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4 animate-rise stagger-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2.5">
            Your service plan{derived.plans.length !== 1 ? 's' : ''}
          </p>
          <div className="space-y-2.5">
            {derived.plans.map(p => (
              <div key={p.recurrenceId}>
                <PlanRow p={p} heroDate={next?.scheduled_date ?? null} />
                {/* The way out, on the plan itself. These SEND A REQUEST the owner
                    confirms — the plan doesn't change until a human says so, and the
                    copy says exactly that. */}
                <PlanActions plan={p} businessName={biz?.company_name || null} submitRequest={actions.submitRequest}
                  phone={biz?.phone || null} onMessage={() => actions.navigate('messages')} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5 · Who takes care of you — a real name, tap-to-call, and how long you've
          been a customer.
          This used to be the FIRST thing on Home, in every single state. Rendered
          against real portals it put eight lines — provider name, company, "Customer
          since", and three contact buttons — above the customer's own situation: a
          quote awaiting approval, or "$347.50 due", sat below the fold on a phone.
          The header already carries the logo and company name, so the top of the
          screen answered "who are you" (twice) before "what do I need to do".
          It stays — a name and a number are what make an unfamiliar link feel safe —
          but it belongs with the reassurance, after the answers. */}
      <TrustCard view={view} />

      {/* 6 · Recent payments — money that has MOVED lately, and nothing else.
          What this replaced, and why, is documented on model.recentPayments: the
          general activity feed was a chronological copy of Billing that spent two
          of its five rows restating a single transaction. This keeps the one row
          class Home could not otherwise say — an e-transfer or cash payment is
          recorded by the owner hours later, long after any checkout banner — and
          absent when nothing has moved inside the window. The amount and date sit
          on their own line so neither can be truncated (real rows once clipped to
          "Payment received · E-transfer · $7…"). */}
      {payments.length > 0 && (
        <div className="animate-rise stagger-6">
          <PortalSection title="Recent payments"
            action={
              <button type="button" onClick={() => actions.navigate('billing')}
                className="text-xs font-semibold text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                Receipts &amp; history →
              </button>
            }>
            <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border/60">
              {payments.map(p => (
                <div key={p.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                  <span className={cn('w-6 h-6 rounded-full border flex items-center justify-center shrink-0 mt-0.5',
                    p.isRefund ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10')}>
                    <CreditCard className="w-3 h-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink truncate">{p.label}</p>
                    <p className="text-xs text-ink-faint tabular-nums">
                      {formatCurrency(p.amount)} · {formatDate(p.at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </PortalSection>
        </div>
      )}
    </div>
  )
}

// ── 1 · Trust card ──────────────────────────────────────────────────────────
// "Who takes care of you" — a real name, a tap-to-call number, and how long
// they've been with us. owner_name was returned by get_portal_data and rendered
// nowhere; a person's name is the cheapest trust signal the payload carries.
function TrustCard({ view }: { view: PortalView }) {
  const biz = view.data.business
  if (!biz || !(biz.owner_name || biz.company_name || biz.phone || biz.email_primary || biz.website)) return null
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 animate-rise stagger-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-full border border-accent/25 bg-accent/10 text-accent-text flex items-center justify-center shrink-0"><UserRound className="w-4 h-4" /></div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Your provider</p>
            <p className="text-sm font-bold text-ink truncate">{biz.owner_name || biz.company_name}</p>
            {biz.owner_name && biz.company_name && <p className="text-xs text-ink-muted truncate">{biz.company_name}</p>}
          </div>
        </div>
        {/* "Customer since" is the year of the earliest PROVABLE thing (model) —
            null for a brand-new prospect, and then we simply say nothing. */}
        {view.customerSince && <span className="text-[11px] text-ink-faint shrink-0 mt-0.5">Customer since {view.customerSince}</span>}
      </div>
      {(biz.phone || biz.email_primary || biz.website) && (
        <div className="flex flex-wrap gap-2 mt-3">
          {/* `tap-target-y` (the codebase's pointer-coarse 44px floor): measured at
              42px on a phone, so the three ways to reach a human were the only real
              buttons on Home under the gloved-thumb minimum. Two pixels, but this is
              the card that exists to be tapped by someone who wants a person. */}
          {biz.phone && <a href={`tel:${biz.phone}`} className="tap-target-y flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Phone className="w-4 h-4 text-accent-text" /> Call</a>}
          {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="tap-target-y flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Mail className="w-4 h-4 text-accent-text" /> Email</a>}
          {biz.website && <a href={biz.website.startsWith('http') ? biz.website : `https://${biz.website}`} target="_blank" rel="noopener noreferrer" className="tap-target-y flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Globe className="w-4 h-4 text-accent-text" /> Website</a>}
        </div>
      )}
    </div>
  )
}

// ── One recurring plan, as the shared engine reports it ─────────────────────
// Everything shown is a fact the engine derived — nothing is inferred here.
//
// `paused` means the series has history but no future visit booked. That is the
// honest word for it: we don't know it's cancelled (it may just be between
// seasons, or the schedule may not be built out yet), so we say what's true —
// no visits are booked — and put the way to ask right next to it. The old card
// simply hid such a plan, which is how a customer on a live plan could open the
// portal and be told nothing about it at all.
function PlanRow({ p, heroDate }: { p: Derived['plans'][number]; heroDate?: string | null }) {
  const perVisit = p.recurringPrice ?? p.initialPrice
  // The next-service hero above already states this date, in larger type, with a
  // "in 5 days" gloss and a status stepper. Printing it again three cards down
  // reads as a second, separate appointment — the commonest customer here has ONE
  // weekly plan, so "Aug 14, 2026" appeared twice on one screen.
  // The plan card keeps everything the hero does NOT say (cadence, usual weekday,
  // window, price per visit, how many are booked) and drops only the repeated
  // date, so the two are complementary instead of redundant. A plan whose next
  // visit ISN'T the hero's — a second plan, or a later one — still shows its own
  // date, because then it is new information.
  const echoesHero = !!heroDate && p.nextVisitDate === heroDate
  return (
    <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <span className={cn('w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 mt-0.5',
          p.status !== 'active' ? 'border-border bg-bg-tertiary text-ink-faint' : 'border-accent/25 bg-accent/10 text-accent-text')}>
          <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink flex flex-wrap items-center gap-x-2 gap-y-1">
            {p.serviceName}
            <span className="text-xs font-medium text-ink-muted">· {p.cadenceLabel}</span>
            {/* Customer-facing wording from the engine — "Plan complete" and
                "Back next season" used to both read "No visits booked". */}
            {p.status !== 'active' && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-border text-ink-faint">
                {PLAN_STATUS_CUSTOMER_LABEL[p.status]}
              </span>
            )}
          </p>
          {/* Only render a fact the engine actually resolved — a missing weekday or
              window means it wasn't consistent/configured, not that it's unknown-blank. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
            {p.weekday && <span>Usually {p.weekday}</span>}
            {p.windowLabel && <span className="before:content-['·'] before:mr-2 first:before:hidden">{p.windowLabel}</span>}
            {perVisit != null && perVisit > 0 && (
              <span className="before:content-['·'] before:mr-2 first:before:hidden tabular-nums">{formatCurrency(perVisit)}/visit</span>
            )}
          </div>
          <p className="text-xs mt-1.5">
            {p.nextVisitDate ? (
              echoesHero ? (
                // The hero owns the date; this only adds what it doesn't cover.
                p.remaining > 1
                  ? <span className="text-ink-muted">{p.remaining} visits booked</span>
                  : <span className="text-ink-muted">Next visit shown above</span>
              ) : (
                <span className="text-ink">
                  Next visit <span className="font-semibold">{formatDate(p.nextVisitDate)}</span>
                  {p.remaining > 1 && <span className="text-ink-muted"> · {p.remaining} booked</span>}
                </span>
              )
            ) : (
              <span className="text-ink-muted">No upcoming visits booked yet.</span>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Reschedule request (on the next-visit hero) ─────────────────────────────
// A quiet link that unfolds into a two-field form. It sends a REQUEST — the visit
// stays exactly where it is until the owner confirms, and the confirmation copy
// says so, because "I tapped a button" must never be mistaken for "it moved".
// Keyed by job id from the parent, so a different next visit gets a fresh form.
function RescheduleRequest({ job, todayISO, submitRequest }: { job: PortalJob; todayISO: string; submitRequest: SubmitRequestFn }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  if (sent) return (
    <p className="text-xs text-emerald-400 mt-3 pt-3 border-t border-border/40 flex items-start gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>Request sent — we&rsquo;ll confirm your new date here and by message. Your visit stays on {formatDate(job.scheduled_date)} until then.</span>
    </p>
  )
  if (!open) return (
    <p className="text-xs text-ink-muted mt-3 pt-3 border-t border-border/40">
      Date doesn&rsquo;t work?{' '}
      <button type="button" onClick={() => setOpen(true)} className="text-accent-text font-medium hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        Request a different date
      </button>
    </p>
  )
  return (
    <form className="mt-3 pt-3 border-t border-border/40 space-y-2"
      onSubmit={async e => {
        e.preventDefault()
        if (!date || busy) return
        setBusy(true)
        const svc = job.service_type || job.title
        const ok = await submitRequest({
          kind: 'reschedule', jobId: job.id, preferredDate: date,
          message: `Reschedule request: ${svc} on ${formatDate(job.scheduled_date)} — could we move it to ${formatDate(date)}?${note.trim() ? ` ${note.trim()}` : ''}`,
        })
        setBusy(false)
        if (ok) setSent(true)
      }}>
      <label className="block text-xs font-medium text-ink" htmlFor="resched-date">What date works better?</label>
      <input id="resched-date" type="date" required value={date} min={todayISO} onChange={e => setDate(e.target.value)}
        className="w-full h-10 px-3 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
      <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} aria-label="Anything we should know?" placeholder="Anything we should know? (optional)"
        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" loading={busy} disabled={!date}><CalendarClock className="w-4 h-4" /> Send request</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Never mind</Button>
      </div>
      <p className="text-[11px] text-ink-faint">This sends a request — your visit stays booked as is until we confirm the new date with you.</p>
    </form>
  )
}

// ── Plan actions (skip next / pause / cancel — all requests, never mutations) ──
// BEHIND A DISCLOSURE, and that is the whole change here. The three buttons were
// permanent, and on the home screen of a customer whose plan is running perfectly
// the reddest, most eye-catching control on the page was "Cancel plan" — an exit
// offered before anything had gone wrong. They also crowded out the answer people
// actually come for: on a real portal the plan card carried five tap targets
// (three of them here) directly under "Next visit Aug 14".
//
// They are NOT deleted. An ongoing arrangement with no visible way out is what
// makes people feel trapped, and that reasoning still holds — the way out is one
// tap away, named plainly, instead of standing open. The free-text line that used
// to sit outside this card (covering the asks that aren't a button — change
// frequency, a different weekday) moves inside it, so the default view of a
// healthy plan is the plan, and nothing else.
function PlanActions({ plan, businessName, submitRequest, phone, onMessage }: {
  plan: Derived['plans'][number]; businessName: string | null; submitRequest: SubmitRequestFn
  phone?: string | null; onMessage?: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const who = businessName || 'we'
  async function act(action: 'skip_next' | 'pause' | 'cancel') {
    if (busy) return
    const copy = action === 'skip_next' ? {
      title: 'Skip your next visit?',
      confirm: `This sends a request to skip your ${plan.serviceName} visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''}. Nothing changes until ${who === 'we' ? 'we confirm' : `${who} confirms`} with you — the rest of your plan stays as is.`,
      msg: `Plan change request: please skip my next ${plan.serviceName} visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''}. Keep the rest of my ${plan.cadenceLabel.toLowerCase()} plan as is.`,
      done: `Request sent — your visit${plan.nextVisitDate ? ` on ${formatDate(plan.nextVisitDate)}` : ''} stays booked until we confirm the skip with you.`,
    } : action === 'pause' ? {
      title: 'Pause your plan?',
      confirm: `This sends a request to pause your ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. Nothing changes until ${who === 'we' ? 'we confirm' : `${who} confirms`} with you.`,
      msg: `Plan change request: please pause my ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan for now — I'll be in touch about starting it back up.`,
      done: 'Pause request sent — we’ll confirm with you before anything changes.',
    } : {
      title: 'Cancel your plan?',
      confirm: `This sends a cancellation request for your ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. ${who === 'we' ? 'We' : who}’ll be in touch to confirm — nothing is cancelled until then.`,
      msg: `Plan change request: I'd like to cancel my ${plan.cadenceLabel.toLowerCase()} ${plan.serviceName} plan. Please confirm the cancellation with me.`,
      done: 'Cancellation request sent — we’ll be in touch to confirm.',
    }
    const confirmed = await confirmDialog({ title: copy.title, message: copy.confirm, confirmLabel: 'Send request', destructive: action === 'cancel' })
    if (!confirmed) return
    setBusy(action)
    const ok = await submitRequest({
      kind: 'plan_change', recurrenceId: plan.recurrenceId,
      jobId: action === 'skip_next' ? plan.nextJobId : null,
      details: { action }, message: copy.msg,
    })
    setBusy(null)
    if (ok) setSent(copy.done)
  }
  if (sent) return (
    <p className="text-xs text-emerald-400 mt-2 pl-[22px] flex items-start gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{sent}</span>
    </p>
  )
  const btn = 'inline-flex items-center gap-1 text-xs font-medium rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
  return (
    <details className="group mt-1.5 pl-[22px]">
      <summary className="tap-target-y list-none cursor-pointer inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        Change or pause this plan
        <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {plan.nextVisitDate && plan.nextJobId && (
          <button type="button" disabled={busy !== null} onClick={() => act('skip_next')} className={cn(btn, 'text-ink-muted hover:text-ink hover:border-border-strong')}>
            {busy === 'skip_next' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SkipForward className="w-3.5 h-3.5" />} Skip next visit
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => act('pause')} className={cn(btn, 'text-ink-muted hover:text-ink hover:border-border-strong')}>
          {busy === 'pause' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PauseCircle className="w-3.5 h-3.5" />} Pause plan
        </button>
        <button type="button" disabled={busy !== null} onClick={() => act('cancel')} className={cn(btn, 'text-red-400/70 hover:text-red-400 hover:border-red-500/30')}>
          {busy === 'cancel' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />} Cancel plan
        </button>
      </div>
      {/* Everything the three buttons don't cover — a different weekday, a change of
          frequency — kept with them rather than standing permanently outside the card. */}
      {onMessage && (
        <p className="text-xs text-ink-muted mt-2">
          Something else?{' '}
          <button type="button" onClick={onMessage} className="text-accent-text font-medium hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Send us a message</button>
          {phone ? <> or call <a href={`tel:${phone}`} className="text-accent-text font-medium hover:underline">{phone}</a>.</> : '.'}
        </p>
      )}
    </details>
  )
}

// ── Review ask (only after a completed visit, hidden once they've reviewed) ──
// Preserved verbatim: PortalClient owns visibility (review_url + lastCompleted +
// !reviewed_at + !declined) and the reviewed/decline handlers, exactly as before.
export function ReviewCard({ reviewUrl, businessName, reviewed, onReviewed, onDecline }: { reviewUrl: string; businessName: string | null; reviewed: boolean; onReviewed: () => void; onDecline: () => void }) {
  const href = reviewUrl.startsWith('http') ? reviewUrl : `https://${reviewUrl}`
  // Both buttons used to mean "yes", so the only way to decline was to lie ("I've left my
  // review") or to ignore a card that never went away. "No thanks" was then added as a
  // door — but a session-local one: it died with the tab while the review-request cron
  // (which suppresses on review_declined_at) kept messaging them. It now writes that
  // column through portal_decline_review, so declining is honoured everywhere the owner's
  // own decline already is. The parent owns the hidden state, since the answer outlives
  // this component.
  if (reviewed) {
    return (
      <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4 mt-3">
        <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><Star className="w-4 h-4" /> Thank you for your review!</p>
        <p className="text-xs text-ink-muted mt-0.5">We really appreciate you taking the time.</p>
      </div>
    )
  }
  return (
    <div className="rounded-card border border-amber-400/30 bg-amber-400/[0.06] p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Star className="w-4 h-4 text-amber-400" /> Enjoying the service?</p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">
        If we did right by you, a quick review means a lot to a small business like {businessName || 'ours'}. Totally optional — it won&rsquo;t affect your service either way.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <Star className="w-4 h-4" /> Leave a review
        </a>
        <Button variant="secondary" className="flex-1 min-w-[140px]" onClick={onReviewed}>
          <Check className="w-4 h-4" /> Already did — thanks!
        </Button>
        <Button variant="ghost" className="flex-1 min-w-[100px]" onClick={onDecline}>
          No thanks
        </Button>
      </div>
    </div>
  )
}

// ── Message preferences (self-serve consent) ────────────────────────────────
// Preserved verbatim, INCLUDING its direct supabase read — the one granted
// exception to "tabs never touch supabase": per-category preferences
// (customers.message_prefs) are loaded lazily via portal_get_prefs so
// get_portal_data stays untouched; a missing key means "yes" (inherit).
export function ConsentCard({ token, consent, onSave }: { token: string; consent: { sms: boolean; email: boolean }; onSave: (c: { sms: boolean; email: boolean }, prefs?: Record<string, boolean>) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null)
  useEffect(() => {
    let alive = true
    supabase.rpc('portal_get_prefs', { p_token: token })
      .then(({ data }) => { if (alive) setPrefs((data as Record<string, boolean>) || {}) }, () => { if (alive) setPrefs({}) })
    return () => { alive = false }
  }, [token, supabase])

  const CATS: [string, string][] = [
    ['reminders', 'Appointment reminders & updates'],
    ['estimates', 'Estimates & quotes'],
    ['invoices', 'Invoices & receipts'],
    ['seasonal', 'Seasonal reminders'],
    ['marketing', 'Offers & news'],
  ]
  function toggleCat(k: string) {
    const next = { ...(prefs || {}), [k]: !(prefs?.[k] !== false) }
    setPrefs(next)
    onSave(consent, next)
  }

  // COLLAPSED by default. This card renders on every visit (consent is non-null
  // whenever the payload loaded), and once either channel is on it opens to SEVEN
  // toggle rows — so a first-time quote recipient, whose Home is otherwise just the
  // provider card and their quote, met a settings panel as the second-biggest thing
  // on the page. Settings are something you go looking for, not something that greets
  // you. One summary line, everything still one tap away; the prefs fetch above is
  // unchanged, so the rows are ready the moment they open it.
  return (
    <details className="group rounded-card border border-border bg-bg-secondary mt-3">
      <summary className="tap-target-y list-none cursor-pointer p-4 flex items-center gap-1.5 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        <MessageSquare className="w-4 h-4 text-accent-text shrink-0" />
        <span className="text-sm font-semibold text-ink">Message preferences</span>
        <ChevronDown className="w-4 h-4 text-ink-faint ml-auto shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4">
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Choose how we can reach you — you can change this anytime. Message &amp; data rates may apply to texts.</p>
      <div className="space-y-2">
        <PrefRow label="Text messages (SMS)" icon={MessageSquare} on={consent.sms} onChange={v => onSave({ ...consent, sms: v })} />
        <PrefRow label="Email" icon={Mail} on={consent.email} onChange={v => onSave({ ...consent, email: v })} />
      </div>
      {prefs !== null && (consent.sms || consent.email) && (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">What we message you about</p>
          {CATS.map(([k, label]) => (
            <PrefRow key={k} label={label} icon={MessageSquare} on={prefs[k] !== false} onChange={() => toggleCat(k)} />
          ))}
        </div>
      )}
      </div>
    </details>
  )
}

function PrefRow({ label, icon: Icon, on, onChange }: { label: string; icon: typeof Mail; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
      <span className="text-sm text-ink flex items-center gap-2"><Icon className="w-4 h-4 text-ink-muted" /> {label}</span>
      <button onClick={() => onChange(!on)} aria-pressed={on} aria-label={label}
        className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', on ? 'bg-accent' : 'bg-border-strong')}>
        <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform', on && 'translate-x-5')} />
      </button>
    </div>
  )
}

// ── Missing contact detail (PortalClient mounts it on Home — model.contactGap) ──
// Asks for the detail the file is actually missing, and writes it. The previous
// version fired only when BOTH were absent and could not write anything: it sent
// the typed values to the owner as a service request for them to re-type. That
// left the commonest gap in the book — a phone on file but no email — never
// asked, and made the owner do the work anyway.
//
// It stays a PROMPT, not a gate. Nothing here blocks viewing a quote, approving
// work, paying an invoice or checking a visit; it sits under those, it can be
// ignored forever, and it disappears the moment the row says the gap is closed.
// Closed as one card even when both are missing: two amber warnings competing
// over one problem is how a helpful ask starts reading like an error.
const FIELD_HELP: Record<Exclude<ContactGap, 'none'>, { title: string; why: string }> = {
  // Named after the value to the CUSTOMER, not to the business's database.
  phone: { title: 'Add your phone number', why: 'so we can reach you about your visit' },
  email: { title: 'Add your email', why: 'so your quotes, invoices and portal link can be sent to you' },
  both: { title: 'Complete your contact info', why: 'so we can reach you and send your paperwork' },
}

export function ContactMethodCard({ gap, businessName, onSave }: {
  gap: Exclude<ContactGap, 'none'>
  businessName: string | null
  onSave: (phone: string, email: string) => Promise<AddContactResult>
}) {
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const wantPhone = gap === 'phone' || gap === 'both'
  const wantEmail = gap === 'email' || gap === 'both'
  const who = businessName || 'your service provider'
  // "both" is satisfied by EITHER — one way to reach someone is the win; demanding
  // the second is how a helpful ask becomes a form.
  const filled = (wantPhone && phone.trim() !== '') || (wantEmail && email.trim() !== '')

  // The reasons the RPC can return, said in the customer's terms. `already_on_file`
  // and `phone_taken` are the two that are not the customer's fault and not
  // retryable by typing harder, so both hand off to the business.
  function explain(r: AddContactResult): string {
    switch (r.reason) {
      case 'bad_phone': return 'That doesn’t look like a complete phone number — please include the area code.'
      case 'bad_email': return 'That doesn’t look like a valid email address — please check it.'
      case 'phone_taken': return `That number is already on file for someone else with ${who}. Send them a message below and they’ll sort it out.`
      case 'email_taken': return `That email is already on file for someone else with ${who}. Send them a message below and they’ll sort it out.`
      case 'already_on_file': return 'Your file was just updated elsewhere — refresh to see what’s on it now.'
      case 'nothing_to_add': return 'Enter a phone number or an email address first.'
      case 'invalid_token': return 'This link is no longer valid, so we couldn’t save that.'
      default: return 'We couldn’t save that just now — your details are still here, please try again.'
    }
  }

  if (saved) return (
    <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.06] p-4 mt-3">
      <p className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Thanks — that’s on your file</p>
      <p className="text-xs text-ink-muted mt-0.5">{who} can reach you here from now on.</p>
    </div>
  )

  const help = FIELD_HELP[gap]
  return (
    // Neutral, not amber. This is a helpful ask about a detail we don't have, and
    // an alert colour would rank it against the customer's actual quote or invoice.
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
        {gap === 'email' ? <Mail className="w-4 h-4 text-accent-text" /> : <Phone className="w-4 h-4 text-accent-text" />}
        {help.title}
      </p>
      <p className="text-xs text-ink-muted mt-0.5 mb-3">Keep your details up to date {help.why}.</p>
      <form className="space-y-2" onSubmit={async e => {
        e.preventDefault()
        if (!filled || busy) return
        // Local mirror of the RPC's own rules — an obvious typo shouldn't cost a
        // round-trip. The server re-checks and remains the authority.
        if (wantPhone && phone.trim() && !isUsablePhone(phone)) { setError(explain({ ok: false, reason: 'bad_phone' })); return }
        if (wantEmail && email.trim() && !isUsableEmail(email)) { setError(explain({ ok: false, reason: 'bad_email' })); return }
        setBusy(true); setError(null)
        const res = await onSave(phone.trim(), email.trim())
        setBusy(false)
        // Success is what the ROW says, never that the call returned: the RPC reads
        // the customer back after its write and reports that. A failure keeps the
        // form, keeps every character typed, and says what happened.
        if (res.ok && (res.added?.length ?? 0) > 0) setSaved(true)
        else setError(explain(res))
      }}>
        {wantPhone && (
          <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => { setPhone(e.target.value); setError(null) }}
            placeholder="(403) 555-0100" aria-label="Phone number"
            // text-base below the sm breakpoint: iOS zooms the whole page in on any
            // focused input under 16px, and it does not zoom back out.
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
        )}
        {wantEmail && (
          <input type="email" inputMode="email" autoComplete="email" value={email} onChange={e => { setEmail(e.target.value); setError(null) }}
            placeholder="jane@example.com" aria-label="Email address"
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all" />
        )}
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
        <Button type="submit" className="w-full" loading={busy} disabled={!filled}>Save</Button>
      </form>
      {/* Says exactly what the write does. Adding a number is not agreeing to be
          texted — portal_add_contact touches neither opt-in column — and the
          Message preferences card below this one is where that actually changes. */}
      <p className="text-[10px] text-ink-faint mt-2">
        Only {who} sees this. It doesn’t change your message preferences.
      </p>
    </div>
  )
}
