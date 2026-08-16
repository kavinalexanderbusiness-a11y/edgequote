// ── Updates — the news half of the Owner Inbox ───────────────────────────────
// Recent events that need NOTHING from the owner: acceptances, payments,
// reviews, answered change orders. Grouped by THE notification organizer
// (lib/notifications), windowed by the engine — a week of news, never a
// permanent social feed.
//
// When Session 68's audit trail lands, its events feed lib/inbox's `updates`
// through the same NotifGroup shape and this component doesn't change.

import Link from 'next/link'
import { timeAgo } from '@/lib/utils'
import type { NotifGroup } from '@/lib/notifications'
import {
  FileText, DollarSign, Star, ShieldCheck, FilePen, Sparkles, type LucideIcon,
} from 'lucide-react'

// Presentation only — the update types the engine lets through today. Anything
// unmapped renders with the neutral glyph rather than being dropped: the engine
// decides what qualifies, this map only decorates.
const UPDATE_ICON: Record<string, LucideIcon> = {
  quote_accepted: FileText,
  invoice_paid: DollarSign,
  review_received: Star,
  payment_dispute_won: ShieldCheck,
  change_order_approved: FilePen,
  change_order_declined: FilePen,
}

export function InboxUpdates({ groups }: { groups: NotifGroup[] }) {
  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="px-4 sm:px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-bold tracking-tight text-ink">Updates</h2>
        <p className="text-[11px] text-ink-muted">Good news and closed loops from the last 7 days — nothing here needs you.</p>
      </div>
      {groups.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-xs text-ink-muted">No news this week yet. Accepted quotes, payments and reviews land here.</p>
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {groups.map(g => {
            const Icon = UPDATE_ICON[g.type] ?? Sparkles
            return (
              <li key={g.key}>
                <Link
                  href={g.href || '/dashboard/notifications'}
                  className="flex items-start gap-3 px-4 sm:px-5 py-3 hover:bg-surface-raised/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                >
                  <span aria-hidden className="shrink-0 w-8 h-8 rounded-lg bg-bg-tertiary border border-border flex items-center justify-center mt-0.5">
                    <Icon className="w-4 h-4 text-ink-muted" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {g.unread > 0 && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                      <span className="text-sm font-medium text-ink truncate">{g.title}</span>
                    </span>
                    {g.body && <span className="block text-xs text-ink-muted truncate mt-0.5">{g.body}</span>}
                    <span className="block text-[11px] text-ink-faint mt-0.5">{timeAgo(g.latestAt)}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
