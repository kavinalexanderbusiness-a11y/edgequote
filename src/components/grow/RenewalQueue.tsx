'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  createRenewedPlan, renewalQuoteHref, stashRenewalPrefill,
  type RenewalOpportunity, type RenewalReport, type RenewalStage,
} from '@/lib/renewals'
import { confirm } from '@/lib/confirm'
import { toast } from '@/lib/toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, ChevronDown, RefreshCw } from 'lucide-react'

// ── The renewal queue ────────────────────────────────────────────────────────
// FOUR THINGS PER ROW and nothing else, because this is read one-handed in a
// truck: who, what they used to buy, why it is on the list today, and the one
// button that moves it forward. Everything else — visit counts, dates, the
// evidence behind the reason — is behind a tap on the row itself.
//
// The button changes with the stage and there is never more than one, so the
// queue reads as a single track rather than a menu:
//
//   due       → Review renewal   (opens the quote builder, pre-filled)
//   drafted   → Finish & send    (the quote they started)
//   sent      → Open quote       (nothing to do — it is with the customer)
//   expired   → Send again
//   accepted  → Create the plan  ⭐ the only button in this file that writes visits
//
// ⛔ "Create the plan" asks first, and the question contains the real numbers —
// how many visits, between which dates, at what price. A season is a lot of rows
// to appear on somebody's calendar; the owner should have read the figures before
// they do.

export function RenewalQueue({
  report, error, loading, onChanged,
}: {
  report: RenewalReport | null
  error: string | null
  loading: boolean
  onChanged: () => void
}) {
  if (loading) {
    return (
      <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <div key={i} className="px-4 py-3 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        ))}
      </div>
    )
  }

  // A failed read is not an empty queue. Saying "nothing to renew" here would be
  // an all-clear about next year's revenue, invented by a dropped connection.
  if (error) {
    return (
      <Banner tone="warn" icon={AlertTriangle}>
        <span className="font-semibold text-ink">Couldn’t load renewals</span> — {error}. This is not
        “nothing to renew”: we don’t know. Check your connection and reload.
      </Banner>
    )
  }
  if (!report || report.opportunities.length === 0) {
    return (
      <div className="rounded-card border border-border bg-bg-secondary">
        <InlineEmpty icon={CalendarCheck}>
          No plans are ending soon. Renewals appear here about two months before a season comes
          round, or as a term plan runs out — never sooner, and never as a schedule you didn’t agree to.
        </InlineEmpty>
      </div>
    )
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
      {report.opportunities.map((o, i) => (
        <RenewalRow key={o.key} o={o} index={i} onChanged={onChanged} />
      ))}
    </div>
  )
}

const STAGE_CHIP: Record<RenewalStage, { label: string; cls: string } | null> = {
  due: null,
  drafted: { label: 'Draft', cls: 'text-ink-muted border-border' },
  sent: { label: 'Sent', cls: 'text-blue-400 border-blue-500/25' },
  expired: { label: 'Expired', cls: 'text-amber-400 border-amber-500/25' },
  accepted: { label: 'Accepted', cls: 'text-emerald-400 border-emerald-500/25' },
  declined: { label: 'Declined', cls: 'text-ink-faint border-border' },
  planned: { label: 'Booked', cls: 'text-emerald-400 border-emerald-500/25' },
}

