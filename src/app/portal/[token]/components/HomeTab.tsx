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
  CalendarClock, Check, CheckCircle2, CreditCard, FileText, Globe,
  Image as ImageIcon, Loader2, Mail, MessageSquare, MessageSquarePlus,
  Navigation, PauseCircle, Phone, Receipt, Repeat, SkipForward, Star,
  UserRound, XCircle,
} from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { confirm as confirmDialog } from '@/lib/confirm'
import { createClient } from '@/lib/supabase/client'
import {
  daysAwayLabel, liveStatusOf, visitToCalendarEvent, visitDay,
  type Derived, type PortalJob, type PortalView, type SubmitRequestFn,
} from '../model'
import { AddToCalendar, PortalSection, StatusPill, StatusStepper, Thumb, type TabProps } from './shared'

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
  const events = useRecentActivity(view)

  return (
    <div className="space-y-3">
      {/* 1 · Who takes care of you — quiet trust card, not a pitch */}
      <TrustCard view={view} />

      {/* 2 · Needs your attention — no-pressure framing on purpose */}
      {awaiting.length > 0 && (
        <button type="button" onClick={() => actions.navigate('billing', { docsCat: 'quote' })}
          className="w-full text-left rounded-card border border-amber-500/30 bg-amber-500/10 p-4 hover:border-amber-500/50 active:scale-[0.99] transition-colors card-lift animate-rise stagger-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><FileText className="w-4 h-4" /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink truncate">
                  {awaiting.length === 1
                    ? (awaiting[0].title !== 'Quote' ? `Your ${awaiting[0].title} quote is ready` : 'Your quote is ready')
                    : `${awaiting.length} quotes are ready for your review`}
                </p>
                <p className="text-xs text-ink-muted">
                  {awaiting.length === 1 ? `${formatCurrency(awaiting[0].amount)} — review and approve when you're ready` : `Review and approve when you're ready`}
                </p>
                {awaiting.length === 1 && (
                  <p className="text-[11px] text-ink-faint mt-0.5">Valid until {formatDate(new Date(new Date(awaiting[0].date).getTime() + 30 * 86400000).toISOString().slice(0, 10))}</p>
                )}
              </div>
            </div>
            <span className="text-xs font-semibold text-amber-400 shrink-0">Review →</span>
          </div>
        </button>
      )}
      {/* "Outstanding" is collections vocabulary — it lands like an accusation on
          the one banner someone reads when they're already tense about money. */}
      {view.money.due > 0 && (
        <button type="button" onClick={() => actions.navigate('billing', { docsCat: 'invoice' })}
          className="w-full text-left rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-4 hover:border-amber-500/50 active:scale-[0.99] transition-colors card-lift animate-rise stagger-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0"><Receipt className="w-4 h-4" /></div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  Amount due · <span className="tabular-nums text-amber-400">{formatCurrency(view.money.due)}</span>
                </p>
                <p className="text-xs text-ink-muted">
                  {view.money.owingCount === 1 ? '1 invoice' : `${view.money.owingCount} invoices`} — view and pay whenever you&rsquo;re ready
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold text-amber-400 shrink-0">View →</span>
          </div>
        </button>
      )}

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
            <p className="text-sm text-ink-muted mt-1">
              We&rsquo;re arranging your first visit. The date will appear here as soon as it&rsquo;s booked
              {biz && (biz.phone || biz.email_primary) ? ' — and you can call or email us any time using the card above.' : '.'}
            </p>
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
                <PlanRow p={p} />
                {/* The way out, on the plan itself. These SEND A REQUEST the owner
                    confirms — the plan doesn't change until a human says so, and the
                    copy says exactly that. Free-text "send us a message" stays below
                    for everything these don't cover. */}
                <PlanActions plan={p} businessName={biz?.company_name || null} submitRequest={actions.submitRequest} />
              </div>
            ))}
          </div>
          {/* An ongoing arrangement with no visible way out is what makes people feel
              trapped — the buttons above are that way out. This line covers the asks
              that aren't a button (change frequency, different day of week, …). */}
          <p className="text-xs text-ink-muted mt-2.5 pt-2.5 border-t border-border/60">
            Anything else about your plan?{' '}
            <button type="button" onClick={() => actions.navigate('messages')} className="text-accent-text font-medium hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">Send us a message</button>
            {biz?.phone ? <> or call <a href={`tel:${biz.phone}`} className="text-accent-text font-medium hover:underline">{biz.phone}</a>.</> : '.'}
          </p>
        </div>
      )}

      {/* 6 · Recent activity — the old Timeline tab, compacted to its last 5 rows */}
      {events.length > 0 && (
        <div className="animate-rise stagger-6">
          <PortalSection title="Recent activity">
            <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border/60">
              {events.map(e => (
                <div key={e.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                  <span className={cn('w-6 h-6 rounded-full border flex items-center justify-center shrink-0', e.tone)}><e.icon className="w-3 h-3" /></span>
                  <p className="text-sm text-ink min-w-0 flex-1 truncate">
                    {e.title}
                    {e.sub && <span className="text-xs text-ink-muted"> · {e.sub}</span>}
                  </p>
                  <span className="text-[11px] text-ink-faint shrink-0">{formatDate(e.at)}</span>
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
          {biz.phone && <a href={`tel:${biz.phone}`} className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Phone className="w-4 h-4 text-accent-text" /> Call</a>}
          {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Mail className="w-4 h-4 text-accent-text" /> Email</a>}
          {biz.website && <a href={biz.website.startsWith('http') ? biz.website : `https://${biz.website}`} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl border border-border bg-bg-tertiary py-2.5 text-ink hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"><Globe className="w-4 h-4 text-accent-text" /> Website</a>}
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
function PlanRow({ p }: { p: Derived['plans'][number] }) {
  const perVisit = p.recurringPrice ?? p.initialPrice
  return (
    <div className="rounded-xl border border-border bg-bg-tertiary/40 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <span className={cn('w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 mt-0.5',
          p.paused ? 'border-border bg-bg-tertiary text-ink-faint' : 'border-accent/25 bg-accent/10 text-accent-text')}>
          <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink flex flex-wrap items-center gap-x-2 gap-y-1">
            {p.serviceName}
            <span className="text-xs font-medium text-ink-muted">· {p.cadenceLabel}</span>
            {p.paused && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border border-border text-ink-faint">
                No visits booked
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
              <span className="text-ink">
                Next visit <span className="font-semibold">{formatDate(p.nextVisitDate)}</span>
                {p.remaining > 1 && <span className="text-ink-muted"> · {p.remaining} booked</span>}
              </span>
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
function PlanActions({ plan, businessName, submitRequest }: {
  plan: Derived['plans'][number]; businessName: string | null; submitRequest: SubmitRequestFn
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
    <div className="flex flex-wrap gap-1.5 mt-2 pl-[22px]">
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
  )
}

// ── 6 · Recent activity (the old Timeline tab, absorbed and capped at 5) ────
interface TLEvent { id: string; at: string; icon: typeof FileText; tone: string; title: string; sub: string | null }

function paymentMethodLabel(provider: string): string {
  switch (provider) {
    case 'stripe': return 'Card'
    case 'etransfer': return 'E-transfer'
    case 'cash': return 'Cash'
    default: return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Payment'
  }
}

function useRecentActivity(view: PortalView): TLEvent[] {
  return useMemo<TLEvent[]>(() => {
    const { data, photosByJob, docItems } = view
    const ev: TLEvent[] = []
    // Quote events read the DISPLAY status + GST-true totals off DocItem — the
    // exact figures the documents rows show — so this feed can never disagree
    // with the row it summarizes and never runs a second status/money engine.
    const quoteStatusByRaw = new Map(docItems.filter(d => d.kind === 'quote').map(d => [d.rawId, d.status]))
    // This event is stamped at the date the quote was SENT, so that's what its title has
    // to say. "Quote Q-123 accepted" dated the day it went out is a small lie the eye
    // doesn't catch — the customer approved it days later. The outcome belongs in the
    // subtitle, where it reads as current state rather than as something that happened
    // at this point on the line. Tone follows the same rule: amber means "this still
    // wants you", so a declined or lapsed quote must not wear it.
    for (const q of data.quotes) {
      const st = quoteStatusByRaw.get(q.id) ?? q.status
      const outcome = st === 'accepted' ? 'Approved'
        : st === 'declined' ? 'Declined'
        : st === 'expired' ? 'Expired'
        : st === 'sent' ? 'Awaiting your approval'
        : null
      ev.push({
        id: 'q' + q.id, at: q.issued_date || q.created_at, icon: FileText,
        tone: st === 'accepted' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
          : st === 'sent' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
          : 'text-ink-muted border-border bg-bg-tertiary',
        title: `Quote ${q.quote_number} sent`,
        sub: [q.service_type || null, outcome].filter(Boolean).join(' · ') || null,
      })
    }
    for (const j of data.jobs) {
      if (j.completed_at || j.status === 'completed') ev.push({ id: 'jc' + j.id, at: j.completed_at || j.scheduled_date, icon: CheckCircle2, tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', title: `${j.service_type || j.title} completed`, sub: null })
      else ev.push({ id: 'js' + j.id, at: j.scheduled_date, icon: CalendarClock, tone: 'text-sky-400 border-sky-500/30 bg-sky-500/10', title: `${j.service_type || j.title} scheduled`, sub: null })
    }
    // Draft invoices are the owner's unfinished work and are filtered out of the
    // customer's documents list (buildDocItems does it) — iterating DocItems means
    // they cannot leak onto this feed either, and `amount` is already the
    // discounted+GST total those rows display.
    for (const d of docItems.filter(d => d.kind === 'invoice')) {
      const settled = d.status === 'paid' || d.status === 'overpaid'
      ev.push({
        id: d.id, at: d.date, icon: Receipt,
        tone: 'text-ink-muted border-border bg-bg-tertiary',
        title: `Invoice ${d.number} issued`,
        // The amount alone left the customer to cross-reference whether they'd paid it.
        sub: `${formatCurrency(d.amount)}${settled ? ' · Paid' : d.status === 'cancelled' ? ' · Cancelled' : ' · Due'}`,
      })
    }
    // The PaymentsTab keeps credits out of the receipt list and renders negatives as
    // "Refund" — the timeline did neither, so a $200 refund read as a green "Payment
    // received · -$200.00" and an account credit read as money we'd taken. No refunds
    // exist yet; this is the day-one behaviour when one does.
    for (const p of data.payments) {
      if (p.kind === 'credit') continue
      const refund = Number(p.amount) < 0
      ev.push({
        id: 'p' + p.id, at: p.paid_at || p.created_at, icon: CreditCard,
        tone: refund ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
        title: refund ? 'Refund issued' : `Payment received · ${paymentMethodLabel(p.provider)}`,
        sub: formatCurrency(Math.abs(Number(p.amount))),
      })
    }
    for (const [jid, ps] of photosByJob) { if (jid !== 'none' && ps.length) ev.push({ id: 'ph' + jid, at: ps[0]?.taken_at || '', icon: ImageIcon, tone: 'text-violet-400 border-violet-500/30 bg-violet-500/10', title: `${ps.length} photo${ps.length === 1 ? '' : 's'} added`, sub: null }) }
    return ev.filter(e => e.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)
  }, [view])
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

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-accent-text" /> Message preferences</p>
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
