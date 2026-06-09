'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Customer } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, jobValue,
} from '@/lib/profitability'
import { ensureCustomerAndProperty, findCustomerMatch } from '@/lib/customers'
import {
  CoverageRow, coveragePct, overallScore, scoreGrade, scoreLabel, DQ_GRADE_COLORS,
} from '@/lib/dataQuality'
import {
  ShieldCheck, UserPlus, Home, AlertTriangle, CheckCircle2, ArrowRight, DollarSign, Link2, Users, FileText,
} from 'lucide-react'

interface QRow {
  id: string; quote_number: string; customer_id: string | null; customer_name: string
  address: string; property_id: string | null; status: string
}
type DQJob = ProfitJob & { title: string; property_id: string | null }
interface PRow { id: string; customer_id: string | null; address: string }

const EMPTY_CTX: ProfitContext = { quotesById: {}, recById: {}, base: null, today: format(new Date(), 'yyyy-MM-dd') }

export default function DataQualityPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [quotes, setQuotes] = useState<QRow[]>([])
  const [jobs, setJobs] = useState<DQJob[]>([])
  const [properties, setProperties] = useState<PRow[]>([])
  const [ctx, setCtx] = useState<ProfitContext>(EMPTY_CTX)

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const [cRes, qRes, jRes, rRes, pRes] = await Promise.all([
      supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
      supabase.from('quotes').select('id, quote_number, customer_id, customer_name, address, property_id, status, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('jobs').select('id, title, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, property_id, properties(lat, lng, city, postal_code)').eq('user_id', user!.id),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
      supabase.from('properties').select('id, customer_id, address').eq('user_id', user!.id),
    ])

    setCustomers((cRes.data as Customer[]) || [])

    const qRows = ((qRes.data as Array<Record<string, any>>) || [])
    setQuotes(qRows.map(q => ({ id: q.id, quote_number: q.quote_number, customer_id: q.customer_id, customer_name: q.customer_name, address: q.address, property_id: q.property_id, status: q.status })))

    const quotesById: Record<string, ProfitQuote> = {}
    for (const q of qRows) quotesById[q.id] = { total: q.total, initial_price: q.initial_price, weekly_price: q.weekly_price, biweekly_price: q.biweekly_price, monthly_price: q.monthly_price }
    const recById: Record<string, RecInfo> = {}
    for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    setCtx({ quotesById, recById, base: null, today: format(new Date(), 'yyyy-MM-dd') })

    setJobs(((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
      id: j.id, title: j.title, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
      actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id, property_id: j.property_id,
      lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
      city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
    })))
    setProperties((pRes.data as PRow[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  // ── Counts + coverage ──
  const m = useMemo(() => {
    const activeJobs = jobs.filter(j => j.status !== 'cancelled')
    const jobsWithValue = activeJobs.filter(j => jobValue(j, ctx) > 0).length
    const quotesNoCustomer = quotes.filter(q => !q.customer_id)
    const quotesNoProperty = quotes.filter(q => q.customer_id && !q.property_id)
    const jobsNoCustomer = jobs.filter(j => !j.customer_id)
    const jobsNoQuote = jobs.filter(j => !j.quote_id).length
    const jobsNoPrice = jobs.filter(j => j.price == null).length
    const propsNoCustomer = properties.filter(p => !p.customer_id).length

    const totalLinkables = quotes.length + jobs.length
    const custCovered = (quotes.length - quotesNoCustomer.length) + (jobs.length - jobsNoCustomer.length)
    const propCovered = (quotes.length - quotes.filter(q => !q.property_id).length) + (jobs.length - jobs.filter(j => !j.property_id).length)

    const rows: CoverageRow[] = [
      { key: 'customer', label: 'Customer coverage', covered: custCovered, total: totalLinkables, pct: coveragePct(custCovered, totalLinkables), hint: 'Quotes & jobs linked to a real customer' },
      { key: 'property', label: 'Property coverage', covered: propCovered, total: totalLinkables, pct: coveragePct(propCovered, totalLinkables), hint: 'Quotes & jobs linked to a property' },
      { key: 'quote', label: 'Job → quote linkage', covered: jobs.length - jobsNoQuote, total: jobs.length, pct: coveragePct(jobs.length - jobsNoQuote, jobs.length), hint: 'Jobs tied to a quote for pricing' },
      { key: 'revenue', label: 'Revenue coverage', covered: jobsWithValue, total: activeJobs.length, pct: coveragePct(jobsWithValue, activeJobs.length), hint: 'Active jobs that produce a $ value' },
    ]
    return {
      rows, score: overallScore(rows),
      quotesNoCustomer, quotesNoProperty, jobsNoCustomer,
      jobsNoQuote, jobsNoPrice, propsNoCustomer,
      activeJobs: activeJobs.length, jobsWithValue,
      propertiesTotal: properties.length,
    }
  }, [quotes, jobs, properties, ctx])

  const grade = scoreGrade(m.score)

  // ── Recovery actions (all through the shared engine) ──
  async function fixQuoteCustomer(q: QRow, mode: 'link' | 'new', linkId?: string) {
    setWorking(q.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const ensured = await ensureCustomerAndProperty(
        supabase, user!.id,
        { customerId: mode === 'link' ? linkId : null, name: q.customer_name, address: q.address },
        mode === 'new' ? [] : customers, // empty list forces a fresh customer
      )
      await supabase.from('quotes').update({ customer_id: ensured.customerId, property_id: ensured.propertyId }).eq('id', q.id)
      await load()
    } catch (e) { alert('Could not fix quote: ' + (e instanceof Error ? e.message : 'error')) }
    finally { setWorking(null) }
  }

  async function fixQuoteProperty(q: QRow) {
    if (!q.customer_id) return
    setWorking(q.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const ensured = await ensureCustomerAndProperty(
        supabase, user!.id, { customerId: q.customer_id, name: q.customer_name, address: q.address }, customers,
      )
      await supabase.from('quotes').update({ property_id: ensured.propertyId }).eq('id', q.id)
      await load()
    } catch (e) { alert('Could not link property: ' + (e instanceof Error ? e.message : 'error')) }
    finally { setWorking(null) }
  }

  async function fixAllProperties() {
    setWorking('all-props')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      for (const q of m.quotesNoProperty) {
        const ensured = await ensureCustomerAndProperty(
          supabase, user!.id, { customerId: q.customer_id, name: q.customer_name, address: q.address }, customers,
        )
        await supabase.from('quotes').update({ property_id: ensured.propertyId }).eq('id', q.id)
      }
      await load()
    } catch (e) { alert('Could not link properties: ' + (e instanceof Error ? e.message : 'error')) }
    finally { setWorking(null) }
  }

  async function repairJobCustomer(j: DQJob) {
    setWorking(j.id)
    try {
      let custId: string | null = null
      let propId: string | null = j.property_id
      if (j.property_id) custId = properties.find(p => p.id === j.property_id)?.customer_id ?? null
      if (!custId && j.quote_id) {
        const q = quotes.find(x => x.id === j.quote_id)
        custId = q?.customer_id ?? null
        propId = propId ?? q?.property_id ?? null
      }
      if (custId) {
        await supabase.from('jobs').update({ customer_id: custId, property_id: propId }).eq('id', j.id)
        await load()
      } else {
        alert('This job has no property or quote to derive a customer from — open it on the Schedule and assign one.')
      }
    } finally { setWorking(null) }
  }

  if (loading) return <div className="text-center py-16 text-sm text-ink-muted">Checking data quality…</div>

  const allClean = m.quotesNoCustomer.length === 0 && m.quotesNoProperty.length === 0 && m.jobsNoCustomer.length === 0 && m.jobsNoPrice === 0 && m.jobsNoQuote === 0

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Data Quality" description="Make the data clean and trustworthy before growth features rely on it" />

      {/* Score hero */}
      <Card>
        <CardBody className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black shrink-0"
            style={{ backgroundColor: DQ_GRADE_COLORS[grade] + '22', color: DQ_GRADE_COLORS[grade], border: `1px solid ${DQ_GRADE_COLORS[grade]}55` }}>
            {m.score}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" style={{ color: DQ_GRADE_COLORS[grade] }} /> Data health: {scoreLabel(m.score)}
            </p>
            <p className="text-xs text-ink-muted mt-0.5">
              Score is the average of the coverage dimensions below. Fix the gaps to raise it toward 100.
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Coverage bars */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {m.rows.map(r => <CoverageCard key={r.key} row={r} />)}
      </div>

      {allClean && (
        <Card>
          <CardBody className="flex items-center gap-3 text-sm text-emerald-400">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            Everything is linked and priced. Your data is clean — Saturation Map &amp; Neighbor Leads can trust it.
          </CardBody>
        </Card>
      )}

      {/* Quotes missing a customer — manual review (identity matters) */}
      {m.quotesNoCustomer.length > 0 && (
        <Section icon={UserPlus} title={`${m.quotesNoCustomer.length} quote${m.quotesNoCustomer.length !== 1 ? 's' : ''} with no customer`}
          subtitle="Each quote needs a real customer. Link to an existing one if it's the same person, or create a new record.">
          {m.quotesNoCustomer.map(q => {
            const match = findCustomerMatch(customers, { name: q.customer_name, address: q.address })
            const busy = working === q.id
            return (
              <div key={q.id} className="rounded-xl border border-border p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{q.customer_name || 'Unnamed'} <span className="text-ink-faint font-normal">· {q.quote_number}</span></p>
                    <p className="text-xs text-ink-muted truncate">{q.address || 'No address'}</p>
                  </div>
                </div>
                {match ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('text-[11px] px-2 py-0.5 rounded-full border', match.confident ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
                      {match.confident ? `Matches ${match.customer.name} by ${match.reason}` : `Possible match: ${match.customer.name}`}
                    </span>
                    <Button size="sm" loading={busy} onClick={() => fixQuoteCustomer(q, 'link', match.customer.id)}>
                      <Link2 className="w-3.5 h-3.5" /> Link to {match.customer.name.split(' ')[0]}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => fixQuoteCustomer(q, 'new')}>
                      Create new
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" loading={busy} onClick={() => fixQuoteCustomer(q, 'new')}>
                    <UserPlus className="w-3.5 h-3.5" /> Create customer &amp; property
                  </Button>
                )}
              </div>
            )
          })}
        </Section>
      )}

      {/* Quotes missing a property — safe bulk backfill (customer already exists) */}
      {m.quotesNoProperty.length > 0 && (
        <Section icon={Home} title={`${m.quotesNoProperty.length} quote${m.quotesNoProperty.length !== 1 ? 's' : ''} with no property`}
          subtitle="These have a customer but no property record — needed for the map, routes and saturation."
          action={
            <Button size="sm" loading={working === 'all-props'} onClick={fixAllProperties}>
              <Home className="w-3.5 h-3.5" /> Link all {m.quotesNoProperty.length}
            </Button>
          }>
          {m.quotesNoProperty.map(q => (
            <div key={q.id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink truncate">{q.customer_name} <span className="text-ink-faint font-normal">· {q.quote_number}</span></p>
                <p className="text-xs text-ink-muted truncate">{q.address || 'No address'}</p>
              </div>
              <Button size="sm" variant="secondary" loading={working === q.id} onClick={() => fixQuoteProperty(q)}>
                <Home className="w-3.5 h-3.5" /> Link
              </Button>
            </div>
          ))}
        </Section>
      )}

      {/* Jobs missing a customer — derive from property/quote */}
      {m.jobsNoCustomer.length > 0 && (
        <Section icon={Users} title={`${m.jobsNoCustomer.length} job${m.jobsNoCustomer.length !== 1 ? 's' : ''} with no customer`}
          subtitle="Backfill each job's customer from its property or linked quote.">
          {m.jobsNoCustomer.slice(0, 40).map(j => (
            <div key={j.id} className="flex items-center justify-between gap-2 rounded-xl border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink truncate">{j.title}</p>
                <p className="text-xs text-ink-muted">{j.scheduled_date}</p>
              </div>
              <Button size="sm" variant="secondary" loading={working === j.id} onClick={() => repairJobCustomer(j)}>
                Repair
              </Button>
            </div>
          ))}
        </Section>
      )}

      {/* Pricing & quote gaps — delegated to the dedicated Pricing Recovery tool (no duplicate fixer) */}
      {(m.jobsNoPrice > 0 || m.jobsNoQuote > 0) && (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-ink">Pricing &amp; quote gaps</h2>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Jobs missing a price" value={m.jobsNoPrice} total={jobs.length} />
              <Stat label="Jobs missing a quote" value={m.jobsNoQuote} total={jobs.length} />
            </div>
            <p className="text-xs text-ink-muted">
              These are fixed in the dedicated tool — link jobs to quotes, set recurring prices, and create missing quotes in one click.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/dashboard/pricing-recovery">
                <Button size="sm"><DollarSign className="w-3.5 h-3.5" /> Open Pricing Recovery <ArrowRight className="w-3.5 h-3.5" /></Button>
              </Link>
              <Link href="/dashboard/schedule">
                <Button size="sm" variant="secondary"><FileText className="w-3.5 h-3.5" /> Set prices on Schedule</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Properties → customer (structural, FK-enforced) */}
      <Card>
        <CardBody className="flex items-center gap-3 text-sm">
          {m.propsNoCustomer === 0 ? (
            <><CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /><span className="text-ink-muted">All {m.propertiesTotal} propert{m.propertiesTotal !== 1 ? 'ies are' : 'y is'} linked to a customer.</span></>
          ) : (
            <><AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" /><span className="text-ink-muted">{m.propsNoCustomer} propert{m.propsNoCustomer !== 1 ? 'ies have' : 'y has'} no customer.</span></>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function CoverageCard({ row }: { row: CoverageRow }) {
  const color = row.pct >= 95 ? '#10B981' : row.pct >= 70 ? '#F59E0B' : '#EF4444'
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{row.label}</p>
        <p className="text-sm font-bold" style={{ color }}>{row.pct}%</p>
      </div>
      <div className="h-1.5 rounded-full bg-bg-tertiary mt-2 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${row.pct}%`, background: color }} />
      </div>
      <p className="text-[11px] text-ink-faint mt-1.5">{row.covered}/{row.total} · {row.hint}</p>
    </Card>
  )
}

function Section({ icon: Icon, title, subtitle, action, children }: {
  icon: typeof UserPlus; title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <Icon className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
      <CardBody className="space-y-2">{children}</CardBody>
    </Card>
  )
}

function Stat({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-lg font-bold text-ink mt-0.5">{value}<span className="text-xs font-normal text-ink-faint"> / {total}</span></p>
    </div>
  )
}
