import Link from 'next/link'
import { ButtonLink } from '@/components/ui/Button'
import { cn, formatCurrency } from '@/lib/utils'
import type { Priority, PriorityKind } from '@/lib/dashboard/priorities'
import {
  ListChecks, CheckCircle2, ArrowRight, Plus,
  DollarSign, FileText, Bell, CalendarPlus, AlertTriangle, MessageSquare, MessageSquarePlus, Repeat, UserPlus, HeartPulse, PhoneOff,
} from 'lucide-react'

// ONE ranked queue of the highest-value things to do right now. The ranking and
// the numbers come from lib/dashboard/priorities (pure, shared with nothing else
// to disagree with); this file is presentation only — it maps each `kind` to its
// icon and tone and renders links. Server-rendered: no fetch, no skeleton, the
// queue is simply there when the page paints.

const META: Record<PriorityKind, { icon: typeof DollarSign; tone: string }> = {
  unpaid:       { icon: DollarSign,    tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  leads:        { icon: UserPlus,      tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  unscheduled:  { icon: CalendarPlus,  tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  missed:       { icon: AlertTriangle, tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  drafts:       { icon: FileText,      tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  followups:    { icon: Bell,          tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  // Muted on purpose: it's real money, but nothing can be DONE about it until a
  // contact detail exists, so it must not compete with the rows you can act on.
  followups_blocked: { icon: PhoneOff, tone: 'text-ink-muted bg-bg-tertiary border-border' },
  reactivation: { icon: Repeat,        tone: 'text-accent-text bg-accent/10 border-accent/20' },
  lapsed:       { icon: HeartPulse,    tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  messages:     { icon: MessageSquare, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  // Accent rather than sky: a customer asking for work is a revenue row wearing
  // an inbox icon, and it must not read as "more unread messages".
  requests:     { icon: MessageSquarePlus, tone: 'text-accent-text bg-accent/10 border-accent/20' },
}

// `started` defaults TRUE so the only behaviour that can change is the one an
// explicitly-brand-new account opts into — every other caller keeps today’s card.
export function TodaysPriorities({ items, started = true }: { items: Priority[]; started?: boolean }) {
  // An empty queue means two opposite things. For a business that has worked, it
  // is an achievement — "you’re all caught up". For one that has never had a
  // customer, a quote or a job, the same words say "there is nothing for you to
  // do" on the one card the owner reads first, in the first minute they use the
  // product. Nothing else on this screen names a first action either: the money
  // band is four honest $0 tiles and the month strip three more, so the whole
  // page reads as finished before anything has begun.
  //
  // So the empty-and-never-started case says the ONE thing to do instead. Not a
  // wizard and not a checklist — the quote is the first move (the quote form
  // creates the customer and the property as it saves, so nothing has to exist
  // first), and everything downstream — the job, the schedule, the invoice —
  // follows from it.
  const firstRun = items.length === 0 && !started
  return (
    <div className="rounded-card border border-accent/20 hero-aurora overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 icon-glow flex items-center justify-center shrink-0">
          <ListChecks className="w-4 h-4 text-accent-text" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold tracking-tight text-ink">{firstRun ? 'Start here' : 'Today\u2019s Priorities'}</h2>
          {/* Name the ordering. The queue IS ranked (urgency × value, per the
              engine's own description) and #1 wears "Do first" — but nothing told
              the owner the list is deliberately ordered rather than an arbitrary
              pile, so "work top-down" wasn't legible. This is the vision's
              "explain the ranking" posture, in plain words. Only when there are
              rows to rank — the empty state speaks for itself. */}
          {items.length > 0 && (
            <p className="text-[11px] text-ink-muted">Most urgent and highest-value first</p>
          )}
        </div>
      </div>

      {firstRun ? (
        <div className="px-5 py-10 text-center">
          <div className="w-11 h-11 mx-auto rounded-full bg-accent/10 border border-accent/25 flex items-center justify-center mb-3">
            <FileText className="w-5 h-5 text-accent-text" />
          </div>
          <p className="text-sm font-semibold text-ink">Create your first quote</p>
          {/* Says what happens NEXT, so the first action reads as the start of a
              path rather than an isolated errand — and answers the question the
              owner actually has ("do I need to set up customers first?"). */}
          <p className="text-xs text-ink-muted mt-1 max-w-xs mx-auto">
            Price a job and send it. The customer, the scheduled work and the invoice all follow from the quote &mdash; there&rsquo;s nothing to set up first.
          </p>
          <ButtonLink href="/dashboard/quotes/new" className="mt-4">
            <Plus className="w-4 h-4" /> New quote
          </ButtonLink>
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="w-11 h-11 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center mb-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          </div>
          <p className="text-sm font-semibold text-ink">You&rsquo;re all caught up</p>
          <p className="text-xs text-ink-muted mt-1">No leads waiting, unpaid invoices, follow-ups or unread replies right now.</p>
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {items.map((p, i) => {
            const meta = META[p.kind]
            const Icon = meta.icon
            return (
              <li key={p.kind}>
                <Link
                  href={p.href}
                  // -outline-offset pulls the ring INSIDE the row: these rows sit
                  // flush against the card's rounded border, so an outset ring
                  // would clip against it on the first and last item.
                  // The top row carries a faint accent wash — the SAME "this is
                  // the one that matters" treatment WeekendOutlook gives today's
                  // row. A ranked queue whose #1 looks identical to its #8 isn't
                  // opening on "the one next action"; this makes where-to-start
                  // unmistakable without inventing a new pattern.
                  className={cn('group flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-surface-raised/40 active:bg-surface-raised/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
                    i === 0 && 'bg-accent/[0.04]')}
                >
                  {/* Both decorative: this is an <ol>, so assistive tech already
                      conveys the rank, and the icon just restates the label. */}
                  <span aria-hidden className={cn('shrink-0 w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center tabular-nums',
                    i === 0 ? 'bg-accent/15 text-accent-text' : 'bg-bg-tertiary text-ink-faint')}>{i + 1}</span>
                  <span aria-hidden className={cn('shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center', meta.tone)}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* Real text, not decorative: it names the action to take
                        first, so a screen reader benefits from hearing it. */}
                    {i === 0 && (
                      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-text mb-0.5">Do first</span>
                    )}
                    <span className="block text-sm font-semibold tracking-tight text-ink truncate">{p.label}</span>
                    {/* Why this one, then how many others wait behind it. The
                        "+N more" is deliberately TEXT, not a second link: the row
                        keeps exactly one destination (the record it names), and
                        working the top of the queue is what reveals the next.
                        Without it, naming one customer would read as a claim that
                        they are the only one. */}
                    <span className="block text-xs text-ink-muted truncate mt-0.5 tabular-nums">
                      {p.detail}
                      {p.more != null && p.more > 0 && (
                        <span className="text-ink-faint"> · +{p.more} more</span>
                      )}
                    </span>
                  </span>
                  {/* The dollars that JUSTIFIED this row's rank, in full-size
                      type. The queue orders by urgency × value, yet the value
                      used to be the least legible text in the band — buried in
                      the muted detail line. The engine sets `value` only for
                      unqualified piles of money, so this column never mixes
                      unlike figures (per-visit and "recoverable" stay in the
                      detail text where their qualifiers live). */}
                  {p.value != null && p.value > 0 && (
                    <span className={cn('shrink-0 text-sm font-bold tabular-nums tracking-tight',
                      p.kind === 'followups_blocked' ? 'text-ink-muted' : 'text-ink')}>
                      {formatCurrency(p.value)}
                    </span>
                  )}
                  <ArrowRight className="w-4 h-4 text-ink-faint shrink-0 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