function RenewalRow({ o, index, onChanged }: { o: RenewalOpportunity; index: number; onChanged: () => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const chip = STAGE_CHIP[o.stage]

  // The review door. The plan id rides in the URL and the pre-filled figures ride
  // in sessionStorage — see lib/renewals for why they travel separately.
  function review() {
    stashRenewalPrefill(o)
    router.push(renewalQuoteHref(o))
  }

  async function createPlan() {
    const visits = o.servedVisits
    const ok = await confirm({
      title: 'Create the renewed plan?',
      icon: CalendarCheck,
      confirmLabel: 'Create the plan',
      message: (
        <span className="block space-y-1.5">
          <span className="block">
            {o.customer.name} accepted {o.quote ? `quote ${o.quote.number}` : 'the renewal'}. This books{' '}
            <span className="font-semibold text-ink">{o.cadenceLabel.toLowerCase()} {o.serviceName}</span>{' '}
            from <span className="font-semibold text-ink">{formatDate(o.nextCycleStart)}</span>
            {o.renewedEndDate ? <> to <span className="font-semibold text-ink">{formatDate(o.renewedEndDate)}</span></> : ' with no end date'}.
          </span>
          <span className="block text-ink-muted">
            Visits are priced from the quote they accepted, so the money follows their yes.
          </span>
          <span className="block text-ink-muted">
            Last plan ran {visits} visit{visits !== 1 ? 's' : ''} — nothing about it changes.
          </span>
        </span>
      ),
    })
    if (!ok) return
    setBusy(true)
    const res = await createRenewedPlan(createClient(), o)
    setBusy(false)
    if (!res.ok) { toast.error(res.error || 'Could not create the plan.'); return }
    // A partial success reports itself: the visits exist, the quote status did not
    // move, and the owner is told which half needs a hand.
    if (res.error) toast.error(res.error)
    else toast.success(`${res.count} visit${res.count !== 1 ? 's' : ''} booked for ${o.customer.name}.`)
    onChanged()
  }

  return (
    <div className={`animate-rise stagger-${Math.min(index + 1, 6)}`}>
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* WHO */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link href={`/dashboard/customers/${o.customer.id}`}
              className="text-sm font-bold text-ink hover:text-accent-text truncate max-w-[60vw] sm:max-w-none">
              {o.customer.name}
            </Link>
            {o.isVip && <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-ink-muted shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-accent" />VIP</span>}
            {chip && <span className={`text-[10px] font-semibold px-1.5 py-px rounded border ${chip.cls} shrink-0`}>{chip.label}</span>}
          </div>
          {/* WHAT THEY USED TO BUY */}
          <p className="text-xs text-ink-muted truncate mt-0.5">
            {o.cadenceLabel} {o.serviceName}
            {o.perVisit > 0 && <> · {formatCurrency(o.perVisit)}/visit</>}
          </p>
          {/* WHY IT IS HERE TODAY */}
          <p className="text-xs text-ink-faint truncate mt-0.5">{o.reason}</p>
        </div>
        <div className="shrink-0 text-right">
          <RowAction stage={o.stage} busy={busy} quoteId={o.quote?.id ?? null} onReview={review} onCreate={createPlan} />
        </div>
      </div>

      {/* The facts, one tap away. Nothing in here is a score or a guess. */}
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="w-full px-4 pb-2.5 -mt-1 flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink-muted transition-colors">
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide' : 'Why this is here'}
      </button>
      {open && (
        <ul className="px-4 pb-3 space-y-1 animate-fade">
          {o.evidence.map((e, k) => (
            <li key={k} className="text-[11px] text-ink-muted flex gap-1.5">
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-ink-faint" aria-hidden />
              <span>{e}</span>
            </li>
          ))}
          <li className="text-[11px] text-ink-faint pt-0.5">
            Nothing is scheduled until {o.customer.name} accepts a renewal quote.
          </li>
        </ul>
      )}
    </div>
  )
}

// ONE button per row. `sm:` widens the label; the phone gets the short verb.
function RowAction({
  stage, busy, quoteId, onReview, onCreate,
}: {
  stage: RenewalStage; busy: boolean; quoteId: string | null
  onReview: () => void; onCreate: () => void
}) {
  const base = 'h-9 px-3 rounded-xl inline-flex items-center justify-center gap-1.5 text-xs font-semibold border transition-colors whitespace-nowrap'

  if (stage === 'accepted') {
    return (
      <button type="button" onClick={onCreate} disabled={busy}
        className={`${base} border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50`}>
        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CalendarCheck className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline">{busy ? 'Creating…' : 'Create the plan'}</span>
        <span className="sm:hidden">{busy ? '…' : 'Create'}</span>
      </button>
    )
  }
  if (quoteId && (stage === 'drafted' || stage === 'sent' || stage === 'expired')) {
    const label = stage === 'drafted' ? 'Finish & send' : stage === 'expired' ? 'Send again' : 'Open quote'
    return (
      <Link href={`/dashboard/quotes/${quoteId}`}
        className={`${base} border-border bg-surface text-ink hover:border-border-strong`}>
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{stage === 'sent' ? 'Open' : 'Send'}</span>
        <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    )
  }
  return (
    <button type="button" onClick={onReview}
      className={`${base} border-accent/25 bg-accent/10 text-accent-text hover:bg-accent/20`}>
      <span className="hidden sm:inline">Review renewal</span>
      <span className="sm:hidden">Review</span>
      <ArrowRight className="w-3.5 h-3.5" />
    </button>
  )
}
