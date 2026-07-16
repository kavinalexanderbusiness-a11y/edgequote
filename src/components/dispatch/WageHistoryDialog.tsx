'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Technician, WageHistoryEntry } from '@/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { formatCurrency, cn } from '@/lib/utils'
import { History, TrendingUp, TrendingDown, AlertTriangle, Info } from 'lucide-react'

// ── Wage history ─────────────────────────────────────────────────────────────
// The audit trail of someone's pay rate. Read-only by design: rows are written by
// a DB trigger on technicians.hourly_wage, so every change is captured no matter
// which code path made it — and none can be edited away afterwards.
//
// Ordered by `seq`, never created_at: now() is transaction-start time, so two
// changes made in one transaction carry identical timestamps and would sort
// arbitrarily. seq is monotonic, so the story reads in the order it happened.
//
// This history NEVER re-prices anything. Past shifts carry their own snapshot
// rate (TimeEntry.hourly_rate) — that is what makes payroll history stable, and
// this list is here to explain the numbers, not to feed them.

export function WageHistoryDialog({ technician, supabase, onClose }: {
  technician: Technician
  supabase: SupabaseClient
  onClose: () => void
}) {
  const [rows, setRows] = useState<WageHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('wage_history').select('*')
      .eq('technician_id', technician.id)
      .order('seq', { ascending: false })
    if (error) setError(error.message)
    else setRows((data as WageHistoryEntry[]) ?? [])
    setLoading(false)
  }, [supabase, technician.id])

  useEffect(() => { load() }, [load])

  const current = technician.hourly_wage == null ? null : Number(technician.hourly_wage)
  const first = useMemo(() => rows[rows.length - 1]?.new_wage, [rows])
  const growth = useMemo(() => {
    if (current == null || first == null || Number(first) <= 0) return null
    return Math.round(((current - Number(first)) / Number(first)) * 1000) / 10
  }, [current, first])

  return (
    <Modal open onClose={onClose} title={`${technician.name} — wage history`} icon={History} size="md"
      footer={<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>}>
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-bg-tertiary px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Current rate</p>
            <p className="text-xl font-bold text-ink tabular-nums mt-0.5">
              {current == null ? 'No wage set' : `${formatCurrency(current)}/hr`}
            </p>
          </div>
          {growth != null && growth !== 0 && (
            <span className={cn('text-xs font-semibold tabular-nums flex items-center gap-1',
              growth > 0 ? 'text-emerald-400' : 'text-red-400')}>
              {growth > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {growth > 0 ? '+' : ''}{growth}% since start
            </span>
          )}
        </div>

        {error && <Banner tone="danger" icon={AlertTriangle}>{error}</Banner>}

        {loading ? <SkeletonRows count={3} /> : rows.length === 0 ? (
          <InlineEmpty icon={History}>
            No wage changes recorded yet. Changes are logged automatically from now on.
          </InlineEmpty>
        ) : (
          <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
            {rows.map(r => {
              const from = r.old_wage == null ? null : Number(r.old_wage)
              const to = r.new_wage == null ? null : Number(r.new_wage)
              const up = from != null && to != null && to > from
              const down = from != null && to != null && to < from
              return (
                <div key={r.id} className="px-3.5 py-2.5 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink tabular-nums">
                      {from == null ? (
                        <span className="font-semibold">{to == null ? 'Wage cleared' : `${formatCurrency(to)}/hr`}</span>
                      ) : (
                        <>
                          <span className="text-ink-faint">{formatCurrency(from)}</span>
                          <span className="text-ink-faint mx-1.5">→</span>
                          <span className="font-semibold">{to == null ? 'cleared' : formatCurrency(to)}</span>
                          <span className="text-ink-faint">/hr</span>
                        </>
                      )}
                    </p>
                    <p className="text-[11px] text-ink-faint tabular-nums">
                      {format(new Date(r.created_at), 'MMM d, yyyy · h:mm a')}
                      {r.note && ` · ${r.note}`}
                    </p>
                  </div>
                  {(up || down) && from != null && to != null && (
                    <span className={cn('text-xs font-semibold tabular-nums shrink-0', up ? 'text-emerald-400' : 'text-red-400')}>
                      {up ? '+' : ''}{Math.round(((to - from) / from) * 1000) / 10}%
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <Banner tone="info" icon={Info}>
          Changing someone’s rate only affects their <span className="font-semibold">next</span> clock-in.
          Shifts already worked keep the rate they were clocked in at, so payroll history never moves.
        </Banner>
      </div>
    </Modal>
  )
}
