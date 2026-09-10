import { Card, CardBody } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { formatCurrency } from '@/lib/utils'
import type { SourceReport } from '@/lib/sales/analytics'

// ── Lead sources ─────────────────────────────────────────────────────────────
// Built on the Session 16/29 attribution work: the CATEGORY comes from
// lib/attribution and nowhere else, `unknown` is a first-class always-shown
// answer, and a raw value nobody recognised keeps its own text.
//
// ⚠️ THE LABELS ARE LOAD-BEARING. These are figures FROM customers acquired
// through a channel — never revenue CAUSED by it. EdgeQuote records where a
// customer said they came from; that is not ad attribution, and a causal claim
// is one this app cannot support.
//
// ⛔ A rate is withheld below lib/attribution's sample floor. At n=2 one customer
// moves the number by fifty points, and "50% of Google leads convert" is a
// sentence an owner would act on and should not.

export function SourceTable({ sources }: { sources: SourceReport }) {
  if (sources.customers === 0) {
    return (
      <Card>
        <CardBody>
          <SectionHeading title="Lead sources" />
          <p className="text-xs text-ink-muted mt-3">
            No customers arrived in this period, so there is nothing to attribute.
          </p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <SectionHeading
          title="Lead sources"
          sub={sources.unknownPct != null && sources.unknownPct > 0
            ? `${sources.unknownPct}% have no source recorded`
            : undefined}
        />

        {/* Scrolls inside its own container — a six-column money table cannot fit
            at 375px, and letting the page scroll sideways breaks every other
            screen instead. */}
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full min-w-[520px] text-xs">
            <thead>
              <tr className="text-ink-faint text-[10px] uppercase tracking-wide">
                <th className="text-left font-semibold pb-2">Source</th>
                <th className="text-right font-semibold pb-2">Customers</th>
                <th className="text-right font-semibold pb-2">Quoted</th>
                <th className="text-right font-semibold pb-2">Won</th>
                <th className="text-right font-semibold pb-2">Won value</th>
                <th className="text-right font-semibold pb-2">Collected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sources.rows.map(r => (
                <tr key={r.category} className={r.category === 'unknown' ? 'text-ink-muted' : 'text-ink'}>
                  <td className="py-2 pr-3">
                    <span className="font-medium">{r.label}</span>
                    {r.details.length > 0 && (
                      <span className="block text-[10px] text-ink-faint truncate max-w-[180px]">
                        {r.details.join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.customers}</td>
                  <td className="py-2 text-right tabular-nums">{r.quoted}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.won}
                    {/* A percentage only where the cohort can carry one. */}
                    {r.wonRate != null && (
                      <span className="text-ink-faint"> ({Math.round(r.wonRate * 100)}%)</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatCurrency(r.wonValue)}</td>
                  <td className="py-2 text-right tabular-nums">{formatCurrency(r.collected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-1 text-[11px] text-ink-faint leading-relaxed">
          <p>
            Money here is what came <em>from customers who arrived through that source</em> — not
            revenue caused by it. EdgeQuote records where a customer said they came from; it does
            not track ads.
          </p>
          <p>
            Conversion percentages appear only for sources with {sources.minSampleForRate} or more
            customers. Below that, one customer moves the number too far to be worth acting on.
          </p>
          {sources.unknownPct != null && sources.unknownPct >= 25 && (
            <p className="text-amber-400/80">
              “Not recorded” is your largest blind spot. Setting a source when you add a customer is
              what makes this table worth reading.
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
