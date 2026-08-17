import Link from 'next/link'
import { Card, CardBody } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency } from '@/lib/utils'
import { STAGE_LABELS, type SalesStage } from '@/lib/salesStage'
import type { MovementRow } from '@/lib/sales/analytics'
import type { Tone } from '@/lib/tone'

// ── Recent movement ──────────────────────────────────────────────────────────
// The last few deals to actually MOVE, newest first. Ordered by the most recent
// real timestamp on the record — a follow-up, a send, or the creation — and
// never by `updated_at`, which moves on any edit and would present an untouched
// quote as the day's news.
//
// Deliberately a short list with a door to Quotes, not a paginated history: this
// page answers "how is selling going", and a full ledger of every quote belongs
// where the owner can filter and search it.

const STAGE_TONE: Record<SalesStage, Tone> = {
  new_lead: 'info',
  contacted: 'info',
  quote_draft: 'neutral',
  quote_sent: 'info',
  won: 'success',
  lost: 'danger',
}

const SHOWN = 8

export function RecentMovement({ rows }: { rows: MovementRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <SectionHeading title="Recent movement" />
          <p className="text-xs text-ink-muted mt-3">No quotes were raised in this period.</p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <SectionHeading title="Recent movement" sub="The deals that moved most recently" />

        <ul className="divide-y divide-border">
          {rows.slice(0, SHOWN).map(r => (
            <li key={r.quoteId}>
              <Link
                href={r.href}
                className="flex items-center justify-between gap-3 py-2.5 tap-target-y transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-ink truncate">{r.name}</span>
                  <span className="block text-[11px] text-ink-faint truncate">
                    {[r.quoteNumber, r.service].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {/* An unpriced deal shows a dash, never $0. */}
                  <span className="text-xs font-semibold tabular-nums text-ink">
                    {r.value != null ? formatCurrency(r.value) : '—'}
                  </span>
                  <Badge tone={STAGE_TONE[r.stage]}>{STAGE_LABELS[r.stage]}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {rows.length > SHOWN && (
          <Link href="/dashboard/quotes" className="block text-[11px] text-ink-muted hover:text-accent-text underline">
            All {rows.length} quotes from this period
          </Link>
        )}
      </CardBody>
    </Card>
  )
}
