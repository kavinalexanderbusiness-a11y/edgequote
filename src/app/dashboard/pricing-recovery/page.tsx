'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { jobVisitValue, quoteVisitAmount, effectiveFreq } from '@/lib/invoicing'
import { pricingConfigFromSettings, recommendedJobPrice, PricingConfig } from '@/lib/pricing'
import { generateQuoteNumber, formatCurrency, maxNumericSuffix, localTodayISO } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { Gauge, DollarSign, AlertTriangle, Repeat, Link2, FileText, Check, TrendingUp, Sparkles } from 'lucide-react'

interface JobRow {
  id: string; customer_id: string | null; property_id: string | null; quote_id: string | null
  recurrence_id: string | null; service_type: string | null; status: string; scheduled_date: string
  price: number | null; customerName: string; lawn_sqft: number | null; address: string | null
}
interface QuoteRow {
  id: string; quote_number: string; customer_id: string | null; property_id: string | null; service_type: string | null
  total: number | null; initial_price: number | null; weekly_price: number | null; biweekly_price: number | null
  monthly_price: number | null; measured_sqft: number | null
}
interface RecRow { freq: string | null; interval_unit: string | null; interval_count: number | null }

const DEFAULT_SQFT = 1500 // assume a medium lawn when nothing is measured

function cadenceField(freq: string | null): 'weekly_price' | 'biweekly_price' | 'monthly_price' | null {
  return freq === 'weekly' ? 'weekly_price' : freq === 'biweekly' ? 'biweekly_price' : freq === 'monthly' ? 'monthly_price' : null
}

interface Suggestion { price: number; source: string }

