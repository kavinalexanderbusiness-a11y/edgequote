'use client'

import { useMemo, useState } from 'react'
import { format, parseISO, addDays } from 'date-fns'
import { DisruptionReason, DISRUPTION_META, DISRUPTION_REASONS } from '@/lib/disruption'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { FilterPill } from '@/components/ui/FilterPill'
import { CalendarDays } from 'lucide-react'

// ── Bulk reschedule ──────────────────────────────────────────────────────────
// Moves the selected visits to another date. The dialog only collects the
// decision (date, reason, whether to tell customers) — the page does the writes
// and, when asked, notifies through the EXISTING reschedule seam
// (lib/reschedule → /api/comms/send: opt-in gated, logged, idempotent). No new
// sender, no new template; the reason picks the same copy Weather Ops uses.

export function RescheduleDialog({ open, count, notifiableCount, fromDate, busy, onClose, onApply }: {
  open: boolean
  count: number             // selected, still-reschedulable visits
  notifiableCount: number   // of those, how many have a customer to notify
  fromDate: string          // yyyy-MM-dd the visits are moving FROM
  busy: boolean
  onClose: () => void
  onApply: (toDate: string, opts: { notify: boolean; reason: DisruptionReason }) => void
}) {
  const [toDate, setToDate] = useState(() => format(addDays(parseISO(fromDate + 'T00:00:00'), 1), 'yyyy-MM-dd'))
  const [reason, setReason] = useState<DisruptionReason>('weather')
  const [notify, setNotify] = useState(false)

  const quick = useMemo(() => ([
    { label: 'Tomorrow', date: format(addDays(parseISO(fromDate + 'T00:00:00'), 1), 'yyyy-MM-dd') },
    { label: '+2 days', date: format(addDays(parseISO(fromDate + 'T00:00:00'), 2), 'yyyy-MM-dd') },
    { label: 'Next week', date: format(addDays(parseISO(fromDate + 'T00:00:00'), 7), 'yyyy-MM-dd') },
  ]), [fromDate])

  const valid = !!toDate && toDate !== fromDate
  const apply = () => { if (valid && !busy) onApply(toDate, { notify, reason }) }

  return (
    <Modal open={open} onClose={onClose} title={`Reschedule ${count} visit${count !== 1 ? 's' : ''}`} icon={CalendarDays} size="sm"
      onSubmit={apply}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} loading={busy} disabled={!valid}>
            Move to {toDate ? format(parseISO(toDate + 'T00:00:00'), 'EEE, MMM d') : '…'}
          </Button>
        </div>
      }>
      <div className="space-y-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {quick.map(q => (
            <FilterPill key={q.label} active={toDate === q.date} onClick={() => setToDate(q.date)}>{q.label}</FilterPill>
          ))}
        </div>
        <Input
          label="New date"
          type="date"
          value={toDate}
          min={format(addDays(parseISO(fromDate + 'T00:00:00'), -365), 'yyyy-MM-dd')}
          onChange={e => setToDate(e.target.value)}
          fieldSize="sm"
          error={toDate === fromDate ? 'That’s the same day they’re already on.' : undefined}
        />
        <Select
          label="Reason"
          fieldSize="sm"
          value={reason}
          onChange={e => setReason(e.target.value as DisruptionReason)}
          options={DISRUPTION_REASONS.map(r => ({ value: r, label: `${DISRUPTION_META[r].emoji} ${DISRUPTION_META[r].label}` }))}
          hint="Sets which message customers get, if you notify them."
        />
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-tertiary px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-sm text-ink">Tell the customers</p>
            <p className="text-[11px] text-ink-faint">
              {notifiableCount > 0
                ? `${notifiableCount} of ${count} ${count !== 1 ? 'have' : 'has'} a customer on file — each is opt-in gated and logged, and can’t be unsent.`
                : 'None of the selected visits has a customer on file.'}
            </p>
          </div>
          <Toggle checked={notify && notifiableCount > 0} onChange={setNotify} disabled={notifiableCount === 0} ariaLabel="Notify customers of the new date" />
        </div>
      </div>
    </Modal>
  )
}
