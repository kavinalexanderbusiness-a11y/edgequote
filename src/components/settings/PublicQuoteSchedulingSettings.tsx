'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarCheck2, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

type PublicSchedulingConfig = {
  enabled?: boolean
  minimum_notice_days?: number
  booking_window_days?: number
  travel_buffer_minutes_per_visit?: number
}

type SettingsRow = {
  preferred_work_days: number[] | null
  daily_capacity_hours: number | null
  default_crew_size: number | null
  module_meta: Record<string, unknown> | null
}

function configFrom(row: SettingsRow | null): PublicSchedulingConfig {
  const raw = row?.module_meta?.public_quote_scheduling
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as PublicSchedulingConfig
    : {}
}

export function PublicQuoteSchedulingSettings() {
  const supabase = useMemo(() => createClient(), [])
  const [row, setRow] = useState<SettingsRow | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [notice, setNotice] = useState('')
  const [windowDays, setWindowDays] = useState('')
  const [buffer, setBuffer] = useState('')
  const [crew, setCrew] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      const { data, error } = await supabase.from('business_settings')
        .select('preferred_work_days,daily_capacity_hours,default_crew_size,module_meta')
        .maybeSingle()
      if (!alive) return
      if (error || !data) {
        toast.error('Could not load public scheduling settings.')
        setLoading(false)
        return
      }
      const next = data as SettingsRow
      const cfg = configFrom(next)
      setRow(next)
      setEnabled(cfg.enabled === true)
      setNotice(Number.isFinite(Number(cfg.minimum_notice_days)) ? String(cfg.minimum_notice_days) : '')
      setWindowDays(Number.isFinite(Number(cfg.booking_window_days)) ? String(cfg.booking_window_days) : '')
      setBuffer(Number.isFinite(Number(cfg.travel_buffer_minutes_per_visit)) ? String(cfg.travel_buffer_minutes_per_visit) : '')
      setCrew(next.default_crew_size && next.default_crew_size > 0 ? String(next.default_crew_size) : '')
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [supabase])

  const parsed = {
    notice: Number(notice), window: Number(windowDays), buffer: Number(buffer), crew: Number(crew),
  }
  const valid = Number.isInteger(parsed.notice) && parsed.notice >= 0 && parsed.notice <= 30
    && Number.isInteger(parsed.window) && parsed.window >= 1 && parsed.window <= 60
    && Number.isInteger(parsed.buffer) && parsed.buffer >= 0 && parsed.buffer <= 240
    && Number.isInteger(parsed.crew) && parsed.crew >= 1 && parsed.crew <= 50

  async function save() {
    if (!valid || saving) return
    setSaving(true)
    const { data, error } = await supabase.rpc('configure_public_quote_scheduling', {
      p_enabled: enabled,
      p_minimum_notice_days: parsed.notice,
      p_booking_window_days: parsed.window,
      p_travel_buffer_minutes: parsed.buffer,
      p_default_crew_size: parsed.crew,
    })
    setSaving(false)
    const state = data && typeof data === 'object' && !Array.isArray(data)
      ? String((data as Record<string, unknown>).state || '') : ''
    if (error || state !== 'saved') {
      toast.error('Could not save public scheduling rules. Nothing changed.')
      return
    }
    setRow(prev => prev ? { ...prev, default_crew_size: parsed.crew } : prev)
    toast.success(enabled ? 'Customer self-scheduling rules are active.' : 'Customer self-scheduling is off.')
  }

  const calendarReady = (row?.preferred_work_days?.length ?? 0) > 0
    && Number(row?.daily_capacity_hours || 0) > 0

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
            <CalendarCheck2 className="w-4 h-4 text-accent-text" /> Customer self-scheduling
          </h2>
          <p className="text-xs text-ink-faint mt-0.5">
            After a customer accepts the written quote and pays its configured deposit, show only dates that still fit your live EdgeHQ schedule.
          </p>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-4 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
          <span>
            <span className="block text-sm font-semibold text-ink">Let eligible customers choose a date</span>
            <span className="block text-xs text-ink-muted mt-0.5">Each quote still needs your route, duration and crew approval. Blocked, cancelled and full days stay hidden.</span>
          </span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Minimum notice (days)" type="number" min="0" max="30" step="1" value={notice}
            onChange={e => setNotice(e.target.value)} hint="0 allows the current day when capacity remains." />
          <Input label="Booking window (days)" type="number" min="1" max="60" step="1" value={windowDays}
            onChange={e => setWindowDays(e.target.value)} hint="How far ahead eligible customers may choose." />
          <Input label="Travel/setup buffer per visit" type="number" min="0" max="240" step="5" value={buffer}
            onChange={e => setBuffer(e.target.value)} hint="Minutes reserved around every scheduled job." />
          <Input label="Default available crew" type="number" min="1" max="50" step="1" value={crew}
            onChange={e => setCrew(e.target.value)} hint="A day override on Schedule can replace this." />
        </div>

        <div className={`rounded-xl border px-4 py-3 text-xs ${calendarReady ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300' : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-300'}`}>
          {calendarReady
            ? `${row?.preferred_work_days?.length} booking day${row?.preferred_work_days?.length === 1 ? '' : 's'} selected · ${row?.daily_capacity_hours} labour-hours daily capacity.`
            : 'Choose preferred work days and daily capacity in Scheduling before dates can appear publicly.'}
          <Link href="/dashboard/settings#scheduling" className="ml-2 inline-flex items-center gap-1 underline underline-offset-2">
            Scheduling settings <ExternalLink className="w-3 h-3" />
          </Link>
        </div>

        {!loading && !valid && (
          <p className="text-xs text-amber-400">Complete all four rules within the limits shown before saving.</p>
        )}
        <div className="flex justify-end">
          <Button type="button" onClick={save} loading={saving} disabled={loading || !valid || saving}>
            Save scheduling rules
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
