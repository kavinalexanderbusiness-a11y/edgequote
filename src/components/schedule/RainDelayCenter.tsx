'use client'

import { useEffect, useMemo, useState } from 'react'
import { addDays, format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Job, JobRecurrence } from '@/types'
import { Coord } from '@/lib/geo'
import { planRainDelay, OptJob } from '@/lib/optimizer'
import type { DayStatusMap } from '@/lib/dayStatus'
import { DEFAULT_JOB_MIN } from '@/lib/route'
import {
  DisruptionReason, DISRUPTION_META, DISRUPTION_REASONS,
  DestinationStrategy, STRATEGY_META, STRATEGIES, resolveDestination,
} from '@/lib/disruption'
import { renderMessage, MsgType } from '@/lib/comms/templates'
import { SmsCost } from '@/components/comms/SmsCost'
import { localTodayISO, formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import {
  CloudRain, X, ArrowRight, Check, Clock, AlertTriangle, Repeat, Users, DollarSign,
  MessageSquare, Mail, Send, CalendarClock, ShieldCheck,
} from 'lucide-react'

interface Props {
  jobs: Job[]
  recurrences: Record<string, JobRecurrence>
  valueByJobId: Record<string, number>
  baseCoord: Coord | null
  preferredWorkDays: number[]
  capacityHours: number
  dayStatusMap?: DayStatusMap
  capacityForDate?: (dateISO: string) => number
  onApply: (moves: { jobId: string; from: string; to: string }[]) => Promise<void>
  onClose: () => void
}

interface Move { jobId: string; customerId: string | null; customerName: string; from: string; to: string; value: number; recurring: boolean; hasSetTime: boolean }
interface TargetImpact { date: string; beforeHours: number; afterHours: number; added: number; overCapacity: boolean; utilizationPct: number }
interface Recipient { customerId: string; name: string; from: string; to: string; jobId: string }

// 🌧 Weather Operations hub (also handles equipment / absence / holiday / emergency
// disruptions — same machinery). Pick the affected day + jobs, choose how to move
// them (tomorrow / next work day / specific date / auto-optimize), see the labor,
// capacity and revenue impact, apply in one tap (with Undo), and notify the
// affected customers — all reusing planRainDelay, the disruption seam and the
// existing comms pipeline. No second scheduler, rain engine or notifier.
export function RainDelayCenter({ jobs, recurrences, valueByJobId, baseCoord, preferredWorkDays, capacityHours, dayStatusMap, capacityForDate, onApply, onClose }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const today = localTodayISO()
  const [invoicedIds, setInvoicedIds] = useState<Set<string> | null>(null)
  const [reason, setReason] = useState<DisruptionReason>('weather')
  const [selectedDay, setSelectedDay] = useState<string>(format(addDays(parseISO(today), 1), 'yyyy-MM-dd'))
  const [strategy, setStrategy] = useState<DestinationStrategy>('auto_optimize')
  const [specificDate, setSpecificDate] = useState<string>(format(addDays(parseISO(today), 2), 'yyyy-MM-dd'))
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)

  // Customer notifications
  const [notify, setNotify] = useState(true)
  const [recipientIds, setRecipientIds] = useState<Set<string>>(new Set())
  const [channels, setChannels] = useState<{ sms: boolean; email: boolean }>({ sms: true, email: true })
  const [sending, setSending] = useState(false)
  const [sendResults, setSendResults] = useState<{ name: string; ok: boolean; text: string }[] | null>(null)
  // Snapshot of what was moved, captured at Apply time — the moved jobs leave the
  // selected day, so the planning data is gone once applied; this drives the
  // post-apply confirmation + notification view.
  const [result, setResult] = useState<{ moved: number; recipients: Recipient[] } | null>(null)
  const [custom, setCustom] = useState<Partial<Record<MsgType, string>> | null>(null)
  const [company, setCompany] = useState('Edge Property Services')

  useEffect(() => {
    let active = true
    ;(async () => {
      const [iRes, { data: { user } }] = await Promise.all([
        supabase.from('invoices').select('job_id').not('job_id', 'is', null),
        supabase.auth.getUser(),
      ])
      if (!active) return
      setInvoicedIds(new Set(((iRes.data as { job_id: string }[]) || []).map(r => r.job_id)))
      if (user) {
        const { data } = await supabase.from('business_settings').select('company_name, message_templates').eq('user_id', user.id).maybeSingle()
        const d = data as { company_name: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
        if (d?.company_name) setCompany(d.company_name)
        setCustom(d?.message_templates || {})
      }
    })()
    return () => { active = false }
  }, [supabase])

  const fmtDay = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  const fmtLong = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEEE, MMM d')

  const optJobs = useMemo<OptJob[]>(() => jobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status,
    recurrence_id: j.recurrence_id, start_time: j.start_time, duration_minutes: j.duration_minutes,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    value: valueByJobId[j.id] || 0, invoiced: invoicedIds?.has(j.id) ?? false,
    title: j.title, customerName: j.customers?.name || j.title, customerId: j.customer_id,
    serviceType: j.service_type,
  })), [jobs, valueByJobId, invoicedIds])

  const recs = useMemo(() => {
    const m: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
    for (const [id, r] of Object.entries(recurrences)) m[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    return m
  }, [recurrences])

  // The affected day's active jobs, split movable vs locked (billed).
  const dayJobs = useMemo(() => jobs.filter(j => j.scheduled_date === selectedDay && j.status !== 'cancelled' && j.status !== 'completed'), [jobs, selectedDay])
  const movable = useMemo(() => dayJobs.filter(j => !(invoicedIds?.has(j.id))), [dayJobs, invoicedIds])
  const billed = useMemo(() => dayJobs.filter(j => invoicedIds?.has(j.id)), [dayJobs, invoicedIds])

  // Reset selection when the day or billed set changes — default = move everything.
  useEffect(() => {
    setSelectedJobIds(new Set(movable.map(j => j.id)))
    setApplied(false); setSendResults(null)
  }, [selectedDay, movable.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const durMin = (j: Job) => j.duration_minutes || DEFAULT_JOB_MIN
  const capMin = (capacityHours > 0 ? capacityHours : 8) * 60

  // The next few candidate affected days (today → +3) with their load.
  const dayChips = useMemo(() => [0, 1, 2, 3].map(n => {
    const date = format(addDays(parseISO(today), n), 'yyyy-MM-dd')
    const dj = jobs.filter(j => j.scheduled_date === date && j.status !== 'cancelled' && j.status !== 'completed')
    return {
      date, label: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : format(parseISO(date + 'T00:00:00'), 'EEE, MMM d'),
      jobs: dj.length, revenue: Math.round(dj.reduce((s, j) => s + (valueByJobId[j.id] || 0), 0)),
      hours: Math.round((dj.reduce((s, j) => s + durMin(j), 0) / 60) * 10) / 10,
    }
  }), [jobs, valueByJobId, today]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build the move plan + per-day capacity impact from the chosen strategy.
  const plan = useMemo(() => {
    if (invoicedIds === null) return null
    const selMovable = movable.filter(j => selectedJobIds.has(j.id))
    let moves: Move[] = []
    let targets: TargetImpact[] = []
    const unmovable: { jobId: string; customerName: string; reason: string }[] = billed.map(j => ({ jobId: j.id, customerName: j.customers?.name || j.title, reason: 'already invoiced' }))

    if (strategy === 'auto_optimize') {
      const rp = planRainDelay(optJobs, selectedDay, { today, base: baseCoord, preferredDays: preferredWorkDays, capacityHours, recurrences: recs, dayStatusMap, capacityForDate })
      const sel = new Set(selMovable.map(j => j.id))
      moves = rp.moves.filter(m => sel.has(m.jobId)).map(m => ({
        jobId: m.jobId, customerId: (optJobs.find(o => o.id === m.jobId)?.customerId) ?? null,
        customerName: m.customerName, from: m.from, to: m.to, value: m.value, recurring: m.recurring, hasSetTime: m.hasSetTime,
      }))
      const movedByDay: Record<string, number> = {}
      for (const m of moves) movedByDay[m.to] = (movedByDay[m.to] || 0) + 1
      targets = rp.targets.filter(t => movedByDay[t.date]).map(t => ({
        date: t.date, beforeHours: round1(t.beforeMin / 60), afterHours: round1(t.afterMin / 60),
        added: movedByDay[t.date], overCapacity: t.overCapacity, utilizationPct: Math.round((t.afterMin / capMin) * 100),
      }))
      for (const u of rp.unmovable) if (!billed.some(b => b.id === u.jobId)) unmovable.push({ jobId: u.jobId, customerName: u.customerName, reason: u.reason })
    } else {
      const to = resolveDestination(strategy, selectedDay, { preferredDays: preferredWorkDays, specificDate })
      if (to) {
        moves = selMovable.filter(j => j.scheduled_date !== to).map(j => ({
          jobId: j.id, customerId: j.customer_id, customerName: j.customers?.name || j.title,
          from: selectedDay, to, value: valueByJobId[j.id] || 0, recurring: !!j.recurrence_id, hasSetTime: !!j.start_time,
        }))
        const existing = jobs.filter(j => j.scheduled_date === to && j.status !== 'cancelled' && j.status !== 'completed')
        const beforeMin = existing.reduce((s, j) => s + durMin(j), 0)
        const addedMin = moves.reduce((s, m) => s + (jobs.find(j => j.id === m.jobId) ? durMin(jobs.find(j => j.id === m.jobId)!) : DEFAULT_JOB_MIN), 0)
        targets = moves.length ? [{
          date: to, beforeHours: round1(beforeMin / 60), afterHours: round1((beforeMin + addedMin) / 60),
          added: moves.length, overCapacity: beforeMin + addedMin > capMin, utilizationPct: Math.round(((beforeMin + addedMin) / capMin) * 100),
        }] : []
      }
    }

    const movedValue = moves.reduce((s, m) => s + m.value, 0)
    const stuckValue = unmovable.reduce((s, u) => s + (valueByJobId[u.jobId] || 0), 0)
    const affectedRevenue = dayJobs.reduce((s, j) => s + (valueByJobId[j.id] || 0), 0)
    const affectedHours = round1(dayJobs.reduce((s, j) => s + durMin(j), 0) / 60)
    const customersAffected = new Set(moves.map(m => m.customerId).filter(Boolean)).size
    return { moves, targets, unmovable, movedValue, stuckValue, affectedRevenue, affectedHours, customersAffected }
  }, [invoicedIds, movable, selectedJobIds, strategy, specificDate, optJobs, selectedDay, baseCoord, preferredWorkDays, capacityHours, recs, billed, jobs, valueByJobId, dayJobs, capMin]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recipients = one per affected customer (their soonest move's dates).
  const recipients = useMemo<Recipient[]>(() => {
    if (!plan) return []
    const byCust = new Map<string, Recipient>()
    for (const m of plan.moves) {
      if (!m.customerId || byCust.has(m.customerId)) continue
      byCust.set(m.customerId, { customerId: m.customerId, name: m.customerName, from: m.from, to: m.to, jobId: m.jobId })
    }
    return [...byCust.values()]
  }, [plan])

  // Default-select all recipients while still planning; once applied, the live
  // recipients collapse to none (jobs moved away) — keep the chosen set frozen.
  useEffect(() => { if (!applied) setRecipientIds(new Set(recipients.map(r => r.customerId))) }, [recipients, applied])

  function toggleJob(id: string) {
    setSelectedJobIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleRecipient(id: string) {
    setRecipientIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const template = DISRUPTION_META[reason].template
  // Representative preview (each customer gets their own name + dates filled in).
  const previewText = useMemo(() => {
    const r = recipients[0]
    return renderMessage(template, custom, {
      firstName: r?.name || 'there', businessName: company,
      dateLabel: r ? fmtDay(r.to) : '{date}', oldDateLabel: r ? fmtDay(r.from) : '{old date}',
    }).sms
  }, [recipients, template, custom, company]) // eslint-disable-line react-hooks/exhaustive-deps

  async function notifyRecipients(list: Recipient[]) {
    const chans = (['sms', 'email'] as const).filter(c => channels[c])
    if (!chans.length) return
    setSending(true)
    const results: { name: string; ok: boolean; text: string }[] = []
    for (const r of list.filter(x => recipientIds.has(x.customerId))) {
      try {
        const res = await fetch('/api/comms/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: r.customerId, template, jobId: r.jobId, channels: chans, vars: { dateLabel: fmtDay(r.to), oldDateLabel: fmtDay(r.from) } }),
        })
        results.push({ name: r.name, ...summarizeSend(await res.json()) })
      } catch (e) {
        results.push({ name: r.name, ok: false, text: e instanceof Error ? e.message : 'failed' })
      }
    }
    setSendResults(results)
    setSending(false)
  }

  async function apply() {
    if (!plan || plan.moves.length === 0) return
    const snapshot = { moved: plan.moves.length, recipients }
    setApplying(true)
    await onApply(plan.moves.map(m => ({ jobId: m.jobId, from: m.from, to: m.to })))
    setResult(snapshot)
    setApplied(true)
    if (notify && snapshot.recipients.length) { await notifyRecipients(snapshot.recipients) }
    setApplying(false)
    if (!notify || !snapshot.recipients.length) onClose()
  }

  const strategyTargetLabel = strategy === 'auto_optimize'
    ? 'best work days (capacity-aware)'
    : (() => { const to = resolveDestination(strategy, selectedDay, { preferredDays: preferredWorkDays, specificDate }); return to ? fmtDay(to) : 'pick a date' })()

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <Card className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CloudRain className="w-4 h-4 text-sky-400" /> Weather Operations</h2>
            <button onClick={onClose} className="w-9 h-9 -mr-2 flex items-center justify-center text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
          </div>
          <CardBody className="space-y-4">
            {applied && result ? (
              /* Post-apply confirmation + customer notification */
              <div className="space-y-4">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-4 py-3 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <p className="text-sm font-semibold text-ink">Moved {result.moved} job{result.moved !== 1 ? 's' : ''} · Undo available on the schedule</p>
                </div>
                {result.recipients.length > 0 ? (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="px-3 py-2 bg-bg-tertiary border-b border-border flex items-center gap-2">
                      <MessageSquare className="w-3.5 h-3.5 text-accent" />
                      <span className="text-xs font-semibold text-ink">Notify {result.recipients.length} affected customer{result.recipients.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="p-3 space-y-2.5">
                      <div className="flex items-center gap-1.5">
                        <Chip label="SMS" icon={MessageSquare} on={channels.sms} onClick={() => setChannels(c => ({ ...c, sms: !c.sms }))} />
                        <Chip label="Email" icon={Mail} on={channels.email} onClick={() => setChannels(c => ({ ...c, email: !c.email }))} />
                        <span className="ml-auto text-[10px] text-ink-faint">opt-in customers only</span>
                      </div>
                      <div className="max-h-36 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                        {result.recipients.map(r => (
                          <label key={r.customerId} className="px-3 py-1.5 flex items-center gap-2 text-xs cursor-pointer hover:bg-surface/40">
                            <input type="checkbox" checked={recipientIds.has(r.customerId)} onChange={() => toggleRecipient(r.customerId)} className="accent-accent w-3.5 h-3.5" />
                            <span className="font-medium text-ink truncate flex-1">{r.name}</span>
                            <span className="text-ink-faint shrink-0">{fmtDay(r.from)} → {fmtDay(r.to)}</span>
                          </label>
                        ))}
                      </div>
                      <Button size="sm" variant="secondary" onClick={() => notifyRecipients(result.recipients)} loading={sending} disabled={recipientIds.size === 0}>
                        <Send className="w-3.5 h-3.5" /> {sendResults ? 'Re-send' : 'Send'} to {recipientIds.size} selected
                      </Button>
                      {sendResults && (
                        <div className="space-y-1">
                          {sendResults.map((s, i) => (
                            <p key={i} className={cn('text-[11px] flex items-center gap-1.5', s.ok ? 'text-emerald-400' : 'text-amber-400')}>
                              {s.ok ? <Check className="w-3 h-3 shrink-0" /> : <AlertTriangle className="w-3 h-3 shrink-0" />}<span className="font-medium">{s.name}:</span> {s.text}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-ink-muted">No customers to notify (the moved jobs aren&apos;t linked to a customer).</p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={onClose}><Check className="w-4 h-4" /> Done</Button>
                </div>
              </div>
            ) : (
            <>
            {/* Reason */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">Why are jobs moving?</p>
              <div className="flex flex-wrap gap-1.5">
                {DISRUPTION_REASONS.map(rk => (
                  <button key={rk} onClick={() => setReason(rk)}
                    className={cn('text-xs font-medium rounded-full px-2.5 py-1 border transition-colors',
                      reason === rk ? 'border-accent bg-accent/15 text-accent' : 'border-border text-ink-muted hover:text-ink')}>
                    {DISRUPTION_META[rk].emoji} {DISRUPTION_META[rk].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Which day is affected? */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">Affected day</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {dayChips.map(c => (
                  <button key={c.date} onClick={() => setSelectedDay(c.date)}
                    className={cn('rounded-xl border p-2.5 text-left transition-colors',
                      selectedDay === c.date ? 'border-sky-400/60 bg-sky-400/10' : 'border-border-strong bg-surface hover:border-sky-400/40')}>
                    <p className="text-sm font-semibold text-ink">{c.label}</p>
                    <p className="text-[11px] text-ink-muted mt-0.5">{c.jobs === 0 ? 'No jobs' : `${c.jobs} job${c.jobs !== 1 ? 's' : ''} · ${c.hours}h · ${formatCurrency(c.revenue)}`}</p>
                  </button>
                ))}
              </div>
            </div>

            {invoicedIds === null && <p className="text-xs text-ink-faint text-center py-2">Checking billed jobs…</p>}

            {invoicedIds !== null && dayJobs.length === 0 && (
              <p className="text-sm text-ink-muted text-center py-6">Nothing scheduled on {fmtLong(selectedDay)} — no move needed.</p>
            )}

            {plan && dayJobs.length > 0 && (
              <>
                {/* Affected summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Stat icon={CalendarClock} label="Jobs" value={String(dayJobs.length)} />
                  <Stat icon={Clock} label="Labor" value={`${plan.affectedHours}h`} />
                  <Stat icon={DollarSign} label="At stake" value={formatCurrency(plan.affectedRevenue)} tone="text-sky-300" />
                  <Stat icon={Users} label="Customers" value={String(new Set(dayJobs.map(j => j.customer_id).filter(Boolean)).size)} />
                </div>

                {/* Select which jobs to move */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <div className="px-3 py-2 flex items-center justify-between bg-bg-tertiary border-b border-border">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Jobs to move ({selectedJobIds.size}/{movable.length})</span>
                    <div className="flex items-center gap-2 text-[11px]">
                      <button onClick={() => setSelectedJobIds(new Set(movable.map(j => j.id)))} className="text-accent hover:underline font-medium">All</button>
                      <button onClick={() => setSelectedJobIds(new Set())} className="text-ink-faint hover:text-ink">None</button>
                    </div>
                  </div>
                  <div className="max-h-44 overflow-y-auto divide-y divide-border">
                    {movable.map(j => (
                      <label key={j.id} className="px-3 py-2 flex items-center gap-2.5 text-xs cursor-pointer hover:bg-surface/40">
                        <input type="checkbox" checked={selectedJobIds.has(j.id)} onChange={() => toggleJob(j.id)} className="accent-accent w-3.5 h-3.5" />
                        <span className="min-w-0 flex-1 flex items-center gap-1.5">
                          {j.recurrence_id && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}
                          <span className="font-medium text-ink truncate">{j.customers?.name || j.title}</span>
                          {j.start_time && <span className="text-[10px] font-semibold uppercase text-amber-400 shrink-0">set time</span>}
                        </span>
                        <span className="text-ink-faint shrink-0">{formatCurrency(valueByJobId[j.id] || 0)}</span>
                      </label>
                    ))}
                    {billed.map(j => (
                      <div key={j.id} className="px-3 py-2 flex items-center gap-2.5 text-xs opacity-50">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="min-w-0 flex-1 font-medium text-ink truncate">{j.customers?.name || j.title}</span>
                        <span className="text-[10px] uppercase text-ink-faint shrink-0">billed · stays</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destination strategy */}
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">Move them to</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {STRATEGIES.map(s => (
                      <button key={s} onClick={() => setStrategy(s)}
                        className={cn('rounded-xl border p-2.5 text-left transition-colors',
                          strategy === s ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface hover:border-accent/40')}>
                        <p className="text-xs font-semibold text-ink">{STRATEGY_META[s].label}</p>
                        <p className="text-[10px] text-ink-faint mt-0.5 leading-tight">{STRATEGY_META[s].hint}</p>
                      </button>
                    ))}
                  </div>
                  {strategy === 'specific_date' && (
                    <input type="date" value={specificDate} min={format(addDays(parseISO(today), 1), 'yyyy-MM-dd')} onChange={e => setSpecificDate(e.target.value)}
                      className="mt-2 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                  )}
                </div>

                {/* Capacity impact per destination day */}
                {plan.targets.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint bg-bg-tertiary border-b border-border">Crew capacity impact</p>
                    <div className="divide-y divide-border">
                      {plan.targets.map(t => (
                        <div key={t.date} className="px-3 py-2.5 flex items-center gap-3 text-xs">
                          <span className="font-semibold text-ink w-28 shrink-0">{fmtDay(t.date)}</span>
                          <span className="text-ink-muted">{t.beforeHours}h</span>
                          <ArrowRight className="w-3 h-3 text-accent shrink-0" />
                          <span className={cn('font-semibold', t.overCapacity ? 'text-amber-400' : 'text-ink')}>{t.afterHours}h · +{t.added} job{t.added !== 1 ? 's' : ''}</span>
                          <span className={cn('ml-auto text-[10px] font-semibold uppercase', t.overCapacity ? 'text-amber-400' : 'text-emerald-400')}>
                            {t.utilizationPct}% {t.overCapacity ? '· over' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="px-3 py-1.5 text-[10px] text-ink-faint border-t border-border">Capacity {capacityHours}h/day · utilization vs your daily limit.</p>
                  </div>
                )}

                {/* Revenue impact */}
                <div className="grid grid-cols-3 gap-2">
                  <Stat icon={DollarSign} label="Protected (moved)" value={formatCurrency(plan.movedValue)} tone="text-emerald-400" />
                  <Stat icon={AlertTriangle} label="Still exposed" value={formatCurrency(plan.stuckValue)} tone={plan.stuckValue > 0 ? 'text-amber-400' : undefined} />
                  <Stat icon={Users} label="Customers moved" value={String(plan.customersAffected)} />
                </div>

                {plan.unmovable.length > 0 && (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-400 flex items-center gap-1 mb-1"><AlertTriangle className="w-3 h-3" /> Can&apos;t be moved</p>
                    {plan.unmovable.slice(0, 5).map(u => <p key={u.jobId} className="text-[11px] text-ink-muted">• {u.customerName} — {u.reason}</p>)}
                  </div>
                )}

                {/* Customer notifications */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <label className="px-3 py-2.5 flex items-center gap-2.5 bg-bg-tertiary border-b border-border cursor-pointer">
                    <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} className="accent-accent w-4 h-4" />
                    <span className="text-xs font-semibold text-ink flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5 text-accent" /> Notify customers automatically</span>
                    <span className="ml-auto text-[10px] text-ink-faint">{recipients.length} customer{recipients.length !== 1 ? 's' : ''}</span>
                  </label>
                  {notify && (
                    <div className="p-3 space-y-2.5">
                      {/* Channels */}
                      <div className="flex items-center gap-1.5">
                        <Chip label="SMS" icon={MessageSquare} on={channels.sms} onClick={() => setChannels(c => ({ ...c, sms: !c.sms }))} />
                        <Chip label="Email" icon={Mail} on={channels.email} onClick={() => setChannels(c => ({ ...c, email: !c.email }))} />
                        <span className="ml-auto text-[10px] text-ink-faint">opt-in customers only</span>
                      </div>
                      {/* Review preview */}
                      <div className="rounded-lg border border-border bg-bg-secondary px-2.5 py-2">
                        <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Message preview (each customer gets their own name + dates)</p>
                        <SmsCost text={previewText} recipients={recipientIds.size} className="mb-2" />
                        <p className="text-xs text-ink whitespace-pre-wrap">{previewText}</p>
                      </div>
                      {/* Recipient selection */}
                      <div className="max-h-32 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                        {recipients.length === 0 ? (
                          <p className="px-3 py-2 text-[11px] text-ink-faint">Choose jobs to move to see who gets notified.</p>
                        ) : recipients.map(r => (
                          <label key={r.customerId} className="px-3 py-1.5 flex items-center gap-2 text-xs cursor-pointer hover:bg-surface/40">
                            <input type="checkbox" checked={recipientIds.has(r.customerId)} onChange={() => toggleRecipient(r.customerId)} className="accent-accent w-3.5 h-3.5" />
                            <span className="font-medium text-ink truncate flex-1">{r.name}</span>
                            <span className="text-ink-faint shrink-0">{fmtDay(r.from)} → {fmtDay(r.to)}</span>
                          </label>
                        ))}
                      </div>
                      <p className="text-[10px] text-ink-faint">Sent the moment you apply — logged to each customer&apos;s timeline + message center.</p>
                    </div>
                  )}
                </div>

                {/* Apply */}
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} loading={applying} disabled={plan.moves.length === 0}>
                    <Check className="w-4 h-4" /> {notify && recipients.length ? `Move ${plan.moves.length} & notify` : `Move ${plan.moves.length} job${plan.moves.length !== 1 ? 's' : ''}`}
                  </Button>
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <span className="ml-auto text-[11px] text-ink-faint truncate">→ {strategyTargetLabel}</span>
                </div>
              </>
            )}
            </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

const round1 = (n: number) => Math.round(n * 10) / 10

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Clock; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Icon className="w-3 h-3" /> {label}</p>
      <p className={cn('text-sm font-bold mt-0.5', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

function Chip({ label, icon: Icon, on, onClick }: { label: string; icon: typeof Mail; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('h-7 px-2 rounded-lg border text-[11px] font-medium flex items-center gap-1 transition-colors',
        on ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-ink-faint hover:text-ink')}>
      <Icon className="w-3 h-3" /> {label} {on && <Check className="w-3 h-3" />}
    </button>
  )
}

function summarizeSend(data: { results?: Record<string, { sent?: boolean; reason?: string; error?: string }> }): { ok: boolean; text: string } {
  const r = data.results || {}
  const sent = Object.entries(r).filter(([, v]) => v.sent).map(([ch]) => ch)
  if (sent.length) return { ok: true, text: `sent by ${sent.join(' & ')}` }
  const reasons = Object.values(r).map(v => v.reason)
  if (reasons.includes('no-optin')) return { ok: false, text: 'no opt-in' }
  if (reasons.includes('disabled')) return { ok: false, text: 'messaging off' }
  return { ok: false, text: 'not sent (no phone/email)' }
}
