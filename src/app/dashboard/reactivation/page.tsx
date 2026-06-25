'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Customer } from '@/types'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { seasonForService, isWithinSeason, settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { formatCurrency, formatDate } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Phone, MessageSquare, FileText, CalendarPlus, HeartPulse, DollarSign, Percent, TrendingUp, AlertTriangle, Repeat, Star } from 'lucide-react'

interface JobLite { customer_id: string | null; scheduled_date: string; status: string; service_type: string | null; quote_id: string | null; recurrence_id: string | null; price: number | null }
interface QuoteLite { id: string; customer_id: string | null; status: string; total: number | null; service_type: string; created_at: string; initial_price: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null }

type Bucket = '12+' | '6+' | '3+'

// Lifetime revenue at/above this marks a VIP — losing one is worth more than many
// one-off lapses, so VIPs sort to the top of every at-risk list.
const VIP_THRESHOLD = 1500

interface RiskCustomer {
  customer: Customer
  lastServiceDate: string
  daysSince: number
  jobsCompleted: number
  lifetimeRevenue: number
  lastQuoteAmount: number
  lastServiceType: string
  potentialRecovery: number
  bucket: Bucket
  isVip: boolean
}

// A recurring customer whose visit series has run dry (no future visit booked).
// Distinct from the 90-day buckets: a weekly customer is overdue at 7 days, not 90.
interface RanOutCustomer {
  customer: Customer
  lastServiceDate: string
  daysSince: number
  cadence: string
  perVisit: number
  lifetimeRevenue: number
  isVip: boolean
}

function localTodayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysBetween(aISO: string, bISO: string) {
  return Math.floor((new Date(bISO + 'T00:00:00').getTime() - new Date(aISO + 'T00:00:00').getTime()) / 86400000)
}

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
      const { data: { user } } = await supabase.auth.getUser()
      const [cRes, jRes, qRes, rRes, sRes] = await Promise.all([
        supabase.from('customers').select('*').eq('user_id', user!.id).is('archived_at', null), // don't suggest re-engaging deliberately-archived customers
        supabase.from('jobs').select('customer_id, scheduled_date, status, service_type, quote_id, recurrence_id, price').eq('user_id', user!.id),
        supabase.from('quotes').select('id, customer_id, status, total, service_type, created_at, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
        supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
        supabase.from('business_settings').select('service_seasons').eq('user_id', user!.id).maybeSingle(),
      ])
      const seasons: ServiceSeasons = settingsToSeasons((sRes.data as { service_seasons: unknown } | null)?.service_seasons)
      const customers = (cRes.data as Customer[]) || []
      const jobs = (jRes.data as JobLite[]) || []
      const quotes = (qRes.data as QuoteLite[]) || []
      const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
      for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r
      const quotesById: Record<string, QuoteLite> = {}
      for (const q of quotes) quotesById[q.id] = q

      const today = localTodayISO()
      const jobsByCust: Record<string, JobLite[]> = {}
      for (const j of jobs) if (j.customer_id) (jobsByCust[j.customer_id] ||= []).push(j)
      const quotesByCust: Record<string, QuoteLite[]> = {}
      for (const q of quotes) if (q.customer_id) (quotesByCust[q.customer_id] ||= []).push(q)

      // Reuse the ONE valuation engine for "what is this visit worth".
      const jobValue = (j: JobLite): number => {
        const q = j.quote_id ? quotesById[j.quote_id] : null
        const rec = j.recurrence_id ? recById[j.recurrence_id] : null
        const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
        return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq)
      }

      const risks: RiskCustomer[] = []
      const ranOuts: RanOutCustomer[] = []
      let reactivated = 0
      let revenueRecovered = 0

      for (const c of customers) {
        const cj = jobsByCust[c.id] || []
        const completed = cj.filter(j => j.status === 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
        const upcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
        // Most RECENT recurring activity — find() returns arbitrary DB order and
        // can pick a dead 2024 series over the customer's current cadence.
        const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
        const lifetimeRevenue = completed.reduce((s, j) => s + jobValue(j), 0)
        const isVip = lifetimeRevenue >= VIP_THRESHOLD

        // "Comeback" history: a gap >= 90 days then another completed job = a
        // reactivation. Runs for EVERY customer with history — including recurring
        // ran-outs below — so the Recovered metric never drops their win-backs.
        let hadComeback = false
        for (let i = 1; i < completed.length; i++) {
          if (daysBetween(completed[i - 1].scheduled_date, completed[i].scheduled_date) >= 90) {
            hadComeback = true
            if (daysBetween(completed[i].scheduled_date, today) <= 365) revenueRecovered += jobValue(completed[i])
          }
        }
        if (hadComeback) reactivated++

        // SEASONAL DORMANCY: a recurring lawn/snow customer whose series ended
        // because the SEASON ended is not lost — they're dormant until next
        // season. Suppress them from every at-risk list while we're OUT of their
        // service season. They only resurface once their season has arrived again
        // and they STILL have no schedule (handled because `upcoming` is false and
        // isWithinSeason(today) becomes true, so this guard stops suppressing).
        const recService = recJob?.service_type ?? completed[completed.length - 1]?.service_type ?? null
        const recSeason = recJob ? seasonForService(recService, seasons) : null
        const seasonallyDormant = !!recSeason && !isWithinSeason(today, recSeason)
        if (recJob && !upcoming && seasonallyDormant) {
          continue // off-season — don't treat a naturally-ended seasonal series as lost
        }

        // RAN-OUT (urgent): a recurring customer with no future visit booked. Caught
        // here regardless of days-since, so it can't slip through the 90-day buckets.
        // Only customers who were actually visited (a non-cancelled, non-future
        // visit) — a series cancelled before any service isn't a re-book.
        if (recJob && !upcoming) {
          const pastReal = cj
            .filter(j => j.status !== 'cancelled' && j.scheduled_date <= today)
            .map(j => j.scheduled_date).sort()
          const lastDate = completed.length ? completed[completed.length - 1].scheduled_date
            : (pastReal.length ? pastReal[pastReal.length - 1] : null)
          if (lastDate) {
            const rec = recJob.recurrence_id ? recById[recJob.recurrence_id] : null
            const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
            // Urgent re-book ONLY while the series is plausibly still active —
            // past ~3 cadences they're a lapsed customer and age into the normal
            // buckets below instead of sitting in the red queue forever.
            const cadDays = rec?.interval_unit === 'day' ? Math.max(1, rec.interval_count ?? 1)
              : rec?.interval_unit === 'week' ? 7 * Math.max(1, rec.interval_count ?? 1)
              : rec?.interval_unit === 'month' ? 30 * Math.max(1, rec.interval_count ?? 1)
              : freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : freq === 'monthly' ? 30 : 14
            const daysSince = Math.max(0, daysBetween(lastDate, today))
            if (daysSince <= Math.max(21, cadDays * 3)) {
              // Per-visit at stake = the CURRENT quote cadence price (source of truth),
              // never an arbitrary visit's frozen historical override.
              const q = recJob.quote_id ? quotesById[recJob.quote_id] : null
              const perVisit = q
                ? Math.round(jobVisitValue(null, q as unknown as Record<string, unknown>, freq))
                : Math.round(jobValue(recJob))
              ranOuts.push({
                customer: c, lastServiceDate: lastDate, daysSince,
                cadence: freq || 'recurring', perVisit, lifetimeRevenue, isVip,
              })
              continue
            }
            // fall through: long-dead series → ordinary lapse buckets
          } else {
            continue // never actually serviced — not a re-book candidate
          }
        }

        if (completed.length === 0) continue // only customers with real service history
        const lastServiceDate = completed[completed.length - 1].scheduled_date
        const days = daysBetween(lastServiceDate, today)

        if (!upcoming && days >= 90) {
          // A DECLINED quote is not recoverable revenue — don't let a rejected
          // $4,000 hedge job inflate "Potential recovery".
          const cq = (quotesByCust[c.id] || []).filter(q => q.status !== 'declined').sort((a, b) => b.created_at.localeCompare(a.created_at))
          const lastQuoteAmount = cq.length ? Number(cq[0].total) || 0 : 0
          const avgValue = completed.length ? lifetimeRevenue / completed.length : 0
          risks.push({
            customer: c,
            lastServiceDate,
            daysSince: days,
            jobsCompleted: completed.length,
            lifetimeRevenue,
            lastQuoteAmount,
            lastServiceType: completed[completed.length - 1].service_type || cq[0]?.service_type || 'Lawn Mowing',
            potentialRecovery: lastQuoteAmount || Math.round(avgValue),
            bucket: days >= 365 ? '12+' : days >= 180 ? '6+' : '3+',
            isVip,
          })
        }
      }

      const order: Record<Bucket, number> = { '12+': 0, '6+': 1, '3+': 2 }
      // VIPs first within each bucket, then most-lapsed.
      risks.sort((a, b) => order[a.bucket] - order[b.bucket] || Number(b.isVip) - Number(a.isVip) || b.daysSince - a.daysSince)
      ranOuts.sort((a, b) => Number(b.isVip) - Number(a.isVip) || b.perVisit - a.perVisit || b.daysSince - a.daysSince)
      // Headline metrics include the urgent ran-out queue — 5 ran-dry recurring
      // customers with "At risk: 0" above them reads as a broken page.
      const potential = risks.reduce((s, r) => s + r.potentialRecovery, 0) + ranOuts.reduce((s, r) => s + r.perVisit, 0)
      const atRiskCount = risks.length + ranOuts.length
      const reactivationRate = (reactivated + atRiskCount) > 0 ? Math.round((reactivated / (reactivated + atRiskCount)) * 100) : 0

      setRisk(risks)
      setRanOut(ranOuts)
      setMetrics({ atRisk: atRiskCount, potential, reactivationRate, revenueRecovered })
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Finding lapsed customers…</div>

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Customer Reactivation" description="Win back customers you already paid to acquire" />

      {/* Headline metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Metric icon={AlertTriangle} label="At risk" value={String(metrics.atRisk)} tone="text-amber-400" />
        <Metric icon={DollarSign} label="Potential recovery" value={formatCurrency(metrics.potential)} tone="text-accent" />
        <Metric icon={Percent} label="Reactivation rate" value={`${metrics.reactivationRate}%`} />
        <Metric icon={TrendingUp} label="Recovered (1y)" value={formatCurrency(metrics.revenueRecovered)} tone="text-emerald-400" />
      </div>

      {/* Recurring series ran out — the urgent re-book queue (any days-since) */}
      {ranOut.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Repeat className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-bold text-red-400">Recurring series ran out</h2>
            <span className="text-xs text-ink-faint">No next visit booked · {ranOut.length} customer{ranOut.length !== 1 ? 's' : ''} · {formatCurrency(ranOut.reduce((s, r) => s + r.perVisit, 0))}/visit at stake</span>
          </div>
          {ranOut.map(r => <RanOutCard key={r.customer.id} r={r} />)}
        </div>
      )}

      {risk.length === 0 && ranOut.length === 0 ? (
        <Card><CardBody className="text-center py-12 text-sm text-ink-muted">
          <HeartPulse className="w-6 h-6 mx-auto mb-2 text-emerald-400" />
          No lapsed customers — everyone with service history is booked or recently served. Nice.
        </CardBody></Card>
      ) : BUCKETS.map(b => {
        const list = risk.filter(r => r.bucket === b.key)
        if (list.length === 0) return null
        return (
          <div key={b.key} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className={`text-sm font-bold ${b.tone}`}>{b.label}</h2>
              <span className="text-xs text-ink-faint">{b.sub} · {list.length} customer{list.length !== 1 ? 's' : ''} · {formatCurrency(list.reduce((s, r) => s + r.potentialRecovery, 0))} potential</span>
            </div>
            {list.map(r => <RiskCard key={r.customer.id} r={r} />)}
          </div>
        )
      })}
    </div>
  )
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof DollarSign; label: string; value: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <p className={`text-2xl font-bold tracking-tight mt-1 ${tone || 'text-ink'}`}>{value}</p>
    </Card>
  )
}

