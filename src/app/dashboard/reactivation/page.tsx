'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  loadReactivation, VIP_THRESHOLD,
  type RiskCustomer, type RanOutCustomer, type Bucket,
} from '@/lib/reactivation'
import { formatCurrency, formatDate } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { Phone, MessageSquare, FileText, CalendarPlus, HeartPulse, DollarSign, Percent, TrendingUp, AlertTriangle, Repeat } from 'lucide-react'

// Types, thresholds and the at-risk math all live in lib/reactivation — THE one
// engine, so this page, Today's Priorities and the dashboard never disagree.

const BUCKETS: { key: Bucket; label: string; sub: string; tone: string }[] = [
  { key: '12+', label: '12+ months', sub: 'Top priority — long lapsed', tone: 'text-red-400' },
  { key: '6+', label: '6+ months', sub: 'Slipping away', tone: 'text-amber-400' },
  { key: '3+', label: '3+ months', sub: 'Worth a nudge', tone: 'text-blue-400' },
]

export default function ReactivationPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [risk, setRisk] = useState<RiskCustomer[]>([])
  const [ranOut, setRanOut] = useState<RanOutCustomer[]>([])
  const [metrics, setMetrics] = useState({ atRisk: 0, potential: 0, reactivationRate: 0, revenueRecovered: 0 })

  useEffect(() => {
    async function load() {
      const r = await loadReactivation(supabase)
      setRisk(r.risks)
      setRanOut(r.ranOuts)
      setMetrics({ atRisk: r.atRisk, potential: r.potential, reactivationRate: r.reactivationRate, revenueRecovered: r.revenueRecovered })
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Customer Reactivation" description="Win back customers you already paid to acquire." />
        <SkeletonTiles count={4} />
        <Card className="p-5"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-72 mt-2.5" /></Card>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Customer Reactivation" description="Win back customers you already paid to acquire." />

      {/* Headline metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-rise">
        <StatTile icon={AlertTriangle} label="At risk" value={String(metrics.atRisk)} tone="warn" />
        <StatTile icon={DollarSign} label="Potential recovery" value={formatCurrency(metrics.potential)} tone="accent" />
        <StatTile icon={Percent} label="Reactivation rate" value={`${metrics.reactivationRate}%`} />
        <StatTile icon={TrendingUp} label="Recovered (1y)" value={formatCurrency(metrics.revenueRecovered)} tone="success" />
      </div>

      {/* Recurring series ran out — the urgent re-book queue (any days-since) */}
      {ranOut.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <Repeat className="w-3.5 h-3.5 text-accent-text" />
            </span>
            <h2 className="text-sm font-semibold text-ink tracking-tight">Recurring series ran out</h2>
            <span className="text-xs text-ink-faint tabular-nums">No next visit booked · {ranOut.length} customer{ranOut.length !== 1 ? 's' : ''} · {formatCurrency(ranOut.reduce((s, r) => s + r.perVisit, 0))}/visit at stake</span>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          {ranOut.map((r, i) => <div key={r.customer.id} className={`animate-rise stagger-${Math.min(i + 1, 6)}`}><RanOutCard r={r} /></div>)}
        </div>
      )}

      {risk.length === 0 && ranOut.length === 0 ? (
        <Card><EmptyState icon={HeartPulse} tone="positive" className="py-14" title="Every customer is booked or recently served"
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
    </div>
  )
}


function RiskCard({ r }: { r: RiskCustomer }) {
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
          <a href={phone ? `sms:${phone}` : undefined} aria-disabled={!phone}
            className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
            <MessageSquare className="w-4 h-4" /> Text
          </a>
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
          <a href={phone ? `sms:${phone}` : undefined} aria-disabled={!phone}
            className={`h-10 rounded-xl items-center justify-center gap-1.5 text-xs font-medium border transition-colors hidden sm:flex ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
            <MessageSquare className="w-4 h-4" /> Text
          </a>
        </div>
      </CardBody>
    </Card>
  )
}
