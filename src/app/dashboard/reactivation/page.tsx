'use client'

import { useCallback, useEffect, useState } from 'react'
import { PageContainer } from '@/components/layout/PageContainer'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  loadReactivation, type DormantCustomer, type RanOutCustomer,
  type ReactivationReport, type RiskCustomer,
} from '@/lib/reactivation'
import { loadRenewals, type RenewalReport } from '@/lib/renewals'
import { formatCurrency, formatDate } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { RenewalQueue } from '@/components/grow/RenewalQueue'
import {
  Phone, MessageSquare, FileText, CalendarPlus, HeartPulse, DollarSign, Percent,
  TrendingUp, AlertTriangle, Repeat, RefreshCw, Moon, ChevronDown,
} from 'lucide-react'

// ── Renewals & Reactivation ──────────────────────────────────────────────────
// Two halves of one question — "who should I be bringing back, and why" — and
// they are on one page because the answer for any given customer is exactly one
// of them. Splitting them across two routes is how the same person ends up
// described two ways.
//
//   RENEWALS      their plan reached the ending it was given. Offer the next one.
//   RAN OUT       their plan stopped without an ending. Re-book them now.
//   LAPSED        real history, nothing booked, quiet for months.
//   DORMANT       ⭐ quiet FOR A STATED REASON. Not a problem. Shown anyway,
//                 collapsed, because a page that silently drops them is a page
//                 whose "all clear" cannot be trusted.
//
// The page derives NOTHING. It used to hold its own copy of the reactivation
// rule — a second implementation of the same idea the dashboard was already
// running from lib/reactivation, with the two free to disagree about the same
// customer. Both now read one engine, so the count on the dashboard and the rows
// on this page cannot come apart.

const BUCKETS: { key: '12+' | '6+' | '3+'; label: string; sub: string; tone: string }[] = [
  { key: '12+', label: '12+ months', sub: 'Top priority — long lapsed', tone: 'text-red-400' },
  { key: '6+', label: '6+ months', sub: 'Slipping away', tone: 'text-amber-400' },
  { key: '3+', label: '3+ months', sub: 'Worth a nudge', tone: 'text-blue-400' },
]

