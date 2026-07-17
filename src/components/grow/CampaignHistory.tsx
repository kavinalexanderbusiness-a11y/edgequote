'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { formatDate } from '@/lib/utils'
import {
  loadCampaignHistory, describeCampaignStatus,
  type CampaignHistoryRow, type CampaignStats, type CampaignSendStatus,
} from '@/lib/crm/campaignStats'
import { CheckCircle2, MinusCircle, AlertTriangle, Loader2, MailOpen, Send } from 'lucide-react'

// Per-campaign history + analytics. Reads only what the send path already
// recorded (crm_campaign_log + notification_log delivery) — it never sends and
// never estimates. Rendered inside an expanded campaign row so the numbers sit
// next to the campaign they describe.

const STATUS_META: Record<CampaignSendStatus, { icon: typeof CheckCircle2; cls: string }> = {
  sent: { icon: CheckCircle2, cls: 'text-emerald-400' },
  skipped: { icon: MinusCircle, cls: 'text-ink-faint' },
  failed: { icon: AlertTriangle, cls: 'text-red-400' },
  sending: { icon: Loader2, cls: 'text-ink-faint' },
}

export function CampaignHistory({ campaignId, stats }: { campaignId: string; stats: CampaignStats }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<CampaignHistoryRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    loadCampaignHistory(supabase, campaignId, 25).then(r => {
      if (alive) { setRows(r); setLoading(false) }
    })
    return () => { alive = false }
  }, [supabase, campaignId])

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Results</span>

      {stats.total === 0 ? (
        <p className="text-xs text-ink-faint">
          No sends yet — results appear here after this campaign runs.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="Sent" value={stats.sent} icon={Send} tone={stats.sent ? 'success' : undefined} />
            <StatTile label="Delivered" value={stats.delivered} icon={CheckCircle2} />
            <StatTile label="Opened" value={stats.opened} icon={MailOpen} />
            <StatTile label="Skipped" value={stats.skipped} icon={MinusCircle} tone={stats.failed ? 'danger' : undefined} sub={stats.failed ? `${stats.failed} failed` : undefined} />
          </div>
          {/* Say the true thing: opens are email-only, and name the actual skip
              reasons the send path recorded rather than leaving "12 skipped" as
              a shrug the owner can't act on. */}
          {stats.skipReasons.length > 0 && (
            <p className="text-[11px] text-ink-muted leading-snug">
              Skipped: {stats.skipReasons.map(r => `${r.count} ${r.label}`).join(' · ')}.
            </p>
          )}
          <p className="text-[11px] text-ink-faint">
            Delivered and opened come from the email/SMS provider — SMS never reports opens.
          </p>
        </>
      )}

      {loading ? (
        <div className="flex flex-col gap-1.5" aria-hidden="true">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-8 rounded-lg" />)}
        </div>
      ) : rows.length > 0 && (
        <ul role="list" className="rounded-xl border border-border divide-y divide-border overflow-hidden">
          {rows.map(r => {
            const meta = STATUS_META[r.status]
            const Icon = meta.icon
            return (
              <li key={r.id} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                <Icon className={`w-3.5 h-3.5 shrink-0 ${meta.cls} ${r.status === 'sending' ? 'animate-spin' : ''}`} />
                <span className="text-ink truncate min-w-0 flex-1">{r.customerName}</span>
                <span className="text-ink-faint shrink-0 hidden sm:inline">
                  {r.channel === 'sms' ? 'SMS' : r.channel === 'email' ? 'Email' : '—'}
                </span>
                <span className="text-ink-muted shrink-0">
                  {r.openedAt ? 'Opened' : r.deliveredAt ? 'Delivered' : describeCampaignStatus(r.status)}
                </span>
                <span className="text-ink-faint shrink-0 tabular-nums">{formatDate(r.createdAt)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
