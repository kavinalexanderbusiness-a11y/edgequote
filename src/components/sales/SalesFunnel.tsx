import { Card, CardBody } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { formatCurrency } from '@/lib/utils'
import type { SalesFunnel as Funnel } from '@/lib/sales/analytics'

// ── The funnel ───────────────────────────────────────────────────────────────
// Six rungs, each from a real record. Bars are scaled to the LARGEST MONEY RUNG,
// not to the first one, so a funnel whose invoiced value exceeds its quoted value
// (change orders, or work invoiced from a deal quoted earlier) still renders
// truthfully instead of clipping at 100%.
//
// ⚠️ The `leads` rung has NO dollar figure and must not be given one. Its bar is
// therefore drawn from COUNTS and visually distinct — a lead nobody has priced is
// worth an unknown amount, and drawing it at $0 would make the funnel's first
// step look like a collapse.
//
// ⛔ No stage is inferred backwards. A later rung CAN exceed an earlier one (a
// job invoiced without a quote, a quote accepted without ever being marked sent),
// and that is a true fact about how the book was kept — clamping it would invent
// events that never happened.

export function SalesFunnel({ funnel }: { funnel: Funnel }) {
  const moneyStages = funnel.stages.filter(s => s.value != null)
  const max = Math.max(1, ...moneyStages.map(s => s.value!))

  return (
    <Card>
      <CardBody className="space-y-4">
        <SectionHeading title="Funnel" />

        <ol className="space-y-2.5">
          {funnel.stages.map(stage => {
            const pct = stage.value != null ? Math.max(2, Math.round((stage.value / max) * 100)) : null
            return (
              <li key={stage.key}>
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-xs font-semibold text-ink truncate">{stage.label}</span>
                  <span className="text-xs tabular-nums text-ink-muted shrink-0">
                    {stage.value != null ? formatCurrency(stage.value) : '—'}
                    <span className="text-ink-faint"> · {stage.count}</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
                  {pct != null ? (
                    <div className="h-full rounded-full bg-accent/70" style={{ width: `${pct}%` }} />
                  ) : (
                    // Counts-only rung: a hatched, unmeasured bar. Deliberately
                    // not a full bar — it is not "100% of anything".
                    <div className="h-full w-full bg-[repeating-linear-gradient(45deg,rgb(255_255_255/0.08)_0_6px,transparent_6px_12px)]" />
                  )}
                </div>
                <p className="text-[11px] text-ink-faint mt-1 leading-snug">{stage.meaning}</p>
              </li>
            )
          })}
        </ol>

        <div className="space-y-1 pt-1 border-t border-border">
          {funnel.unquotedLeads > 0 && (
            <p className="text-[11px] text-ink-faint leading-relaxed">
              {funnel.unquotedLeads} {funnel.unquotedLeads === 1 ? 'person' : 'people'} came to you in this
              period and never received a quote.
            </p>
          )}
          {funnel.hasUnstampedSends && (
            <p className="text-[11px] text-ink-faint leading-relaxed">
              Some quotes have no send date recorded, so the “Quote sent” rung counts fewer than were
              actually delivered. EdgeHQ shows what was recorded rather than filling the gap in.
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
