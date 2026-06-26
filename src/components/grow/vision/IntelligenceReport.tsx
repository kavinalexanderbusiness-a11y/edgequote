import { Clock, Scissors, Ruler, Gauge, Sparkles, AlertTriangle, Check, Minus, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Banner } from '@/components/ui/Banner'
import { StatTile } from '@/components/ui/StatTile'
import { cn } from '@/lib/utils'
import { toneSoft, toneText } from '@/lib/tone'
import { FEATURE_KEYS, type Detection, type PropertyIntelligence } from '@/lib/vision/types'
import { CONFIDENCE_TONE, DIFFICULTY_LABELS, DIFFICULTY_TONE, FEATURE_LABELS, featureTone } from '@/lib/vision/labels'

// ── AI Vision — the report ────────────────────────────────────────────────────
// A read-only render of one property_intelligence row. Pure + presentational so
// it can be dropped anywhere later (e.g. a property detail tab). Everything here
// is framed as a RECOMMENDATION; nothing is or implies a price.

function round(n: number | null | undefined): string {
  return n == null ? '—' : Math.round(n).toLocaleString()
}

export function IntelligenceReport({ intel }: { intel: PropertyIntelligence }) {
  const a = intel.analysis
  const band = intel.confidence_band || 'low'
  const byKey = new Map<string, Detection>((a.detections || []).map(d => [d.key, d]))
  const est = a.estimates
  const presentNotes = (a.detections || []).filter(d => d.present && d.notes)

  return (
    <div className="space-y-5">
      {/* Confidence header */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={cn('w-12 h-12 rounded-2xl border flex flex-col items-center justify-center shrink-0', toneSoft[CONFIDENCE_TONE[band]])}>
              <span className="text-base font-black leading-none">{Math.round(intel.confidence ?? 0)}</span>
              <span className="text-[8px] uppercase tracking-wide leading-none mt-0.5 opacity-70">conf</span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-accent" /> AI Vision read
                <span className={cn('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border', toneSoft[CONFIDENCE_TONE[band]])}>
                  {band} confidence
                </span>
              </p>
              <p className="text-[11px] text-ink-faint mt-0.5">
                {intel.source} · {intel.image_count} image{intel.image_count === 1 ? '' : 's'} · {(intel.created_at || '').slice(0, 10)}
                {intel.model ? ` · ${intel.model}` : ''}
              </p>
            </div>
          </div>
        </div>
        {a.summary && <p className="text-sm text-ink-muted mt-3 leading-relaxed">{a.summary}</p>}
      </Card>

      <Banner tone="info" icon={ShieldCheck}>
        These are recommendations from imagery only — no prices, quotes or jobs are changed. Use your judgement on site.
      </Banner>

      {/* Estimates */}
      {est && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1 mb-2">Estimates</p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile
              label="Mowing difficulty"
              value={DIFFICULTY_LABELS[est.mowing_difficulty]}
              tone={DIFFICULTY_TONE[est.mowing_difficulty]}
              icon={Gauge}
              sub={`${Math.round(est.difficulty_score)}/100`}
            />
            <StatTile label="Labour" value={`~${round(est.labour_minutes)} min`} icon={Clock} sub="on-site, whole visit" />
            <StatTile label="Trimming" value={`~${round(est.trimming_minutes)} min`} icon={Scissors} sub="string trimming" />
            <StatTile label="Edging" value={`~${round(est.edging_feet)} ft`} icon={Ruler} sub="linear, hard edges" />
          </div>
          {est.rationale && <p className="text-[11px] text-ink-faint mt-2 px-1">{est.rationale}</p>}
        </div>
      )}

      {/* Detections — all 12, stable order */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1 mb-2">What AI Vision detected</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {FEATURE_KEYS.map(key => {
            const d = byKey.get(key)
            const present = !!d?.present
            return (
              <div
                key={key}
                className={cn(
                  'rounded-card border px-3 py-2 flex items-center gap-2',
                  present ? toneSoft[featureTone(key)] : 'bg-surface border-border text-ink-faint'
                )}
              >
                {present ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Minus className="w-3.5 h-3.5 shrink-0 opacity-50" />}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate">{FEATURE_LABELS[key]}</p>
                  {present && (
                    <p className="text-[10px] opacity-80 truncate">
                      {d?.coverage && d.coverage !== 'none' ? `${d.coverage} · ` : ''}{Math.round(d?.confidence ?? 0)}%
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {presentNotes.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {presentNotes.map(d => (
              <li key={d.key} className="text-[11px] text-ink-muted flex gap-1.5">
                <span className={cn('font-semibold shrink-0', toneText[featureTone(d.key)])}>{FEATURE_LABELS[d.key]}:</span>
                <span className="min-w-0">{d.notes}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Upsells — recommendations only */}
      {a.upsells && a.upsells.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1 mb-2">Suggested upsells <span className="text-ink-faint/70 normal-case font-normal">— recommendations, pricing unchanged</span></p>
          <div className="space-y-2">
            {a.upsells.map((u, i) => (
              <Card key={`${u.key}-${i}`} className="p-3 flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink flex items-center gap-2">
                    {u.label}
                    <span className="text-[10px] font-medium text-ink-faint">{Math.round(u.confidence)}%</span>
                  </p>
                  <p className="text-xs text-ink-muted mt-0.5">{u.reason}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Limitations */}
      {a.limitations && a.limitations.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1 mb-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3 text-amber-400" /> What it couldn’t assess
          </p>
          <ul className="rounded-card border border-border bg-surface divide-y divide-border">
            {a.limitations.map((l, i) => (
              <li key={i} className="px-3 py-2 text-xs text-ink-muted">{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
