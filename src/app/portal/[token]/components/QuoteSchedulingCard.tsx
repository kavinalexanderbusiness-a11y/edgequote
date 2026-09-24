'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarCheck2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'

type Result = { state?: string; dates?: { date: string }[]; date?: string; cadence?: string; recurrence_setup_required?: boolean }

function dayLabel(iso: string): string {
  const value = new Date(`${iso}T12:00:00`)
  return Number.isNaN(value.getTime()) ? iso : new Intl.DateTimeFormat('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(value)
}

export function QuoteSchedulingCard({ token, quoteId, quoteNumber, onScheduled }: {
  token: string; quoteId: string; quoteNumber: string; onScheduled: () => Promise<unknown>
}) {
  const [result, setResult] = useState<Result | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const response = await fetch('/api/portal/quote-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'availability', token, quoteId, days: 60 }),
      })
      const body = await response.json() as Result
      if (!response.ok) throw new Error('availability')
      setResult(body)
      setSelected(Array.isArray(body.dates) ? body.dates[0]?.date || '' : '')
    } catch {
      setError('Available dates could not be loaded. Please try again.')
    } finally { setLoading(false) }
  }, [quoteId, token])

  useEffect(() => { load() }, [load])

  async function schedule() {
    if (!selected || saving) return
    setSaving(true); setError(null)
    try {
      const response = await fetch('/api/portal/quote-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'schedule', token, quoteId, date: selected }),
      })
      const body = await response.json() as Result
      if (!response.ok || !['scheduled', 'already_scheduled'].includes(String(body.state))) {
        setResult(body); throw new Error('schedule')
      }
      setResult(body)
      await onScheduled()
    } catch {
      setError('That date is no longer available. Refresh the dates and choose another.')
    } finally { setSaving(false) }
  }

  if (loading) return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3 flex items-center gap-2 text-sm text-ink-muted">
      <Loader2 className="w-4 h-4 animate-spin" /> Checking live schedule for {quoteNumber}…
    </div>
  )
  if (error && !result) return (
    <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3">
      <p className="text-sm text-ink-muted">{error}</p>
      <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={load}>Try again</Button>
    </div>
  )

  const state = String(result?.state || '')
  if (state === 'already_scheduled' || state === 'scheduled') return (
    <div className="rounded-card border border-emerald-500/25 bg-emerald-500/[0.06] p-4 mt-3">
      <p className="text-sm font-semibold text-emerald-400 flex items-center gap-2"><CalendarCheck2 className="w-4 h-4" /> {result?.recurrence_setup_required ? 'First visit scheduled' : 'Visit scheduled'}</p>
      {result?.date && <p className="text-xs text-ink-muted mt-1">{dayLabel(result.date)}</p>}
      {result?.recurrence_setup_required && <p className="text-xs text-ink-muted mt-1">Your {result.cadence === 'biweekly' ? 'bi-weekly' : 'weekly'} price is per visit. Edge will confirm the remaining recurring dates after fitting them into the route.</p>}
    </div>
  )
  if (state !== 'ready') {
    const message = state === 'awaiting_deposit'
      ? 'Pay the scheduling deposit above to unlock available dates.'
      : state === 'no_dates'
        ? 'There are no online dates available right now. We’ll contact you to arrange a date.'
        : 'We’re confirming the work details and availability. We’ll contact you when booking is ready.'
    return <div className="rounded-card border border-border bg-bg-secondary p-4 mt-3"><p className="text-sm font-semibold text-ink">Schedule {quoteNumber}</p><p className="text-xs text-ink-muted mt-1">{message}</p></div>
  }

  const dates = (result?.dates || []).slice(0, 14)
  return (
    <div className="rounded-card border border-accent/25 bg-accent/[0.04] p-4 mt-3">
      <p className="text-sm font-semibold text-ink flex items-center gap-2"><CalendarCheck2 className="w-4 h-4 text-accent-text" /> Choose your service date</p>
      <p className="text-xs text-ink-muted mt-1">Dates reflect the live EdgeHQ schedule. Your visit is booked only after you confirm.</p>
      <div className="grid grid-cols-2 gap-2 mt-3">
        {dates.map(d => <button key={d.date} type="button" onClick={() => setSelected(d.date)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium text-left ${selected === d.date ? 'border-accent bg-accent/15 text-ink' : 'border-border bg-surface text-ink-muted hover:text-ink'}`}>{dayLabel(d.date)}</button>)}
      </div>
      {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
      <Button type="button" className="w-full mt-3" loading={saving} disabled={!selected || saving} onClick={schedule}>
        Book {selected ? dayLabel(selected) : 'selected date'}
      </Button>
    </div>
  )
}