export default function PricingRecoveryPage() {
  const supabase = createClient()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [quotes, setQuotes] = useState<QuoteRow[]>([])
  const [recById, setRecById] = useState<Record<string, RecRow>>({})
  const [cfg, setCfg] = useState<PricingConfig>(pricingConfigFromSettings(null))
  const [edits, setEdits] = useState<Record<string, number>>({}) // per-series price overrides

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, qRes, rRes, sRes] = await Promise.all([
      supabase.from('jobs').select('id, customer_id, property_id, quote_id, recurrence_id, service_type, status, scheduled_date, price, customers(name), properties(lawn_sqft, address)').eq('user_id', user!.id),
      supabase.from('quotes').select('id, quote_number, customer_id, property_id, service_type, total, initial_price, weekly_price, biweekly_price, monthly_price, measured_sqft').eq('user_id', user!.id),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
      supabase.from('business_settings').select('*').eq('user_id', user!.id).maybeSingle(),
    ])
    const jr = ((jRes.data as unknown as Array<Omit<JobRow, 'customerName' | 'lawn_sqft' | 'address'> & { customers?: { name: string } | null; properties?: { lawn_sqft: number | null; address: string | null } | null }>) || [])
      .map(j => ({ ...j, customerName: j.customers?.name || 'Unknown', lawn_sqft: j.properties?.lawn_sqft ?? null, address: j.properties?.address ?? null } as JobRow))
    setJobs(jr)
    setQuotes((qRes.data as QuoteRow[]) || [])
    const rec: Record<string, RecRow> = {}
    for (const r of (rRes.data as (RecRow & { id: string })[]) || []) rec[r.id] = r
    setRecById(rec)
    setCfg(pricingConfigFromSettings(sRes.data as Parameters<typeof pricingConfigFromSettings>[0]))
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => {
    const quotesById: Record<string, QuoteRow> = {}
    for (const q of quotes) quotesById[q.id] = q
    const active = jobs.filter(j => j.status !== 'cancelled')

    const cadenceOf = (recId: string | null) => {
      const r = recId ? recById[recId] : null
      return r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
    }
    const valueOf = (j: JobRow) => jobVisitValue(j.price, quotesById[j.quote_id || ''] as unknown as Record<string, unknown>, cadenceOf(j.recurrence_id))

    // business average per-visit from already-priced jobs (a data-driven fallback)
    const pricedValues = active.map(valueOf).filter(v => v > 0)
    const businessAvg = pricedValues.length ? Math.round(pricedValues.reduce((a, b) => a + b, 0) / pricedValues.length / 5) * 5 : 0

    const sqftForProperty = (propertyId: string | null, lawn: number | null): number => {
      if (lawn && lawn > 0) return lawn
      const q = quotes.find(q => q.property_id && q.property_id === propertyId && q.measured_sqft && q.measured_sqft > 0)
      return q?.measured_sqft || 0
    }
    const customerPriced = (customerId: string | null): number => {
      if (!customerId) return 0
      const q = quotes.find(q => q.customer_id === customerId && (Number(q.weekly_price) || Number(q.biweekly_price) || Number(q.monthly_price) || Number(q.initial_price) || Number(q.total)))
      if (!q) return 0
      return Number(q.weekly_price) || Number(q.biweekly_price) || Number(q.monthly_price) || Number(q.initial_price) || Number(q.total) || 0
    }
    const suggest = (customerId: string | null, propertyId: string | null, lawn: number | null): Suggestion => {
      const sqft = sqftForProperty(propertyId, lawn)
      if (sqft > 0) return { price: recommendedJobPrice(sqft, cfg), source: `measured ${sqft.toLocaleString()} ft²` }
      const hist = customerPriced(customerId)
      if (hist > 0) return { price: hist, source: 'this customer’s pricing' }
      if (businessAvg > 0) return { price: businessAvg, source: 'your average visit' }
      return { price: recommendedJobPrice(DEFAULT_SQFT, cfg), source: 'typical lawn (set sqft to refine)' }
    }

    // group recurring series
    const seriesMap: Record<string, JobRow[]> = {}
    const oneTime: JobRow[] = []
    for (const j of active) {
      if (j.recurrence_id) (seriesMap[j.recurrence_id] ||= []).push(j)
      else oneTime.push(j)
    }

    const unpricedSeries: Array<{ recId: string; cadence: string | null; sample: JobRow; visits: number; suggestion: Suggestion }> = []
    const mispricedSeries: Array<{ recId: string; cadence: string | null; sample: JobRow; visits: number; quoteId: string; current: number; suggestion: Suggestion }> = []
    for (const [recId, list] of Object.entries(seriesMap)) {
      const sample = list[0]
      const cadence = cadenceOf(recId)
      const val = valueOf(sample)
      const hasManual = Number(sample.price) > 0
      const linkedQuote = list.map(j => j.quote_id).find(Boolean)
      const sug = suggest(sample.customer_id, sample.property_id, sample.lawn_sqft)
      if (val <= 0) {
        unpricedSeries.push({ recId, cadence, sample, visits: list.length, suggestion: sug })
      } else if (linkedQuote && !hasManual && cadence) {
        const q = quotesById[linkedQuote]
        const field = cadenceField(cadence)
        const hasRecurringPrice = field ? Number(q?.[field]) > 0 : false
        if (!hasRecurringPrice) {
          mispricedSeries.push({ recId, cadence, sample, visits: list.length, quoteId: linkedQuote, current: val, suggestion: sug })
        }
      }
    }

    // Underpriced: a PRICED recurring series whose per-visit price is materially
    // below what the measured lawn recommends — recurring money left on the table
    // every visit. Only when we have a real sqft basis (no false alarms).
    // `current` comes from the SOURCE OF TRUTH (quote cadence when linked, manual
    // job price otherwise) — never an arbitrary visit's override. Only series with
    // future visits count: the bump can't (and must not) re-price billed history.
    const underpricedSeries: Array<{ recId: string; cadence: string | null; sample: JobRow; visits: number; futureVisits: number; current: number; recommended: number; quoteId: string | null }> = []
    for (const [recId, list] of Object.entries(seriesMap)) {
      const sample = list[0]
      const cadence = cadenceOf(recId)
      const quoteId = (list.map(j => j.quote_id).find(Boolean) as string | undefined) || null
      const current = quoteId
        ? Math.round(quoteVisitAmount(quotesById[quoteId] as unknown as Record<string, unknown>, cadence))
        : Math.round(valueOf(sample))
      if (current <= 0) continue
      if (mispricedSeries.some(mp => mp.recId === recId)) continue // that section already handles it
      const futureVisits = list.filter(j => j.status !== 'completed').length
      if (futureVisits === 0) continue // fully billed — nothing left to raise
      const sqft = sqftForProperty(sample.property_id, sample.lawn_sqft)
      if (sqft <= 0) continue
      const recommended = recommendedJobPrice(sqft, cfg)
      if (recommended <= 0 || current >= recommended * 0.85) continue
      underpricedSeries.push({ recId, cadence, sample, visits: list.length, futureVisits, current, recommended, quoteId })
    }
    underpricedSeries.sort((a, b) => (b.recommended - b.current) * b.futureVisits - (a.recommended - a.current) * a.futureVisits)

    // one-time unpriced, grouped by customer
    const oneTimeUnpriced = oneTime.filter(j => valueOf(j) <= 0)
    const byCust: Record<string, JobRow[]> = {}
    for (const j of oneTimeUnpriced) (byCust[j.customer_id || 'none'] ||= []).push(j)
    const oneTimeGroups = Object.entries(byCust).map(([cid, list]) => {
      const match = quotes.find(q => q.customer_id === cid && (Number(q.initial_price) || Number(q.total)))
      return { customerId: cid === 'none' ? null : cid, sample: list[0], jobs: list, matchQuoteId: match?.id ?? null, matchValue: match ? (Number(match.initial_price) || Number(match.total)) : 0, suggestion: suggest(list[0].customer_id, list[0].property_id, list[0].lawn_sqft) }
    })

    // data quality score
    const total = active.length
    const priced = active.filter(j => valueOf(j) > 0).length
    const withQuote = active.filter(j => j.quote_id).length
    const recurringJobs = active.filter(j => j.recurrence_id)
    const recurringCovered = recurringJobs.filter(j => {
      const cad = cadenceOf(j.recurrence_id)
      const f = cadenceField(cad)
      const q = quotesById[j.quote_id || '']
      return f ? Number(q?.[f]) > 0 : false
    }).length

    const missingJobs = active.filter(j => valueOf(j) <= 0)
    const missingRevenue = missingJobs.reduce((s, j) => s + suggest(j.customer_id, j.property_id, j.lawn_sqft).price, 0)

    return {
      score: total ? Math.round((priced / total) * 100) : 100,
      priced, unpriced: total - priced, total,
      quotesLinkedPct: total ? Math.round((withQuote / total) * 100) : 0,
      recurringCoveragePct: recurringJobs.length ? Math.round((recurringCovered / recurringJobs.length) * 100) : 100,
      missingRevenue: Math.round(missingRevenue),
      upside: underpricedSeries.reduce((s, u) => s + (u.recommended - u.current) * u.futureVisits, 0),
      unpricedSeries, mispricedSeries, underpricedSeries, oneTimeGroups, businessAvg,
    }
  }, [jobs, quotes, recById, cfg])

  function priceFor(key: string, fallback: number) { return edits[key] ?? fallback }

  // Create an accepted quote with the cadence price + link the whole series.
  async function applyNewPrice(recId: string, sample: JobRow, cadence: string | null, price: number) {
    setWorking(recId)
    const { data: { user } } = await supabase.auth.getUser()
    // Max-suffix, never count — counts reissue numbers after deletes.
    const quote_number = generateQuoteNumber(maxNumericSuffix(quotes.map(q => q.quote_number)) + 1)
    const field = cadenceField(cadence)
    const insert: Record<string, unknown> = {
      user_id: user!.id, quote_number,
      customer_id: sample.customer_id, customer_name: sample.customerName,
      address: sample.address || '', service_type: sample.service_type || 'Lawn Mowing',
      property_id: sample.property_id, initial_price: price, status: 'accepted',
      custom_travel_required: false, show_travel_separately: false,
      issued_date: localTodayISO(),
    }
    if (field) insert[field] = price
    const { data: q, error } = await supabase.from('quotes').insert(insert).select('id').single()
    if (error || !q) { setWorking(null); alert('Could not create quote: ' + (error?.message ?? '')); return }
    const ids = jobs.filter(j => j.recurrence_id === recId).map(j => j.id)
    await supabase.from('jobs').update({ quote_id: q.id }).in('id', ids)
    await load(); setWorking(null)
  }

  // Add the missing recurring price onto an existing linked quote.
  async function setRecurringPrice(recId: string, quoteId: string, cadence: string | null, price: number) {
    setWorking(recId)
    const field = cadenceField(cadence)
    if (!field) { setWorking(null); return }
    const patch: Record<string, unknown> = { [field]: price }
    const q = quotes.find(x => x.id === quoteId)
    if (q && !(Number(q.initial_price) > 0)) patch.initial_price = price
    await supabase.from('quotes').update(patch).eq('id', quoteId)
    await load(); setWorking(null)
  }

  // Raise an underpriced series to the recommended price. Writes to the quote
  // cadence price (single source of truth) when linked; clears future overrides so
  // they derive the bump. Completed/billed visits that DERIVE the quote are frozen
  // first at the quote's OLD cadence value (their true billed amount — mirrors the
  // schedule's price engine), so raising the quote never rewrites billed history.
  async function bumpUnderpriced(s: { recId: string; cadence: string | null; current: number; quoteId: string | null }, price: number) {
    setWorking(s.recId)
    const series = jobs.filter(j => j.recurrence_id === s.recId)
    const nonCompleted = series.filter(j => j.status !== 'completed').map(j => j.id)
    const field = cadenceField(s.cadence)
    if (s.quoteId && field) {
      const q = quotes.find(x => x.id === s.quoteId)
      const freezeVal = Math.round(quoteVisitAmount(q as unknown as Record<string, unknown>, s.cadence))
      const completedNull = series.filter(j => j.status === 'completed' && j.price == null).map(j => j.id)
      if (completedNull.length && freezeVal > 0) await supabase.from('jobs').update({ price: freezeVal }).in('id', completedNull)
      await supabase.from('quotes').update({ [field]: price }).eq('id', s.quoteId)
      if (nonCompleted.length) await supabase.from('jobs').update({ price: null }).in('id', nonCompleted)
    } else if (nonCompleted.length) {
      // No quote owns this series — the price lives on the future visits themselves.
      await supabase.from('jobs').update({ price }).in('id', nonCompleted)
    }
    await load(); setWorking(null)
  }

  // Link a customer's one-time unpriced jobs to an existing priced quote.
  async function linkJobs(key: string, jobIds: string[], quoteId: string) {
    setWorking(key)
    await supabase.from('jobs').update({ quote_id: quoteId }).in('id', jobIds)
    await load(); setWorking(null)
  }

  if (loading) return <PageSkeleton tiles={4} rows={3} className="max-w-4xl" />

  const m = model
  const scoreTone = m.score >= 90 ? 'text-emerald-400' : m.score >= 60 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Pricing Recovery" description="Find unpriced work so reports and growth features run on real revenue" />

      {/* Data Quality Score */}
      <Card>
        <CardBody className="flex items-center gap-5">
          <div className="text-center shrink-0">
            <Gauge className={`w-6 h-6 mx-auto ${scoreTone}`} />
            <p className={`text-4xl font-black tracking-tight ${scoreTone}`}>{m.score}%</p>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Data quality</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
            <StatTile label="Jobs priced" value={`${m.priced}/${m.total}`} tone="success" />
            <StatTile label="Unpriced" value={String(m.unpriced)} tone={m.unpriced ? 'danger' : undefined} />
            <StatTile label="Quotes linked" value={`${m.quotesLinkedPct}%`} />
            <StatTile label="Recurring covered" value={`${m.recurringCoveragePct}%`} tone={m.recurringCoveragePct < 100 ? 'warn' : 'success'} />
          </div>
        </CardBody>
      </Card>

      {/* Missing revenue */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile icon={DollarSign} tone="accent" label="Revenue missing from reports" value={formatCurrency(m.missingRevenue)} sub="booked value of all unpriced visits (estimated)" />
        <StatTile icon={TrendingUp} tone="success" label="Items to fix" value={`${m.unpricedSeries.length + m.mispricedSeries.length + m.underpricedSeries.length + m.oneTimeGroups.length}`} sub={m.upside > 0 ? `incl. +${formatCurrency(m.upside)} from raising underpriced series` : 'apply the suggestions below to recover it'} />
      </div>

      {m.score === 100 && m.mispricedSeries.length === 0 && m.underpricedSeries.length === 0 ? (
        <EmptyState icon={Check} title="Every job is priced"
          description="Reports and growth dashboards are running on real revenue." />
      ) : null}

      {/* Unpriced recurring series — highest leverage */}
      {m.unpricedSeries.length > 0 && (
        <Section title="Unpriced recurring series" sub={`${m.unpricedSeries.length} series with no price — one click prices every visit`} icon={Repeat}>
          {m.unpricedSeries.map(s => {
            const key = `new-${s.recId}`
            const price = priceFor(key, s.suggestion.price)
            return (
              <RecoveryRow key={s.recId}
                title={s.sample.customerName} sub={`${cadenceLabel(s.cadence)} · ${s.visits} visits · ${s.sample.address || s.sample.service_type || ''}`}
                source={s.suggestion.source} price={price} onPrice={v => setEdits(e => ({ ...e, [key]: v }))}
                missing={formatCurrency(price * s.visits)}
                primary={{ label: `Price ${s.visits} visits at ${formatCurrency(price)}`, loading: working === s.recId, onClick: () => applyNewPrice(s.recId, s.sample, s.cadence, price), icon: Sparkles }}
                secondary={s.sample.customer_id ? { label: 'Build full quote', onClick: () => router.push(`/dashboard/quotes/new?customer=${s.sample.customer_id}`), icon: FileText } : undefined}
              />
            )
          })}
        </Section>
      )}

      {/* Recurring with a quote but no recurring price */}
      {m.mispricedSeries.length > 0 && (
        <Section title="Recurring without recurring pricing" sub={`${m.mispricedSeries.length} series billing each visit at the first-visit price`} icon={AlertTriangle}>
          {m.mispricedSeries.map(s => {
            const key = `fix-${s.recId}`
            const price = priceFor(key, s.suggestion.price)
            return (
              <RecoveryRow key={s.recId}
                title={s.sample.customerName} sub={`${cadenceLabel(s.cadence)} · ${s.visits} visits · currently ${formatCurrency(s.current)}/visit (first-visit price)`}
                source={s.suggestion.source} price={price} onPrice={v => setEdits(e => ({ ...e, [key]: v }))}
                missing={`${formatCurrency((price - s.current) * s.visits)} delta`}
                primary={{ label: `Set ${cadenceLabel(s.cadence).toLowerCase()} price ${formatCurrency(price)}`, loading: working === s.recId, onClick: () => setRecurringPrice(s.recId, s.quoteId, s.cadence, price), icon: Check }}
              />
            )
          })}
        </Section>
      )}

      {/* Priced below the measured-lawn recommendation — recurring upside */}
      {m.underpricedSeries.length > 0 && (
        <Section title="Priced below recommended" sub={`${m.underpricedSeries.length} series under the measured-lawn rate · +${formatCurrency(m.upside)} upside`} icon={TrendingUp}>
          {m.underpricedSeries.map(s => {
            const key = `up-${s.recId}`
            const price = priceFor(key, s.recommended)
            return (
              <RecoveryRow key={s.recId}
                title={s.sample.customerName} sub={`${cadenceLabel(s.cadence)} · ${s.futureVisits} upcoming visit${s.futureVisits !== 1 ? 's' : ''} · now ${formatCurrency(s.current)}/visit`}
                source={`measured lawn → recommended ${formatCurrency(s.recommended)}/visit`}
                price={price} onPrice={v => setEdits(e => ({ ...e, [key]: v }))}
                missing={`+${formatCurrency(Math.max(0, price - s.current) * s.futureVisits)}`}
                primary={{ label: `Raise to ${formatCurrency(price)}/visit`, loading: working === s.recId, onClick: () => bumpUnderpriced(s, price), icon: TrendingUp }}
              />
            )
          })}
        </Section>
      )}

      {/* One-time unpriced jobs */}
      {m.oneTimeGroups.length > 0 && (
        <Section title="Unpriced one-off jobs" sub={`${m.oneTimeGroups.reduce((s, g) => s + g.jobs.length, 0)} jobs with no price`} icon={DollarSign}>
          {m.oneTimeGroups.map(g => {
            const key = `ot-${g.customerId ?? 'none'}`
            return (
              <RecoveryRow key={key}
                title={g.sample.customerName} sub={`${g.jobs.length} job${g.jobs.length !== 1 ? 's' : ''} · ${g.sample.service_type || ''}`}
                source={g.matchQuoteId ? 'existing quote match' : g.suggestion.source}
                price={g.matchQuoteId ? g.matchValue : g.suggestion.price} onPrice={undefined}
                missing={formatCurrency((g.matchQuoteId ? g.matchValue : g.suggestion.price) * g.jobs.length)}
                primary={g.matchQuoteId
                  ? { label: `Link ${g.jobs.length} job${g.jobs.length !== 1 ? 's' : ''} to matched quote`, loading: working === key, onClick: () => linkJobs(key, g.jobs.map(j => j.id), g.matchQuoteId as string), icon: Link2 }
                  : { label: 'Create quote', loading: false, onClick: () => router.push(`/dashboard/quotes/new?customer=${g.customerId ?? ''}`), icon: FileText }}
              />
            )
          })}
        </Section>
      )}
    </div>
  )
}

