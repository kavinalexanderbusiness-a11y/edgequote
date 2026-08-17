'use client'

import { useMemo, useState } from 'react'
import { Crew, Technician } from '@/types'
import { crewPalette } from '@/lib/crews'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import { Users, Plus, ChevronRight, Star } from 'lucide-react'

// ── Crews ────────────────────────────────────────────────────────────────────
// The second question an owner has about their team, next to the first one:
// Team says WHO works here, Crews says HOW THEY GO OUT. Both live on Workforce
// because they are the same subject — until now crews were only editable inside
// a modal on the dispatch board, which is where you go to move today's work, not
// to decide who your crews are.
//
// A row says what a crew IS at a glance: its colour (the same identity the board
// and the map use), who is on it, who leads it, and whether it is still running.

export interface CrewRowData {
  crew: Crew
  members: Technician[]
  leadName: string | null
  /** Visits booked to this crew today / in the next 7 days. null = not loaded. */
  today: number | null
  upcoming: number | null
  /** Members not booked off today. null = availability unknown, never 0. */
  availableToday: number | null
}

export function CrewsPanel({ rows, onOpen, onCreate, creating }: {
  rows: CrewRowData[]
  onOpen: (crew: Crew) => void
  onCreate: (name: string) => Promise<string | null>
  creating?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const active = useMemo(() => rows.filter(r => r.crew.is_active), [rows])
  const inactive = useMemo(() => rows.filter(r => !r.crew.is_active), [rows])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    const err = await onCreate(name)
    setBusy(false)
    if (err) { setError(err); return }
    // Only clear on success — a failed save must keep what was typed.
    setName('')
    setError(null)
    setAdding(false)
  }

  const addRow = adding && (
    <div className="px-4 sm:px-5 py-3 border-b border-border bg-bg-tertiary/30">
      <div className="flex items-end gap-2 flex-wrap">
        <Input
          label="Crew name"
          value={name}
          autoFocus
          fieldSize="sm"
          className="flex-1 min-w-[12rem]"
          error={error ?? undefined}
          hint={error ? undefined : 'Whatever you call them — Crew A, Install, Service, Morning.'}
          placeholder="Crew A"
          onChange={e => { setName(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create crew'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setName(''); setError(null) }}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )

  if (rows.length === 0 && !adding) {
    return (
      <Card>
        <CardBody className="p-0">
          <EmptyState
            icon={Users}
            className="py-14"
            title="No crews yet"
            description="A crew is a group of your people who go out together. Put work on a crew and everyone on it sees it on their phone — without you assigning each person one at a time."
            action={{ label: 'Create your first crew', onClick: () => setAdding(true) }}
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody className="p-0">
        <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Crews</h2>
            <p className="text-[11px] text-ink-faint">
              {active.length} running
              {inactive.length > 0 && ` · ${inactive.length} deactivated`}
            </p>
          </div>
          <div className="ml-auto">
            <Button size="sm" onClick={() => setAdding(true)} disabled={adding || creating}>
              <Plus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">New </span>crew
            </Button>
          </div>
        </div>

        {addRow}

        <ul className="divide-y divide-border">
          {active.map((r, i) => <Row key={r.crew.id} row={r} index={i} onOpen={onOpen} />)}
        </ul>

        {inactive.length > 0 && (
          <>
            <p className="px-4 sm:px-5 py-1.5 bg-bg-tertiary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint border-y border-border">
              Deactivated — their past work is kept
            </p>
            <ul className="divide-y divide-border">
              {inactive.map((r, i) => <Row key={r.crew.id} row={r} index={active.length + i} onOpen={onOpen} />)}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function Row({ row, index, onOpen }: { row: CrewRowData; index: number; onOpen: (c: Crew) => void }) {
  const pal = crewPalette(row.crew.color, index)
  const n = row.members.length
  // ⭐ Availability is a THIRD number, never folded into headcount: "3 people, 1
  // booked off" and "2 people" are different facts about tomorrow morning.
  const off = row.availableToday == null ? null : n - row.availableToday

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.crew)}
        className={cn(
          'w-full text-left px-4 sm:px-5 py-3 flex items-center gap-3 transition-colors hover:bg-bg-tertiary/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40',
          !row.crew.is_active && 'opacity-60',
        )}
      >
        <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', pal.dot)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink truncate">{row.crew.name}</span>
            {!row.crew.is_active && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-faint">
                Deactivated
              </span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 border', pal.chip)}>
              <Users className="w-3 h-3" aria-hidden />
              {n === 0 ? 'Nobody on it yet' : `${n} ${n === 1 ? 'person' : 'people'}`}
            </span>
            {row.leadName && (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-muted">
                <Star className="w-3 h-3" aria-hidden />{row.leadName}
              </span>
            )}
            {off != null && off > 0 && (
              <span className="rounded px-1.5 py-0.5 border border-amber-500/30 bg-amber-500/10 text-amber-400 font-medium">
                {off} booked off today
              </span>
            )}
            {row.today != null && row.today > 0 && (
              <span className="text-ink-faint tabular-nums">{row.today} today</span>
            )}
            {row.upcoming != null && row.upcoming > 0 && (
              <span className="text-ink-faint tabular-nums">{row.upcoming} this week</span>
            )}
            {n === 0 && row.crew.is_active && (row.today ?? 0) > 0 && (
              <span className="rounded px-1.5 py-0.5 border border-red-500/30 bg-red-500/10 text-red-400 font-medium">
                Work today, nobody to do it
              </span>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
      </button>
    </li>
  )
}
