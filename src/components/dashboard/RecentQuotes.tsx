import Link from 'next/link'
import { Quote } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/Badge'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { ArrowRight } from 'lucide-react'

interface RecentQuotesProps {
  quotes: Quote[]
}

export function RecentQuotes({ quotes }: RecentQuotesProps) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Recent Quotes</h2>
        <Link href="/dashboard/quotes" className="text-xs text-accent hover:text-accent-hover flex items-center gap-1">
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardBody className="p-0">
        {quotes.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-muted">No quotes yet</div>
        ) : (
          <div className="divide-y divide-border">
            {quotes.map((q) => (
              <Link
                key={q.id}
                href={`/dashboard/quotes/${q.id}`}
                className="flex items-center justify-between px-6 py-4 hover:bg-surface-raised transition-colors group"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{q.customer_name}</p>
                  <p className="text-xs text-ink-muted truncate mt-0.5">{q.quote_number} · {q.service_type}</p>
                </div>
                <div className="flex items-center gap-4 shrink-0 ml-4">
                  <p className="text-sm font-semibold text-ink">{formatCurrency(q.total)}</p>
                  <StatusBadge status={q.status} />
                  <span className="text-xs text-ink-faint hidden sm:block">{formatDate(q.created_at)}</span>
                  <ArrowRight className="w-4 h-4 text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