export default function ReactivationPage() {
  const [loading, setLoading] = useState(true)
  const [react, setReact] = useState<ReactivationReport | null>(null)
  const [reactError, setReactError] = useState<string | null>(null)
  const [renew, setRenew] = useState<RenewalReport | null>(null)
  const [renewError, setRenewError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [r, n] = await Promise.all([loadReactivation(supabase), loadRenewals(supabase)])
    // Each half reports its OWN outcome. One failing read must not blank the
    // other half of the page, and must not be reported as "nothing found".
    if (r.ok) { setReact(r.report); setReactError(null) } else { setReact(null); setReactError(r.error) }
    if (n.ok) { setRenew(n.report); setRenewError(null) } else { setRenew(null); setRenewError(n.error) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const risk = react?.risks ?? []
  const ranOut = react?.ranOuts ?? []
  const dormant = react?.dormant ?? []

  if (loading) {
    return (
      <PageContainer>
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Renewals & Reactivation"
          description="Bring back customers you already earned — without inventing a schedule they never agreed to." />
        <SkeletonTiles count={4} />
        <Card className="p-5"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-72 mt-2.5" /></Card>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Renewals & Reactivation"
        description="Bring back customers you already earned — without inventing a schedule they never agreed to." />

      {/* Headline metrics. Absent, not zero, when the read that feeds them failed:
          "At risk 0" over a broken connection is the single most misleading thing
          this page could say. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-rise">
        <StatTile icon={AlertTriangle} label="At risk" value={react ? String(react.atRisk) : '—'} tone="warn" />
        <StatTile icon={DollarSign} label="Potential recovery" value={react ? formatCurrency(react.potential) : '—'} tone="accent" />
        <StatTile icon={Percent} label="Reactivation rate" value={react ? `${react.reactivationRate}%` : '—'} />
        <StatTile icon={TrendingUp} label="Recovered (1y)" value={react ? formatCurrency(react.revenueRecovered) : '—'} tone="success" />
      </div>

      {reactError && (
        <Banner tone="warn" icon={AlertTriangle}>
          <span className="font-semibold text-ink">Couldn’t load the at-risk list</span> — {reactError}.
          The figures above are blank because we don’t know them, not because they’re zero.
        </Banner>
      )}

      {/* ── RENEWALS ─────────────────────────────────────────────────────────── */}
      <section id="renewals" className="space-y-3 scroll-mt-20">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <RefreshCw className="w-3.5 h-3.5 text-accent-text" />
          </span>
          <h2 className="text-sm font-semibold text-ink tracking-tight">Renewals</h2>
          <span className="text-xs text-ink-faint tabular-nums">
            {renew
              ? renew.opportunities.length === 0
                ? 'Plans that reached their agreed end'
                : `${renew.actionable} need you · ${renew.opportunities.length} plan${renew.opportunities.length !== 1 ? 's' : ''} · ${formatCurrency(renew.valueAtStake)} last cycle`
              : 'Plans that reached their agreed end'}
          </span>
          <span className="flex-1 h-px bg-border" aria-hidden />
        </div>
        <RenewalQueue report={renew} error={renewError} loading={false} onChanged={load} />
      </section>

      {/* ── RAN OUT — the urgent queue, and ONLY the unplanned stops ─────────── */}
      {ranOut.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <Repeat className="w-3.5 h-3.5 text-accent-text" />
            </span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Recurring plan ran out</h2>
            <span className="text-xs text-ink-faint tabular-nums">Stopped with no end date set · {ranOut.length} customer{ranOut.length !== 1 ? 's' : ''} · {formatCurrency(ranOut.reduce((s, r) => s + r.perVisit, 0))}/visit at stake</span>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          {ranOut.map((r, i) => <div key={r.customer.id} className={`animate-rise stagger-${Math.min(i + 1, 6)}`}><RanOutCard r={r} /></div>)}
        </div>
      )}

      {/* ── LAPSED ───────────────────────────────────────────────────────────── */}
      {react && risk.length === 0 && ranOut.length === 0 && (!renew || renew.opportunities.length === 0) ? (
        <Card><EmptyState icon={HeartPulse} tone="positive" className="py-14" title="Every customer is booked, renewing or recently served"
          description="When someone starts slipping away, they’ll appear here — valued and ranked, with one-tap ways to reach out." /></Card>
      ) : BUCKETS.map(b => {
        const list = risk.filter(r => r.bucket === b.key)
        if (list.length === 0) return null
        return (
          <div key={b.key} className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><AlertTriangle className="w-3.5 h-3.5 text-accent-text" /></span>
              <h2 className={`text-sm font-semibold tracking-tight ${b.tone}`}>{b.label}</h2>
              <span className="text-xs text-ink-faint tabular-nums">{b.sub} · {list.length} customer{list.length !== 1 ? 's' : ''} · {formatCurrency(list.reduce((s, r) => s + r.potentialRecovery, 0))} potential</span>
              <span className="flex-1 h-px bg-border" aria-hidden />
            </div>
            {list.map((r, i) => <div key={r.customer.id} className={`animate-rise stagger-${Math.min(i + 1, 6)}`}><RiskCard r={r} /></div>)}
          </div>
        )
      })}

      {dormant.length > 0 && <DormantPanel rows={dormant} />}
    </PageContainer>
  )
}

// ⭐ DORMANT ≠ LOST, said out loud. Collapsed by default because there is nothing
// to do here — but present, because these customers were previously dropped in
// silence and silence is what makes an "all clear" a lie.
function DormantPanel({ rows }: { rows: DormantCustomer[] }) {
  const [open, setOpen] = useState(false)
  const between = rows.filter(r => r.reason === 'between_seasons').length
  const ended = rows.filter(r => r.reason === 'ended_deliberately').length
  const finished = rows.filter(r => r.reason === 'plan_completed').length
  const renewing = rows.filter(r => r.reason === 'renewal_open').length
  const parts = [
    between ? `${between} between seasons` : null,
    finished ? `${finished} finished their plan` : null,
    renewing ? `${renewing} up for renewal above` : null,
    ended ? `${ended} ended on purpose` : null,
  ].filter(Boolean)

  return (
    <Card>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="w-full px-5 py-4 flex items-center gap-3 text-left">
        <span className="w-6 h-6 rounded-md bg-bg-tertiary border border-border flex items-center justify-center shrink-0">
          <Moon className="w-3.5 h-3.5 text-ink-faint" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">Quiet, and that’s correct — {rows.length} customer{rows.length !== 1 ? 's' : ''}</span>
          <span className="block text-xs text-ink-faint truncate">{parts.join(' · ')}. Not at risk, not counted above.</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-faint shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border animate-fade">
          {rows.map(d => (
            <div key={d.customer.id} className="px-5 py-2.5 flex items-baseline gap-2">
              <Link href={`/dashboard/customers/${d.customer.id}`} className="text-xs font-semibold text-ink hover:text-accent-text truncate shrink-0 max-w-[40%]">
                {d.customer.name}
              </Link>
              <span className="text-xs text-ink-faint truncate">{d.note}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function RiskCard({ r }: { r: RiskCustomer }) {
  const [msg, setMsg] = useState(false)
  const c = r.customer
  const phone = c.phone || null
  const months = Math.floor(r.daysSince / 30)
  return (
    <Card className="card-lift">
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-bold text-ink hover:text-accent-text truncate">{c.name}</Link>
              {r.isVip && <VipChip />}
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              Last service {formatDate(r.lastServiceDate)} · <span className="text-amber-400 font-medium">{months}mo ({r.daysSince}d) ago</span>
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Potential</p>
            <p className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(r.potentialRecovery)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Stat label="Lifetime" value={formatCurrency(r.lifetimeRevenue)} />
          <Stat label="Jobs done" value={String(r.jobsCompleted)} />
          <Stat label="Last quote" value={r.lastQuoteAmount ? formatCurrency(r.lastQuoteAmount) : '—'} />
          <Stat label="Service" value={r.lastServiceType} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone}
            className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${phone ? 'bg-accent/10 border-accent/20 text-accent-text hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
            <Phone className="w-4 h-4" /> Call
          </a>
          {/* Through THE composer (not a raw sms: link) — so the win-back text is
              consent-gated, threaded into the conversation, and in the send ledger. */}
          <button type="button" onClick={() => setMsg(true)}
            className="h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border bg-surface border-border text-ink hover:border-border-strong transition-colors">
            <MessageSquare className="w-4 h-4" /> Message
          </button>
          {msg && <SendMessageDialog open customerId={c.id} customerName={c.name} onClose={() => setMsg(false)} />}
          <Link href={`/dashboard/quotes/new?customer=${c.id}`}
            className="h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors">
            <FileText className="w-4 h-4" /> Quote
          </Link>
          <Link href={`/dashboard/schedule?customer=${c.id}`}
            className="h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            <CalendarPlus className="w-4 h-4" /> Schedule
          </Link>
        </div>
      </CardBody>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint truncate">{label}</p>
      <p className="text-sm font-bold text-ink mt-0.5 truncate tabular-nums">{value}</p>
    </div>
  )
}

function VipChip() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-ink-muted shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-accent" /> VIP
    </span>
  )
}

function RanOutCard({ r }: { r: RanOutCustomer }) {
  const [msg, setMsg] = useState(false)
  const c = r.customer
  const phone = c.phone || null
  const cadence = r.cadence === 'weekly' ? 'Weekly' : r.cadence === 'biweekly' ? 'Bi-weekly' : r.cadence === 'monthly' ? 'Monthly' : 'Recurring'
  return (
    <Card className="border-red-500/20 card-lift">
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-bold text-ink hover:text-accent-text truncate">{c.name}</Link>
              {r.isVip && <VipChip />}
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              <span className="text-red-400 font-medium">{cadence} customer · no next visit</span> · last served {formatDate(r.lastServiceDate)} ({r.daysSince}d ago)
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Per visit</p>
            <p className="text-lg font-bold text-accent-text tabular-nums">{r.perVisit > 0 ? formatCurrency(r.perVisit) : '—'}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link href={`/dashboard/schedule?customer=${c.id}`}
            className="h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            <CalendarPlus className="w-4 h-4" /> Schedule next
          </Link>
          <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone}
            className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${phone ? 'bg-accent/10 border-accent/20 text-accent-text hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
            <Phone className="w-4 h-4" /> Call
          </a>
          <button type="button" onClick={() => setMsg(true)}
            className="h-10 rounded-xl items-center justify-center gap-1.5 text-xs font-medium border bg-surface border-border text-ink hover:border-border-strong transition-colors hidden sm:flex">
            <MessageSquare className="w-4 h-4" /> Message
          </button>
          {msg && <SendMessageDialog open customerId={c.id} customerName={c.name} onClose={() => setMsg(false)} />}
        </div>
      </CardBody>
    </Card>
  )
}
