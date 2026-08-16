'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import type { PtoKind, WorkerAvailability } from '@/types'
import { PTO_KIND_LABELS, PTO_STATUS_LABELS } from '@/types'
import {
  loadCrewAvailability, setCrewDayAvailability, requestCrewTimeOff, cancelCrewTimeOff,
  REQUESTABLE_KINDS, type CrewAvailability as CrewAvailabilityData,
} from '@/lib/crewAvailability'
import { parseDateOnly } from '@/lib/pto'
import { WeeklyAvailabilityEditor } from '@/components/workforce/WeeklyAvailabilityEditor'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Banner } from '@/components/ui/Banner'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CalendarOff, Plus, AlertTriangle } from 'lucide-react'

// ── A worker's own availability ──────────────────────────────────────────────
// Everything here is about the person signed in — they cannot see or change
// anybody else's week, because the RPCs take no technician id at all
// (lib/crewAvailability). The office decides time off; this asks.
//
// Built for a phone in a work glove: the week editor is the same control the
// owner uses (one component, two callers), the request form is a full-screen
// sheet with three fields, and every failure keeps what was typed.

export function CrewAvailability() {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<CrewAvailabilityData | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'revoked' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const fetchAll = useCallback(async () => {
    const res = await loadCrewAvailability(supabase)
    if (res.kind === 'ok') { setData(res.availability); setState('ok'); setMessage(null); return }
    if (res.kind === 'revoked') { setState('revoked'); return }
    // A failed read keeps whatever is already on screen — the worker may be in
    // a dead zone, and blanking the page would look like the data was wiped.
    setState(data ? 'ok' : 'error')
    setMessage(res.message)
  }, [supabase, data])

  useEffect(() => { fetchAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (state === 'loading') return <SkeletonRows count={4} />

  if (state === 'revoked') {
    return (
      <Banner tone="warn" icon={AlertTriangle}>
        Your access has been turned off. Talk to the office if that’s a surprise.
      </Banner>
    )
  }

  if (state === 'error' || !data) {
    return (
      <Banner tone="danger" icon={AlertTriangle}
        action={<Button size="sm" variant="secondary" onClick={fetchAll}>Retry</Button>}>
        Couldn’t load your availability{message ? ` — ${message}` : ''}.
      </Banner>
    )
  }

  // The RPC returns pattern days without ids; the shared editor reads the same
  // shape the owner's rows have, so fill the fields it doesn't use.
  const rows = data.pattern.map((p, i) => ({
    id: `wd-${p.weekday}-${i}`, created_at: '', updated_at: '', user_id: '', technician_id: '',
    weekday: p.weekday, available: p.available, start_time: p.start_time, end_time: p.end_time,
  })) as WorkerAvailability[]

  return (
    <div className="space-y-5">
      {message && <Banner tone="warn">Showing what loaded last — {message}</Banner>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Your working days</h2>
        <WeeklyAvailabilityEditor
          rows={rows}
          subject="self"
          onSave={async (weekday, available, start, end) => {
            const res = await setCrewDayAvailability(supabase, weekday, available, start, end)
            if (!res.ok) { toast.error(res.message); return false }
            await fetchAll()
            return true
          }}
        />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Time off</h2>
          <Button size="sm" onClick={() => setAsking(true)}>
            <Plus className="w-3.5 h-3.5" /> Ask for time off
          </Button>
        </div>

        {data.time_off.length === 0 ? (
          <p className="rounded-card border border-border bg-bg-secondary px-3.5 py-4 text-sm text-ink-muted">
            Nothing booked or requested.
          </p>
        ) : (
          <ul className="rounded-card border border-border bg-bg-secondary divide-y divide-border">
            {data.time_off.map(t => (
              <li key={t.id} className="px-3.5 py-3 flex items-center gap-3">
                <CalendarOff className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate">
                    {format(parseDateOnly(t.date), 'EEE MMM d')}
                    <span className="text-[11px] font-normal text-ink-faint"> · {PTO_KIND_LABELS[t.kind]}</span>
                  </p>
                  <p className="text-[11px] text-ink-faint tabular-nums">{Number(t.hours)} h</p>
                </div>
                <span className={cn('text-[11px] font-semibold shrink-0',
                  t.status === 'approved' ? 'text-emerald-400'
                    : t.status === 'declined' ? 'text-ink-faint' : 'text-amber-400')}>
                  {PTO_STATUS_LABELS[t.status]}
                </span>
                {t.status === 'requested' && (
                  <Button variant="ghost" size="sm" className="shrink-0"
                    onClick={async () => {
                      const res = await cancelCrewTimeOff(supabase, t.id)
                      if (!res.ok) { toast.error(res.message); return }
                      toast.success('Request withdrawn.')
                      fetchAll()
                    }}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="px-1 text-[11px] text-ink-faint">
          Asking isn’t booking — the office approves time off. You’ll see the answer here.
        </p>
      </section>

      {asking && <AskDialog onClose={() => setAsking(false)} onSaved={fetchAll} />}
    </div>
  )
}

function AskDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [hours, setHours] = useState('8')
  const [kind, setKind] = useState<PtoKind>('vacation')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const h = Number(hours) || 0
  const invalid = !date || h <= 0 || h > 24

  async function save() {
    if (invalid) return
    setSaving(true); setError(null)
    const res = await requestCrewTimeOff(supabase, { date, hours: h, kind, note: note.trim() || null })
    setSaving(false)
    // Keep every keystroke on failure — retyping a request on a phone is the
    // difference between asking again and not bothering.
    if (!res.ok) { setError(res.message); return }
    toast.success('Asked. The office will let you know.')
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title="Ask for time off" icon={CalendarOff} size="md" onSubmit={save}
      footer={
        <div className="flex items-center gap-2">
          <Button onClick={save} loading={saving} disabled={invalid} className="flex-1">Send request</Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        </div>
      }>
      <div className="space-y-3">
        {error && <Banner tone="danger">{error}</Banner>}
        <Input label="Day" type="date" value={date} min={format(new Date(), 'yyyy-MM-dd')}
          onChange={e => setDate(e.target.value)} />
        <Input label="Hours" type="number" inputMode="decimal" min="0.5" max="24" step="0.5"
          value={hours} onChange={e => setHours(e.target.value)}
          error={h > 24 ? 'A day is 24 hours at most' : undefined} />
        <Select label="Reason" value={kind} onChange={e => setKind(e.target.value as PtoKind)}
          options={REQUESTABLE_KINDS.map(k => ({ value: k, label: PTO_KIND_LABELS[k] }))} />
        <Input label="Anything the office should know" value={note}
          onChange={e => setNote(e.target.value)} placeholder="Optional" />
        <p className="text-[11px] text-ink-faint">
          This is a request, not a booking. Whether it’s paid is the office’s call.
        </p>
      </div>
    </Modal>
  )
}
