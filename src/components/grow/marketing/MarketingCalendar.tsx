'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Card } from '@/components/ui/Card'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { channel as channelDef } from '@/lib/marketing/channels'
import { listScheduledRange, listUnscheduledDrafts, setSchedule, markPublished, setStatus } from '@/lib/marketing/library'
import { upcomingHolidays, upcomingSeasonReminders } from '@/lib/marketing/holidays'
import { PublishingHub } from './PublishingHub'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, CalendarDays, CalendarRange, Calendar as CalIcon, Sparkles, CalendarPlus, Send, ExternalLink, Copy, Check, X, CircleCheck, Clock, FileText, TriangleAlert, GripVertical } from 'lucide-react'
import type { ContentPiece, ContentStatus, MarketingChannel } from '@/lib/marketing/types'

type View = 'month' | 'week' | 'day'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function key(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function startOfWeek(d: Date): Date { return addDays(d, -d.getDay()) }
function sameMonth(a: Date, b: Date): boolean { return a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() }

// The day a piece "lives on" in the calendar: its schedule, else when it was posted.
function pieceDayKey(p: ContentPiece): string | null {
  const ts = p.scheduled_for || p.published_at
  return ts ? ts.slice(0, 10) : null
}

const STATUS_META: Record<ContentStatus, { label: string; dot: string; chip: string }> = {
  draft:     { label: 'Draft',     dot: 'bg-ink-faint',    chip: 'border-border text-ink-muted' },
  approved:  { label: 'Ready',     dot: 'bg-sky-400',      chip: 'border-sky-500/30 text-sky-300' },
  scheduled: { label: 'Scheduled', dot: 'bg-accent',       chip: 'border-accent/40 text-accent' },
  published: { label: 'Posted',    dot: 'bg-emerald-400',  chip: 'border-emerald-500/30 text-emerald-300' },
  failed:    { label: 'Failed',    dot: 'bg-red-400',      chip: 'border-red-500/30 text-red-300' },
}

export function MarketingCalendar({ userId, aiEnabled, openPlan }: { userId: string; aiEnabled: boolean; openPlan?: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [view, setView] = useState<View>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [pieces, setPieces] = useState<ContentPiece[]>([])
  const [drafts, setDrafts] = useState<ContentPiece[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ContentPiece | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(!!openPlan)
  const [hubOpen, setHubOpen] = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)

  const todayKey = key(new Date())

  // The visible date window for the current view.
  const range = useMemo(() => {
    if (view === 'day') return { from: new Date(cursor), to: new Date(cursor) }
    if (view === 'week') { const s = startOfWeek(cursor); return { from: s, to: addDays(s, 6) } }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const gridStart = startOfWeek(first)
    return { from: gridStart, to: addDays(gridStart, 41) }
  }, [view, cursor])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const fromISO = `${key(range.from)}T00:00:00.000Z`
    const toISO = `${key(range.to)}T23:59:59.999Z`
    const [scheduled, tray] = await Promise.all([
      listScheduledRange(supabase, userId, fromISO, toISO).catch(() => [] as ContentPiece[]),
      listUnscheduledDrafts(supabase, userId).catch(() => [] as ContentPiece[]),
    ])
    setPieces(scheduled)
    setDrafts(tray)
    setLoading(false)
  }, [supabase, userId, range.from, range.to])

  useEffect(() => { load() }, [load])

  // Process this owner's due scheduled posts once when the calendar opens, then refresh
  // IN PLACE (silent) — no paid cron required, and no jarring skeleton flash. Idempotent.
  const processedRef = useRef(false)
  useEffect(() => {
    if (processedRef.current) return
    processedRef.current = true
    fetch('/api/marketing/publish/process', { method: 'POST' }).then(() => load(true)).catch(() => {})
  }, [load])

  // On mobile the detail panel stacks below the grid — bring it into view when a chip
  // is tapped so the tap gives a visible response instead of silently changing off-screen.
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Bucket pieces by day.
  const byDay = useMemo(() => {
    const m = new Map<string, ContentPiece[]>()
    for (const p of pieces) {
      const k = pieceDayKey(p)
      if (!k) continue
      const list = m.get(k) || []; list.push(p); m.set(k, list)
    }
    return m
  }, [pieces])

  // Holiday + season markers keyed by day, for the visible window.
  const markers = useMemo(() => {
    const m = new Map<string, string[]>()
    const fromKey = key(range.from)
    const days = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000) + 1
    for (const h of upcomingHolidays(fromKey, days)) {
      const list = m.get(h.date) || []; list.push(h.name); m.set(h.date, list)
    }
    for (const r of upcomingSeasonReminders(fromKey, days)) {
      const list = m.get(r.date) || []; list.push(r.label); m.set(r.date, list)
    }
    return m
  }, [range.from, range.to])

  async function drop(dayKey: string) {
    const id = dragId
    setDragId(null)
    if (!id) return
    // optimistic
    const moving = pieces.find(p => p.id === id) || drafts.find(p => p.id === id)
    const scheduledFor = new Date(`${dayKey}T09:00:00`).toISOString() // 9am LOCAL, not UTC
    setDrafts(prev => prev.filter(p => p.id !== id))
    setPieces(prev => {
      const without = prev.filter(p => p.id !== id)
      if (moving) without.push({ ...moving, scheduled_for: scheduledFor, status: 'scheduled' })
      return without
    })
    const saved = await setSchedule(supabase, id, scheduledFor)
    if (saved) setPieces(prev => prev.map(p => p.id === id ? saved : p))
  }

  async function unschedule(p: ContentPiece) {
    const saved = await setSchedule(supabase, p.id, null)
    if (saved) { setPieces(prev => prev.filter(x => x.id !== p.id)); setDrafts(prev => [saved, ...prev]); setSelected(null) }
  }
  // Tap-based scheduling (works on touch where drag-and-drop doesn't).
  async function scheduleOn(p: ContentPiece, dayKey: string) {
    const scheduledFor = new Date(`${dayKey}T09:00:00`).toISOString() // 9am LOCAL, not UTC
    const saved = await setSchedule(supabase, p.id, scheduledFor)
    if (saved) {
      setDrafts(prev => prev.filter(x => x.id !== p.id))
      setPieces(prev => [...prev.filter(x => x.id !== p.id), saved])
      setSelected(saved)
    }
  }
  async function publish(p: ContentPiece) {
    const saved = await markPublished(supabase, p.id)
    if (saved) { setPieces(prev => prev.map(x => x.id === p.id ? saved : x)); setSelected(saved) }
  }
  async function fail(p: ContentPiece) {
    const saved = await setStatus(supabase, p.id, 'failed')
    if (saved) { setPieces(prev => prev.map(x => x.id === p.id ? saved : x)); setSelected(saved) }
  }

  const title = view === 'day'
    ? cursor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const step = view === 'month' ? (n: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, 1))
    : view === 'week' ? (n: number) => setCursor(c => addDays(c, 7 * n))
    : (n: number) => setCursor(c => addDays(c, n))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <button onClick={() => step(-1)} aria-label={`Previous ${view}`} title={`Previous ${view}`} className="p-2 rounded-lg hover:bg-surface text-ink-muted"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-bold text-ink min-w-[160px] text-center">{title}</span>
          <button onClick={() => step(1)} aria-label={`Next ${view}`} title={`Next ${view}`} className="p-2 rounded-lg hover:bg-surface text-ink-muted"><ChevronRight className="w-4 h-4" /></button>
          <Button variant="ghost" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
        </div>
        <div className="flex items-center gap-1.5">
          <FilterPill active={view === 'month'} onClick={() => setView('month')}><CalendarDays className="w-3 h-3" /> Month</FilterPill>
          <FilterPill active={view === 'week'} onClick={() => setView('week')}><CalendarRange className="w-3 h-3" /> Week</FilterPill>
          <FilterPill active={view === 'day'} onClick={() => setView('day')}><CalIcon className="w-3 h-3" /> Day</FilterPill>
          <Button size="sm" variant="secondary" onClick={() => setHubOpen(true)}><Send className="w-4 h-4" /> Publishing</Button>
          <Button size="sm" onClick={() => setPlanOpen(o => !o)} disabled={!aiEnabled} title={!aiEnabled ? "Add your Anthropic API key to enable AI generation" : undefined}><CalendarPlus className="w-4 h-4" /> Plan a month</Button>
        </div>
      </div>

      <PublishingHub userId={userId} open={hubOpen} onClose={() => { setHubOpen(false); load() }} initialTab="queue" />

      {planOpen && <PlanPanel aiEnabled={aiEnabled} onClose={() => setPlanOpen(false)} onDone={() => { setPlanOpen(false); load() }} defaultStart={todayKey} />}

      <div className="grid lg:grid-cols-[1fr_280px] gap-4 items-start">
        <Card className="p-3">
          {loading ? (
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: 42 }).map((_, i) => <Skeleton key={i} className="min-h-[64px] sm:min-h-[88px] rounded-lg" />)}
            </div>
          ) : view === 'month' ? (
            <MonthGrid cursor={cursor} byDay={byDay} markers={markers} todayKey={todayKey}
              onDropDay={drop} onDragOverDay={() => {}} setDragId={setDragId} onSelect={setSelected}
              onOpenDay={d => { setCursor(d); setView('day') }} />
          ) : view === 'week' ? (
            <WeekColumns from={startOfWeek(cursor)} byDay={byDay} markers={markers} todayKey={todayKey}
              onDropDay={drop} setDragId={setDragId} onSelect={setSelected} />
          ) : (
            <DayAgenda day={cursor} pieces={byDay.get(key(cursor)) || []} markers={markers.get(key(cursor)) || []} onSelect={setSelected} onDropDay={drop} />
          )}
        </Card>

        {/* Draft tray — drag onto a day, or tap a draft to open + schedule */}
        <div className="space-y-3">
          {selected && (
            <div ref={detailRef}>
              <PieceDetail piece={selected} onClose={() => setSelected(null)} onUnschedule={() => unschedule(selected)} onPublish={() => publish(selected)} onFail={() => fail(selected)} onSchedule={dayKey => scheduleOn(selected, dayKey)} />
            </div>
          )}
          <Card className="p-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Unscheduled drafts · {drafts.length}</p>
            <p className="text-[11px] text-ink-faint">Drag a draft onto a day — or tap it to open and schedule.</p>
            <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {drafts.length === 0 && <p className="text-xs text-ink-faint py-3 text-center">No unscheduled drafts.</p>}
              {drafts.map(p => <DraftChip key={p.id} piece={p} setDragId={setDragId} onSelect={setSelected} />)}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ── Month grid ──
