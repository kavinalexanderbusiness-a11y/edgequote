'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { FilterPill } from '@/components/ui/FilterPill'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { PERIOD_PRESETS, type Period } from '@/lib/sales/analytics'
import { CalendarDays } from 'lucide-react'

// ── The date filter ──────────────────────────────────────────────────────────
// The period lives in the URL, not in component state, so the page stays a
// SERVER component: changing the range is a navigation that re-runs the one
// query batch, and the result is shareable and back-button-correct. The only
// client JS here is the custom-range form.

export function PeriodFilter({ period }: { period: Period }) {
  const router = useRouter()
  const params = useSearchParams()
  const [open, setOpen] = useState(period.key === 'custom')
  const [from, setFrom] = useState(period.from)
  const [to, setTo] = useState(period.to)

  const go = (next: URLSearchParams) => router.push(`/dashboard/sales?${next.toString()}`)

  const pick = (key: string) => {
    const next = new URLSearchParams(params.toString())
    next.set('period', key)
    next.delete('from'); next.delete('to')
    setOpen(false)
    go(next)
  }

  const applyCustom = () => {
    if (!from || !to) return
    const next = new URLSearchParams(params.toString())
    next.set('period', 'custom'); next.set('from', from); next.set('to', to)
    go(next)
  }

  return (
    <div className="space-y-3">
      {/* Scrolls rather than wraps on a phone — four pills plus a date range do
          not fit at 375px, and a wrapped row pushes the numbers below the fold. */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5">
        {PERIOD_PRESETS.map(p => (
          <FilterPill key={p.key} active={period.key === p.key} onClick={() => pick(p.key)}>
            {p.label}
          </FilterPill>
        ))}
        <FilterPill active={period.key === 'custom'} onClick={() => setOpen(o => !o)}>
          <CalendarDays className="w-3.5 h-3.5" />
          {period.key === 'custom' ? period.label : 'Custom'}
        </FilterPill>
      </div>

      {open && (
        <div className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3">
          <label className="text-[11px] text-ink-muted">
            <span className="block mb-1">From</span>
            <Input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="w-auto" />
          </label>
          <label className="text-[11px] text-ink-muted">
            <span className="block mb-1">To</span>
            <Input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="w-auto" />
          </label>
          {/* ⚠️ type="button": inside a form a bare <button> submits and reloads
              the page before the router ever runs. */}
          <Button type="button" onClick={applyCustom} disabled={!from || !to}>Apply</Button>
        </div>
      )}
    </div>
  )
}
