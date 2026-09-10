import Link from 'next/link'
import { Card, CardBody } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { formatCurrency } from '@/lib/utils'
import { FOLLOW_UP_DAYS } from '@/lib/followup'
import type { SalesSnapshot } from '@/lib/sales/analytics'
import { ArrowRight } from 'lucide-react'

// ── Where the open money is sitting ──────────────────────────────────────────
// ⛔ NOT A FORECAST. There is no "$18,000 expected revenue" here, because
// EdgeQuote has no model that could defend the number. Every figure below is a
// DETERMINISTIC BUCKET: a fact about a record, not a guess about a person.
//
// The split between "needs a follow-up" and "awaiting them" is the owner's own
// follow-up cadence (lib/followup — THE staleness rule the quote screens and the
// automatic chaser both use), so this page can never disagree with the Pipeline
// about which quotes have gone quiet.

interface Bucket {
  label: string
  value: number
  count: number
  meaning: string
  href: string
  emphasis?: boolean
}

export function PipelineBuckets({ s }: { s: SalesSnapshot }) {
  const buckets: Bucket[] = [
    {
      label: 'Follow-up needed',
      value: s.followUpValue,
      count: s.followUpCount,
      meaning: `sent and quiet for ${FOLLOW_UP_DAYS}+ days`,
      href: '/dashboard/pipeline',
      emphasis: true,
    },
    {
      label: 'Awaiting customer',
      value: s.awaitingValue,
      count: s.awaitingCount,
      meaning: 'sent recently — the ball is theirs',
      href: '/dashboard/quotes?status=sent',
    },
    {
      label: 'Won',
      value: s.won,
      count: s.wonCount,
      meaning: 'accepted in this period',
      href: '/dashboard/quotes?status=accepted',
    },
    {
      label: 'Lost',
      value: s.lost,
      count: s.lostCount,
      meaning: 'declined in this period',
      href: '/dashboard/quotes?status=declined',
    },
  ]

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <SectionHeading title="Pipeline" className="mb-1" />
          {/* The headline sentence, spelled out rather than left as a bare
              figure: "$9,600" alone invites the reader to supply their own
              meaning, and the meaning they supply is usually "expected". */}
          <p className="text-xs text-ink-muted leading-relaxed">
            {s.open > 0
              ? `${formatCurrency(s.open)} in open quotes awaiting a customer decision.`
              : 'No quotes are waiting on a decision.'}
          </p>
        </div>

        <ul className="space-y-2">
          {buckets.map(b => (
            <li key={b.label}>
              <Link
                href={b.href}
                className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface px-3.5 py-3 tap-target-y transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-ink truncate">
                    {b.label}
                    <span className="text-ink-faint font-normal"> · {b.count}</span>
                  </span>
                  <span className="block text-[11px] text-ink-faint truncate">{b.meaning}</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className={`text-sm font-bold tabular-nums ${b.emphasis && b.value > 0 ? 'text-amber-400' : 'text-ink'}`}>
                    {formatCurrency(b.value)}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5 text-ink-faint" />
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="text-[11px] text-ink-faint leading-relaxed">
          These are counts of real quotes, not a forecast. EdgeQuote does not predict which open
          quotes will close — it shows what each one is actually waiting on.
        </p>
      </CardBody>
    </Card>
  )
}