function cadenceLabel(freq: string | null) {
  return freq === 'weekly' ? 'Weekly' : freq === 'biweekly' ? 'Bi-weekly' : freq === 'monthly' ? 'Monthly' : 'Recurring'
}

function Section({ title, sub, icon: Icon, children }: { title: string; sub: string; icon: typeof Repeat; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <SectionHeading icon={Icon} title={title} sub={sub} className="mb-0" />
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function RecoveryRow({ title, sub, source, price, onPrice, missing, primary, secondary }: {
  title: string; sub: string; source: string; price: number; onPrice?: (v: number) => void; missing: string
  primary: { label: string; loading: boolean; onClick: () => void; icon: typeof Check }
  secondary?: { label: string; onClick: () => void; icon: typeof FileText }
}) {
  const PIcon = primary.icon
  return (
    <Card>
      <CardBody className="space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink truncate">{title}</p>
            <p className="text-xs text-ink-muted mt-0.5 truncate">{sub}</p>
            <p className="text-[11px] text-ink-faint mt-0.5 flex items-center gap-1"><Sparkles className="w-3 h-3 text-accent" /> Suggested from {source}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">At risk</p>
            <p className="text-base font-bold text-amber-400">{missing}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {onPrice && (
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">$/visit
              <input type="number" min="0" step="5" value={price} onChange={e => onPrice(Number(e.target.value) || 0)}
                className="w-20 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
            </label>
          )}
          <Button size="sm" loading={primary.loading} onClick={primary.onClick}><PIcon className="w-3.5 h-3.5" /> {primary.label}</Button>
          {secondary && <Button size="sm" variant="secondary" onClick={secondary.onClick}><secondary.icon className="w-3.5 h-3.5" /> {secondary.label}</Button>}
        </div>
      </CardBody>
    </Card>
  )
}

