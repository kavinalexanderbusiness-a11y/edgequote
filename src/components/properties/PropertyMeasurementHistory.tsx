'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { ConfidenceBadge } from '@/components/measure/AutoMeasureBanner'
import { formatDate } from '@/lib/utils'
import { History } from 'lucide-react'

interface MRow {
  id: string; created_at: string; auto_sqft: number | null; accepted_sqft: number | null
  diff_pct: number | null; confidence: string | null; source: string | null; context: string | null; adjusted: boolean | null
}

const SOURCE_LABEL: Record<string, string> = { 'calgary-buildings': 'Auto', manual: 'Manual', booking: 'Online booking' }
const CONTEXT_LABEL: Record<string, string> = { quote: 'Quote', property: 'Saved', booking: 'Booking', snow: 'Snow' }

// Measurement history for one property: every recorded version with its auto
// estimate vs the accepted area, the change %, confidence, and how it was made.
export function PropertyMeasurementHistory({ propertyId }: { propertyId: string }) {
  const [rows, setRows] = useState<MRow[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.from('measurements')
        .select('id, created_at, auto_sqft, accepted_sqft, diff_pct, confidence, source, context, adjusted')
        .eq('property_id', propertyId).order('created_at', { ascending: false }).limit(30)
      if (active) { setRows((data as MRow[]) || []); setLoaded(true) }
    })()
    return () => { active = false }
  }, [propertyId])

  if (!loaded || rows.length === 0) return null
  return (
    <Card>
      <CardHeader>
        {/* Not "Measurement history" — MeasureTool renders a section by that name
            on the same page; this table is the auto-vs-accepted comparison. */}
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><History className="w-4 h-4 text-accent" /> Auto-measure accuracy</h2>
        <p className="text-xs text-ink-faint mt-0.5">Auto estimate vs what you accepted, over time — this is what trains the per-neighborhood learning.</p>
      </CardHeader>
      <CardBody>
        <div className="overflow-x-auto">
          {/* Shared table cells (ui/Table) — one header/cell treatment app-wide */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <Th className="px-0 pr-3 py-2">Date</Th>
                <Th className="px-0 pr-3 py-2">Auto est.</Th>
                <Th className="px-0 pr-3 py-2">Accepted</Th>
                <Th className="px-0 pr-3 py-2">Δ</Th>
                <Th className="px-0 pr-3 py-2">How</Th>
                <Th className="px-0 py-2">Confidence</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(r => (
                <tr key={r.id} className={tableRowHover}>
                  <Td className="px-0 pr-3 py-2 text-ink-muted whitespace-nowrap">{formatDate(r.created_at)}</Td>
                  <Td className="px-0 pr-3 py-2 text-ink-muted tabular-nums">{r.auto_sqft != null ? `${Number(r.auto_sqft).toLocaleString()} ft²` : '—'}</Td>
                  <Td className="px-0 pr-3 py-2 font-semibold tabular-nums">{r.accepted_sqft != null ? `${Number(r.accepted_sqft).toLocaleString()} ft²` : '—'}</Td>
                  <Td className={`px-0 pr-3 py-2 tabular-nums ${r.adjusted ? 'text-amber-400' : 'text-emerald-400'}`}>{r.diff_pct != null ? `${r.diff_pct > 0 ? '+' : ''}${r.diff_pct}%` : (r.auto_sqft != null ? '0%' : '—')}</Td>
                  <Td className="px-0 pr-3 py-2 text-ink-faint text-xs">{SOURCE_LABEL[r.source || ''] || r.source || '—'}{r.context ? ` · ${CONTEXT_LABEL[r.context] || r.context}` : ''}</Td>
                  <Td className="px-0 py-2">{r.auto_sqft != null ? <ConfidenceBadge confidence={r.confidence} /> : <span className="text-ink-faint text-xs">manual</span>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}
