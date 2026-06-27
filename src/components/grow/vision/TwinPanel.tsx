import {
  Brain, TrendingUp, TrendingDown, CalendarClock, Sparkles, Leaf, Megaphone, UserPlus, Minus, ArrowRight,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { cn, formatCurrency } from '@/lib/utils'
import { toneSoft, toneText, type Tone } from '@/lib/tone'
import { SEASON_LABELS } from '@/lib/vision/season'
import { FORECAST_TONE, shortDate } from '@/lib/vision/labels'
import { Pill } from './ui'
import type {
  ChangeSummary, CrmBlock, ForecastBlock, MarketingSummary, OpportunityBlock, OppTier, PropertyTwin, SeasonalBlock,
} from '@/lib/vision/types'

// ── AI Vision — the digital-twin panel ────────────────────────────────────────
// The longitudinal brain: accumulated memory + change vs last visit + seasonal
// recs + maintenance forecast + ranked opportunities + marketing/CRM signals.
// Read-only; recommendations only.

const TIER_TONE: Record<OppTier, Tone> = { high: 'success', medium: 'warn', low: 'neutral' }

function daysUntil(iso: string): number {
  return Math.round((new Date(iso + 'T00:00:00').getTime() - Date.now()) / 86_400_000)
}
function horizonLabel(iso: string): string {
  const d = daysUntil(iso)
  if (d <= 0) return 'due now'
  if (d < 14) return `in ~${d} days`
  if (d < 60) return `in ~${Math.round(d / 7)} weeks`
  return `in ~${Math.round(d / 30)} months`
}

export function TwinPanel({ twin }: { twin: PropertyTwin }) {
  const change = 'narrative' in twin.change_summary ? (twin.change_summary as ChangeSummary) : null
  const seasonal = 'season' in twin.seasonal ? (twin.seasonal as SeasonalBlock) : null
  const forecast = 'items' in twin.forecast ? (twin.forecast as ForecastBlock) : null
  const opps = 'items' in twin.opportunities ? (twin.opportunities as OpportunityBlock) : null
  const marketing = 'highlights' in twin.marketing ? (twin.marketing as MarketingSummary) : null
  const crm = 'never_purchased' in twin.crm ? (twin.crm as CrmBlock) : null

  return (
    <div className="space-y-5">
      {/* Digest — the living state of this property */}
      <Card className="p-4 border-accent/30 bg-gradient-to-br from-accent/[0.06] to-transparent">
        <SectionHeading icon={Brain} title="Property memory" sub={`${twin.analysis_count} analysis${twin.analysis_count === 1 ? '' : 'es'} on file · updated ${shortDate(twin.last_analyzed_at || twin.updated_at)}`} />
        {twin.digest && <p className="text-sm text-ink-muted leading-relaxed">{twin.digest}</p>}
        <MemoryChips twin={twin} />
      </Card>

      {/* Change since last visit */}
      {change && (
        <div>
          <SectionHeading icon={TrendingUp} title="Change detection" sub={change.is_first ? 'Baseline' : change.since ? `vs ${shortDate(change.since)}` : undefined} />
          {change.narrative && <p className="text-sm text-ink-muted mb-2">{change.narrative}</p>}
          {change.signals.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {change.signals.map((s, i) => {
                const good = s.direction === 'better' || s.direction === 'down'
                const Icon = good ? TrendingUp : s.direction === 'new' ? Sparkles : TrendingDown
                const tone: Tone = good ? 'success' : s.direction === 'new' ? 'info' : 'danger'
                return (
                  <span key={i} className={cn('inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border', toneSoft[tone])} title={s.detail}>
                    <Icon className="w-3 h-3" />{s.label}
                  </span>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-ink-faint">No notable change — holding steady.</p>
          )}
        </div>
      )}

      {/* Opportunities — ranked by value */}
      {opps && opps.items.length > 0 && (
        <div>
          <SectionHeading icon={Sparkles} title="Opportunities" sub="Ranked by expected value — recommendations only" />
          <div className="space-y-2">
            {opps.items.map((o, i) => (
              <Card key={`${o.key}-${i}`} className="p-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 text-xs font-bold text-accent">{i + 1}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink flex items-center gap-2 flex-wrap">
                    {o.label}
                    <Pill tone={TIER_TONE[o.tier]} className="uppercase tracking-wide">{o.tier}</Pill>
                    {o.never_purchased && <Pill tone="info" className="font-medium">Never bought</Pill>}
                  </p>
                  <p className="text-xs text-ink-muted mt-0.5">{o.reason}</p>
                </div>
                <div className="shrink-0 text-right">
                  {o.expected_value != null && <p className="text-sm font-bold text-ink">{formatCurrency(o.expected_value)}</p>}
                  <p className="text-[10px] text-ink-faint">score {o.score}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Maintenance forecast */}
      {forecast && forecast.items.length > 0 && (
        <div>
          <SectionHeading icon={CalendarClock} title="Maintenance forecast" sub="When each need is likely due next" />
          <div className="rounded-card border border-border bg-surface divide-y divide-border">
            {forecast.items.map((f, i) => (
              <div key={`${f.key}-${i}`} className="px-3.5 py-2.5 flex items-center gap-3">
                <CalendarClock className="w-4 h-4 text-ink-faint shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{f.label}</p>
                  <p className="text-[11px] text-ink-faint">{f.basis}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs font-semibold text-ink">{f.predicted_for}</p>
                  <p className={cn('text-[10px]', toneText[FORECAST_TONE[f.confidence]])}>{horizonLabel(f.predicted_for)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Seasonal */}
      {seasonal && seasonal.recommendations.length > 0 && (
        <div>
          <SectionHeading icon={Leaf} title={`${SEASON_LABELS[seasonal.season]} priorities`} sub="Season-appropriate recommendations" />
          <div className="grid sm:grid-cols-2 gap-2">
            {seasonal.recommendations.map((r, i) => (
              <Card key={`${r.key}-${i}`} className="p-3">
                <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Leaf className="w-3.5 h-3.5 text-emerald-400" />{r.label}</p>
                <p className="text-xs text-ink-muted mt-0.5">{r.why}</p>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Reusable signals for Marketing + CRM */}
      <div className="grid sm:grid-cols-2 gap-3">
        {marketing && marketing.highlights.length > 0 && (
          <Card className="p-3.5">
            <SectionHeading icon={Megaphone} title="Marketing angles" className="mb-2" />
            <ul className="space-y-1">
              {marketing.highlights.map((h, i) => (
                <li key={i} className="text-xs text-ink-muted flex items-center gap-1.5"><ArrowRight className="w-3 h-3 text-accent shrink-0" />{h}</li>
              ))}
            </ul>
            <p className="text-[10px] text-ink-faint mt-2">Marketing Studio reads these without re-analyzing photos.</p>
          </Card>
        )}
        {crm && crm.recommendations.length > 0 && (
          <Card className="p-3.5">
            <SectionHeading icon={UserPlus} title="Never purchased" className="mb-2" />
            <ul className="space-y-1">
              {crm.recommendations.map((r, i) => (
                <li key={i} className="text-xs text-ink-muted flex items-center gap-1.5"><ArrowRight className="w-3 h-3 text-blue-400 shrink-0" /><span className="font-medium text-ink">{r.label}</span> — {r.why}</li>
              ))}
            </ul>
            <p className="text-[10px] text-ink-faint mt-2">Surfaced for CRM — recommendations only.</p>
          </Card>
        )}
      </div>
    </div>
  )
}

// A compact "what we remember" row of tracked attributes with their trend.
function MemoryChips({ twin }: { twin: PropertyTwin }) {
  const attr = twin.attributes || {}
  const items: { label: string; key: string }[] = [
    { label: 'Lawn', key: 'lawn_size' },
    { label: 'Turf', key: 'lawn_health' },
    { label: 'Mulch', key: 'mulch_condition' },
    { label: 'Hedges', key: 'hedge_condition' },
    { label: 'Weeds', key: 'weeds' },
  ]
  const chips = items.map(it => ({ ...it, roll: attr[it.key] })).filter(x => x.roll && x.roll.current != null)
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {chips.map(({ label, key, roll }) => {
        const trend = roll!.trend
        const Icon = trend === 'improving' ? TrendingUp : trend === 'worsening' ? TrendingDown : Minus
        const tone: Tone = trend === 'improving' ? 'success' : trend === 'worsening' ? 'danger' : 'neutral'
        const val = key === 'lawn_size' && typeof roll!.current === 'number' ? `${Math.round(roll!.current as number).toLocaleString()} sqft` : String(roll!.current)
        return (
          <span key={key} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border bg-surface border-border text-ink-muted">
            <span className="text-ink-faint">{label}</span>
            <span className="font-semibold text-ink">{val}</span>
            <Icon className={cn('w-3 h-3', toneText[tone])} />
          </span>
        )
      })}
    </div>
  )
}