function RiskCard({ r }: { r: RiskCustomer }) {
  const c = r.customer
  const phone = c.phone || null
  const months = Math.floor(r.daysSince / 30)
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-bold text-ink hover:text-accent truncate">{c.name}</Link>
              {r.isVip && <VipChip />}
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              Last service {formatDate(r.lastServiceDate)} · <span className="text-amber-400 font-medium">{months}mo ({r.daysSince}d) ago</span>
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Potential</p>
            <p className="text-lg font-bold text-accent">{formatCurrency(r.potentialRecovery)}</p>
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
            className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${phone ? 'bg-accent/10 border-accent/20 text-accent hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
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
      <p className="text-[10px] uppercase tracking-wide text-ink-faint truncate">{label}</p>
      <p className="text-sm font-bold text-ink mt-0.5 truncate">{value}</p>
    </div>
  )
}

function VipChip() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300 border border-amber-400/40 bg-amber-400/10 rounded px-1.5 py-0.5 shrink-0">
      <Star className="w-3 h-3" /> VIP
    </span>
  )
}

function RanOutCard({ r }: { r: RanOutCustomer }) {
  const c = r.customer
  const phone = c.phone || null
  const cadence = r.cadence === 'weekly' ? 'Weekly' : r.cadence === 'biweekly' ? 'Bi-weekly' : r.cadence === 'monthly' ? 'Monthly' : 'Recurring'
  return (
    <Card className="border-red-500/20">
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-bold text-ink hover:text-accent truncate">{c.name}</Link>
              {r.isVip && <VipChip />}
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              <span className="text-red-400 font-medium">{cadence} customer · no next visit</span> · last served {formatDate(r.lastServiceDate)} ({r.daysSince}d ago)
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Per visit</p>
            <p className="text-lg font-bold text-accent">{r.perVisit > 0 ? formatCurrency(r.perVisit) : '—'}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link href={`/dashboard/schedule?customer=${c.id}`}
            className="h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
            <CalendarPlus className="w-4 h-4" /> Schedule next
          </Link>
          <a href={phone ? `tel:${phone}` : undefined} aria-disabled={!phone}
            className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-xs font-medium border transition-colors ${phone ? 'bg-accent/10 border-accent/20 text-accent hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}>
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