function MonthGrid({ cursor, byDay, markers, todayKey, onDropDay, setDragId, onSelect, onOpenDay }: {
  cursor: Date
  byDay: Map<string, ContentPiece[]>
  markers: Map<string, string[]>
  todayKey: string
  onDropDay: (k: string) => void
  onDragOverDay: () => void
  setDragId: (id: string | null) => void
  onSelect: (p: ContentPiece) => void
  onOpenDay: (d: Date) => void
}) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = startOfWeek(first)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map(d => <div key={d} className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint text-center py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map(d => {
          const k = key(d)
          const dayPieces = byDay.get(k) || []
          const mk = markers.get(k) || []
          const out = !sameMonth(d, cursor)
          return (
            <div key={k}
              onDragOver={e => e.preventDefault()}
              onDrop={() => onDropDay(k)}
              className={cn('min-h-[60px] sm:min-h-[88px] rounded-lg border p-1 flex flex-col gap-1', out ? 'border-border/50 bg-bg-tertiary/30' : 'border-border bg-bg-secondary', k === todayKey && 'ring-1 ring-accent/50')}
            >
              <div className="flex items-center justify-between">
                <span className={cn('text-[11px] font-medium', out ? 'text-ink-faint/60' : 'text-ink-muted', k === todayKey && 'text-accent font-bold')}>{d.getDate()}</span>
              </div>
              {mk.slice(0, 1).map(m => <span key={m} className="text-[9px] text-amber-300/90 truncate" title={m}>★ {m}</span>)}
              {dayPieces.slice(0, 3).map(p => <CalChip key={p.id} piece={p} setDragId={setDragId} onSelect={onSelect} />)}
              {dayPieces.length > 3 && (
                <button onClick={() => onOpenDay(d)} className="text-[9px] text-ink-faint hover:text-accent text-left" title="See all posts this day">
                  +{dayPieces.length - 3} more
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Week columns ──
function WeekColumns({ from, byDay, markers, todayKey, onDropDay, setDragId, onSelect }: {
  from: Date
  byDay: Map<string, ContentPiece[]>
  markers: Map<string, string[]>
  todayKey: string
  onDropDay: (k: string) => void
  setDragId: (id: string | null) => void
  onSelect: (p: ContentPiece) => void
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i))
  return (
    <div className="grid grid-cols-7 gap-1">
      {days.map(d => {
        const k = key(d)
        const dayPieces = byDay.get(k) || []
        const mk = markers.get(k) || []
        return (
          <div key={k} onDragOver={e => e.preventDefault()} onDrop={() => onDropDay(k)}
            className={cn('min-h-[55vh] rounded-lg border p-1.5 flex flex-col gap-1.5 bg-bg-secondary border-border', k === todayKey && 'ring-1 ring-accent/50')}>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">{WEEKDAYS[d.getDay()]}</p>
              <p className={cn('text-sm font-bold', k === todayKey ? 'text-accent' : 'text-ink')}>{d.getDate()}</p>
            </div>
            {mk.slice(0, 1).map(m => <span key={m} className="text-[9px] text-amber-300/90 truncate" title={m}>★ {m}</span>)}
            {dayPieces.map(p => <CalChip key={p.id} piece={p} setDragId={setDragId} onSelect={onSelect} />)}
          </div>
        )
      })}
    </div>
  )
}

// ── Day agenda ──
function DayAgenda({ day, pieces, markers, onSelect, onDropDay }: { day: Date; pieces: ContentPiece[]; markers: string[]; onSelect: (p: ContentPiece) => void; onDropDay: (k: string) => void }) {
  return (
    // A real drop target so the empty-state "drag a draft here" actually works.
    <div className="space-y-2 min-h-[50vh]" onDragOver={e => e.preventDefault()} onDrop={() => onDropDay(key(day))}>
      {markers.map(m => <Banner key={m} tone="warn">★ {m}</Banner>)}
      {pieces.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing scheduled" description="Drag a draft here — or tap a draft in the tray to schedule it." />
      ) : pieces.map(p => (
        <button key={p.id} onClick={() => onSelect(p)} className="w-full text-left">
          <Card className="p-3 hover:border-accent/40 transition-colors">
            <ChipInner piece={p} big />
          </Card>
        </button>
      ))}
    </div>
  )
}

function ChipInner({ piece, big }: { piece: ContentPiece; big?: boolean }) {
  const def = channelDef(piece.channel)
  const Icon = def.icon
  const meta = STATUS_META[piece.status]
  return (
    <div className="flex items-start gap-2 min-w-0">
      <Icon className={cn('shrink-0 mt-0.5', big ? 'w-4 h-4 text-ink-muted' : 'w-3 h-3 text-ink-faint')} />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate', big ? 'text-sm text-ink' : 'text-[10px] text-ink')}>{piece.title || piece.body || 'Untitled'}</p>
        {big && <p className="text-xs text-ink-muted line-clamp-2 mt-0.5">{piece.body}</p>}
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 mt-1 text-[9px]', meta.chip)}>
          <span className={cn('w-1.5 h-1.5 rounded-full', meta.dot)} /> {meta.label} · {def.label}
        </span>
      </div>
    </div>
  )
}

function CalChip({ piece, setDragId, onSelect }: { piece: ContentPiece; setDragId: (id: string | null) => void; onSelect: (p: ContentPiece) => void }) {
  const def = channelDef(piece.channel)
  const Icon = def.icon
  const meta = STATUS_META[piece.status]
  return (
    <button
      draggable
      onDragStart={() => setDragId(piece.id)}
      onDragEnd={() => setDragId(null)}
      onClick={() => onSelect(piece)}
      className={cn('w-full text-left rounded-md border px-1.5 py-1 flex items-center gap-1 bg-surface hover:border-accent/50 cursor-grab active:cursor-grabbing', meta.chip)}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', meta.dot)} />
      <Icon className="w-3 h-3 shrink-0 opacity-70" />
      <span className="text-[10px] truncate flex-1">{piece.title || piece.body || 'Untitled'}</span>
    </button>
  )
}

function DraftChip({ piece, setDragId, onSelect }: { piece: ContentPiece; setDragId: (id: string | null) => void; onSelect: (p: ContentPiece) => void }) {
  const def = channelDef(piece.channel)
  const Icon = def.icon
  return (
    <div
      draggable
      onDragStart={() => setDragId(piece.id)}
      onDragEnd={() => setDragId(null)}
      onClick={() => onSelect(piece)}
      className="rounded-lg border border-border bg-bg-secondary px-2 py-1.5 flex items-center gap-2 cursor-grab active:cursor-grabbing hover:border-accent/40"
    >
      <GripVertical className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      <Icon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
      <span className="text-xs text-ink truncate flex-1">{piece.title || piece.body || 'Untitled draft'}</span>
    </div>
  )
}

// ── Selected piece detail ──
function PieceDetail({ piece, onClose, onUnschedule, onPublish, onFail, onSchedule }: {
  piece: ContentPiece; onClose: () => void; onUnschedule: () => void; onPublish: () => void; onFail: () => void; onSchedule: (dayKey: string) => void
}) {
  const def = channelDef(piece.channel)
  const [copied, setCopied] = useState(false)
  const [pickDate, setPickDate] = useState(false)
  const [date, setDate] = useState(() => (piece.scheduled_for ? piece.scheduled_for.slice(0, 10) : key(new Date())))
  function copy() {
    const text = [piece.body, piece.hashtags.map(h => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <Card className="p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink inline-flex items-center gap-1.5"><def.icon className="w-3.5 h-3.5" /> {def.label}</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
      </div>
      {piece.title && <p className="text-sm font-semibold text-ink">{piece.title}</p>}
      <p className="text-xs text-ink-muted whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">{piece.body}</p>
      {piece.hashtags.length > 0 && <p className="text-[11px] text-accent break-words">{piece.hashtags.map(h => `#${h}`).join(' ')}</p>}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" onClick={copy}>{copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}</Button>
        <Button size="sm" variant="secondary" onClick={() => window.open(def.openUrl, '_blank')}><ExternalLink className="w-3.5 h-3.5" /> Open</Button>
        {piece.status !== 'published' && <Button size="sm" variant="secondary" onClick={onPublish}><CircleCheck className="w-3.5 h-3.5" /> Mark as posted</Button>}
        {piece.status !== 'published' && <Button size="sm" variant="secondary" onClick={() => setPickDate(o => !o)}><CalendarPlus className="w-3.5 h-3.5" /> {piece.scheduled_for ? 'Reschedule' : 'Schedule'}</Button>}
        {piece.scheduled_for && piece.status !== 'published' && <Button size="sm" variant="ghost" onClick={onUnschedule}><Clock className="w-3.5 h-3.5" /> Unschedule</Button>}
        {piece.status === 'scheduled' && <Button size="sm" variant="ghost" onClick={onFail}><TriangleAlert className="w-3.5 h-3.5" /> Mark failed</Button>}
      </div>
      {pickDate && piece.status !== 'published' && (
        <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-ink" />
          <Button size="sm" onClick={() => { onSchedule(date); setPickDate(false) }}>Set date</Button>
        </div>
      )}
    </Card>
  )
}

// ── Plan a month (Smart Publishing Queue) ──
function PlanPanel({ aiEnabled, onClose, onDone, defaultStart }: { aiEnabled: boolean; onClose: () => void; onDone: () => void; defaultStart: string }) {
  const [count, setCount] = useState(8)
  const [everyDays, setEveryDays] = useState(3)
  const [startDate, setStartDate] = useState(defaultStart)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function run() {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch('/api/marketing/queue', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count, everyDays, startDate }),
      })
      const j = await res.json()
      if (j?.pieces?.length) {
        setMsg(`Scheduled ${j.pieces.length} posts${j.errors?.length ? ` · ${j.errors.length} failed` : ''}.${j.skipped ? ' ' + j.skipped : ''}`)
        setTimeout(onDone, 900)
      } else setMsg(j?.aiEnabled === false ? 'AI isn’t connected yet.' : 'Could not generate posts. Try again.')
    } catch { setMsg('Could not reach the generator.') }
    finally { setBusy(false) }
  }

  return (
    <Card className="p-4 space-y-3 border-accent/30">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink inline-flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> Plan a month of content</p>
        <button onClick={onClose} className="text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-xs text-ink-muted">Generate varied posts across your platforms and spread them across the calendar — one click, no repetition.</p>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="text-xs text-ink-muted">Posts
          <input type="number" min={1} max={16} value={count} onChange={e => setCount(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
            className="mt-1 block w-20 bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-sm text-ink" />
        </label>
        <label className="text-xs text-ink-muted">Every (days)
          <input type="number" min={1} max={14} value={everyDays} onChange={e => setEveryDays(Math.max(1, Math.min(14, Number(e.target.value) || 1)))}
            className="mt-1 block w-20 bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-sm text-ink" />
        </label>
        <label className="text-xs text-ink-muted">Starting
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
            className="mt-1 block bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-sm text-ink" />
        </label>
        <Button onClick={run} loading={busy} disabled={!aiEnabled} title={!aiEnabled ? "Add your Anthropic API key to enable AI generation" : undefined}><Sparkles className="w-4 h-4" /> Generate &amp; schedule</Button>
      </div>
      {!aiEnabled && <p className="text-[11px] text-ink-faint">Add your Anthropic key to enable generation.</p>}
      {msg && <Banner tone="info" onDismiss={() => setMsg(null)}>{msg}</Banner>}
    </Card>
  )
}
