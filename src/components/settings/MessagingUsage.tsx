'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { analyzeSms, smsCostCad, formatSmsCost, SMS_COST_PER_SEGMENT_CAD } from '@/lib/sms/segments'
import { MessageSquareText, Loader2 } from 'lucide-react'

interface Row { body: string | null; created_at: string }

// Lightweight messaging-usage card. Reads this month's OUTBOUND SMS from the
// existing messages table (which stores the actual sent body), so spend is
// computed from REAL segment counts — not a flat guess. Estimate-only: it mirrors
// the same per-segment price the composer previews use, so the numbers line up.
export function MessagingUsage() {
  const [supabase] = useState(() => createClient())
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setRows([]); return }
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
      const { data } = await supabase.from('messages')
        .select('body, created_at')
        .eq('user_id', user.id).eq('direction', 'outbound').eq('channel', 'sms')
        .gte('created_at', monthStart.toISOString())
        .order('created_at', { ascending: false }).limit(5000)
      if (active) setRows((data as Row[]) || [])
    })()
    return () => { active = false }
  }, [supabase])

  const stats = useMemo(() => {
    if (!rows) return null
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    let sentMonth = 0, sentToday = 0, segMonth = 0
    for (const r of rows) {
      sentMonth++
      segMonth += analyzeSms(r.body || '').segments
      if (new Date(r.created_at) >= todayStart) sentToday++
    }
    return { sentMonth, sentToday, segMonth, spend: smsCostCad(segMonth) }
  }, [rows])

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquareText className="w-4 h-4 text-accent" /> Messaging Usage</h2>
          <p className="text-xs text-ink-faint mt-0.5">Outbound SMS this month, with a rough cost estimate. For awareness, not billing.</p>
        </div>
      </CardHeader>
      <CardBody>
        {!stats ? (
          <div className="py-6 text-center text-xs text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading usage…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <UsageStat label="SMS sent today" value={String(stats.sentToday)} />
              <UsageStat label="SMS sent this month" value={String(stats.sentMonth)} />
              <UsageStat label="Est. spend this month" value={formatSmsCost(stats.spend)} tone="text-accent" />
              <UsageStat label="Avg cost / segment" value={formatSmsCost(SMS_COST_PER_SEGMENT_CAD)} />
            </div>
            <p className="text-[11px] text-ink-faint mt-3">
              {stats.segMonth} SMS segment{stats.segMonth !== 1 ? 's' : ''} sent this month (a long message can be several segments).
              Estimates use ~{formatSmsCost(SMS_COST_PER_SEGMENT_CAD)}/segment — your real carrier rate may differ.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function UsageStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5">
      <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide leading-none">{label}</p>
      <p className={`text-lg font-bold mt-1 tabular-nums ${tone || 'text-ink'}`}>{value}</p>
    </div>
  )
}
