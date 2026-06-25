'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { TrendingUp, Users } from 'lucide-react'

interface Row {
  id: string
  name: string
  acquisition_source: string | null
  referred_by_customer_id: string | null
}

// Where the business comes from: acquisition-channel mix + who refers the most.
export function AcquisitionInsights() {
  const supabase = createClient()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data } = await supabase
        .from('customers')
        .select('id, name, acquisition_source, referred_by_customer_id')
        .eq('user_id', user!.id)
      setRows((data as Row[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  const total = rows.length
  const nameById = new Map(rows.map(r => [r.id, r.name]))

  const sourceCounts = new Map<string, number>()
  for (const r of rows) {
    if (!r.acquisition_source) continue
    sourceCounts.set(r.acquisition_source, (sourceCounts.get(r.acquisition_source) || 0) + 1)
  }
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])

  const referrerCounts = new Map<string, number>()
  for (const r of rows) {
    if (!r.referred_by_customer_id) continue
    referrerCounts.set(r.referred_by_customer_id, (referrerCounts.get(r.referred_by_customer_id) || 0) + 1)
  }
  const referrers = [...referrerCounts.entries()]
    .map(([id, count]) => ({ name: nameById.get(id) || 'Former customer', count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  if (loading) return null

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">Where customers come from</h2>
        </CardHeader>
        <CardBody>
          {sources.length === 0 ? (
            <InlineEmpty icon={TrendingUp}>Tag a customer&apos;s source to see your channel mix.</InlineEmpty>
          ) : (
            <div className="space-y-2.5">
              {sources.map(([source, count]) => {
                const pct = total > 0 ? Math.round((count / total) * 100) : 0
                return (
                  <div key={source}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-ink-muted">{source}</span>
                      <span className="text-ink font-medium">{count} · {pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center gap-2">
          <Users className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">Top referrers</h2>
        </CardHeader>
        <CardBody>
          {referrers.length === 0 ? (
            <InlineEmpty icon={Users}>No referrals tracked yet.</InlineEmpty>
          ) : (
            <div className="space-y-2">
              {referrers.map((r, i) => (
                <div key={r.name + i} className="flex items-center justify-between px-1 py-1.5">
                  <span className="flex items-center gap-2 text-sm text-ink">
                    <span className="w-5 h-5 rounded-full bg-accent/10 text-accent text-xs font-bold flex items-center justify-center">{i + 1}</span>
                    {r.name}
                  </span>
                  <span className="text-sm font-semibold text-ink">{r.count} referral{r.count !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
