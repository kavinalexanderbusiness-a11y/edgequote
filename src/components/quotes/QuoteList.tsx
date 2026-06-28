'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { hoverIntent } from '@/lib/prefetch'
import { Quote, QuoteStatus } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { needsFollowUp, daysSince } from '@/lib/followup'
import { QuoteStatusControl } from '@/components/quotes/QuoteStatusControl'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Search, Trash2, ArrowRight, Bell } from 'lucide-react'

interface QuoteListProps {
  quotes: Quote[]
  onDelete: (id: string) => Promise<void>
}

const STATUS_FILTERS: { value: '' | QuoteStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'paid', label: 'Paid' },
  { value: 'declined', label: 'Declined' },
]

export function QuoteList({ quotes, onDelete }: QuoteListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | QuoteStatus>('')
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const followUpCount = quotes.filter(needsFollowUp).length

  // Deep-link from the Weekly Review (and elsewhere): ?followup=1 opens straight to
  // the follow-up queue, ?status=sent to a status — one tap, no re-filtering. Read
  // from window (not useSearchParams) so no Suspense boundary is needed.
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      if (p.get('followup') === '1') setFollowUpOnly(true)
      const s = p.get('status')
      if (s && STATUS_FILTERS.some(f => f.value === s)) setStatusFilter(s as QuoteStatus)
    } catch { /* ignore */ }
  }, [])

  const filtered = quotes.filter(q => {
    const matchSearch =
      q.customer_name.toLowerCase().includes(search.toLowerCase()) ||
      q.quote_number.toLowerCase().includes(search.toLowerCase()) ||
      q.service_type.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter ? q.status === statusFilter : true
    const matchFollowUp = followUpOnly ? needsFollowUp(q) : true
    return matchSearch && matchStatus && matchFollowUp
  })

  async function handleDelete(id: string) {
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
          <input
            type="text"
            placeholder="Search quotes..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-surface border border-border-strong rounded-xl pl-10 pr-4 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {followUpCount > 0 && (
            <button
              onClick={() => setFollowUpOnly(v => !v)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                followUpOnly
                  ? 'bg-amber-400 text-black'
                  : 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
              }`}
            >
              <Bell className="w-3 h-3" /> Follow up ({followUpCount})
            </button>
          )}
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                statusFilter === f.value
                  ? 'bg-accent text-black'
                  : 'bg-surface border border-border-strong text-ink-muted hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <Card className="py-14 text-center text-sm text-ink-muted">
          No quotes found.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Quote #</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Customer</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide hidden md:table-cell">Service</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Total</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide">Status</th>
                  <th className="text-left px-3 sm:px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wide hidden lg:table-cell">Date</th>
                  <th className="px-3 sm:px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(q => (
                  <tr key={q.id} {...hoverIntent(() => router.prefetch(`/dashboard/quotes/${q.id}`))}
                    onClick={() => router.push(`/dashboard/quotes/${q.id}`)}
                    className="hover:bg-surface-raised transition-colors group cursor-pointer">
                    <td className="px-3 sm:px-5 py-3.5 font-mono text-xs text-ink-muted">
                      <span className="flex items-center gap-1.5">
                        {needsFollowUp(q) && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Needs follow-up" />}
                        {q.quote_number}
                      </span>
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 font-medium text-ink">
                      {q.customer_name}
                      {needsFollowUp(q) && q.sent_at && (
                        <span className="block text-[10px] font-semibold text-amber-400 mt-0.5">Sent {daysSince(q.sent_at)}d ago · follow up</span>
                      )}
                    </td>
                    <td className="px-3 sm:px-5 py-3.5 text-ink-muted hidden md:table-cell">{q.service_type}</td>
                    <td className="px-3 sm:px-5 py-3.5 font-semibold text-ink">{formatCurrency(q.total)}</td>
                    <td className="px-3 sm:px-5 py-3.5" onClick={e => e.stopPropagation()}><QuoteStatusControl quoteId={q.id} status={q.status} followUpCount={q.follow_up_count} /></td>
                    <td className="px-3 sm:px-5 py-3.5 text-ink-faint hidden lg:table-cell">{formatDate(q.created_at)}</td>
                    <td className="px-3 sm:px-5 py-3.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDelete(q.id)}
                          loading={deleting === q.id}
                          title="Delete quote"
                          className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                        <Link href={`/dashboard/quotes/${q.id}`}>
                          <Button variant="ghost" size="sm">
                            <ArrowRight className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-ink-faint text-right">{filtered.length} quote{filtered.length !== 1 ? 's' : ''}</p>
    </div>
  )
}