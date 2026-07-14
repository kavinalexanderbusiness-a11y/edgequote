'use client'

import { format } from 'date-fns'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { CloudRain, Check, Wand2, CalendarX2, X, ArrowRight } from 'lucide-react'

export interface RainMoveSummary {
  date: string
  blocked: boolean
  byDay: { to: string; count: number }[]   // e.g. [{ to: '2026-06-29', count: 2 }]
  revenueProtected: number
  unmovable: number
}

interface Props {
  date: string
  jobsAffected: number
  rainLabel: string          // e.g. "Heavy rain expected"
  revenue: number
  busy: boolean
  summary: RainMoveSummary | null
  onDisableAndOptimize: () => void
  onDisableOnly: () => void
  onOptimizeOnly: () => void
  onLater: () => void
  onDismissSummary: () => void
}

const dayName = (iso: string) => format(new Date(iso + 'T00:00:00'), 'EEEE')
const dayShort = (iso: string) => format(new Date(iso + 'T00:00:00'), 'EEE, MMM d')

// Proactive Weather Ops card: when rain threatens a day with booked work, surface
// the problem AND the one-click fix (block the day + auto-optimize) right on the
// schedule — no need to open another screen. After applying, it shows exactly
// what moved and the revenue protected.
export function WeatherRainCard(props: Props) {
  const { date, jobsAffected, rainLabel, revenue, busy, summary } = props

  if (summary) {
    return (
      <div className="rounded-card border border-emerald-500/30 bg-emerald-500/[0.07] p-4 mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center justify-center shrink-0">
              <Check className="w-4.5 h-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink">
                {summary.blocked ? `${dayName(summary.date)} marked unavailable (Rain)` : `${dayName(summary.date)} auto-optimized`}
              </p>
              {summary.byDay.length > 0 ? (
                <div className="mt-1.5 space-y-0.5">
                  <p className="text-xs font-medium text-ink-muted">Moved:</p>
                  {summary.byDay.map(b => (
                    <p key={b.to} className="text-xs text-ink flex items-center gap-1.5">
                      <span className="text-emerald-400">•</span> {b.count} job{b.count !== 1 ? 's' : ''}
                      <ArrowRight className="w-3 h-3 text-ink-faint" /> {dayName(b.to)}
                    </p>
                  ))}
                  {summary.unmovable > 0 && (
                    <p className="text-[11px] text-amber-400/90">{summary.unmovable} couldn’t be moved (locked/billed) — review them manually.</p>
                  )}
                  <p className="text-xs font-semibold text-emerald-300 pt-1">Revenue protected: <span className="tabular-nums">{formatCurrency(summary.revenueProtected)}</span></p>
                </div>
              ) : (
                <p className="text-xs text-ink-muted mt-1">No movable jobs needed relocating — the day is clear.</p>
              )}
            </div>
          </div>
          <button onClick={props.onDismissSummary} aria-label="Dismiss" className="shrink-0 text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
        </div>
      </div>
    )
  }

  return (
    // Amber — this is a delay-severity WARNING; a calm blue card contradicted the
    // red/amber vocabulary the weather page uses for the same event.
    <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-4 mb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-300 flex items-center justify-center shrink-0">
            <CloudRain className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-tight text-ink">
              {dayShort(date)}
            </p>
            <p className="text-xs text-ink-muted mt-0.5">{rainLabel}</p>
            <p className="text-xs text-ink mt-1.5 tabular-nums">
              <span className="font-semibold">{jobsAffected} job{jobsAffected !== 1 ? 's' : ''} affected</span>
              {revenue > 0 && <span className="text-ink-faint"> · {formatCurrency(revenue)} at risk</span>}
            </p>
            <p className="text-[11px] text-ink-faint mt-1.5">Recommendation: mark this day unavailable due to rain and move the work to the best open days.</p>
          </div>
        </div>
        <button onClick={props.onLater} aria-label="Decide later" title="Decide later" className="shrink-0 text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3.5">
        <Button size="sm" onClick={props.onDisableAndOptimize} loading={busy}>
          <Wand2 className="w-3.5 h-3.5" /> Disable day &amp; auto-optimize
        </Button>
        <Button size="sm" variant="secondary" onClick={props.onDisableOnly} disabled={busy}>
          <CalendarX2 className="w-3.5 h-3.5" /> Disable day only
        </Button>
        <Button size="sm" variant="secondary" onClick={props.onOptimizeOnly} disabled={busy}>
          <Wand2 className="w-3.5 h-3.5" /> Auto-optimize only
        </Button>
      </div>
    </div>
  )
}
