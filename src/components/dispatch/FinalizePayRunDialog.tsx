'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import { finalizePayRun, type DraftPayRun } from '@/lib/payRun'
import { decimalHours, formatDuration } from '@/lib/timeTracking'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { toast as notify } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { AlertTriangle, Lock, Info } from 'lucide-react'

// ── Finalize a pay period ────────────────────────────────────────────────────
// The moment a live calculation becomes a financial record. Everything that could
// make the number wrong is said BEFORE the button, not discovered after payday:
// open shifts aren't paid, unwaged hours pay $0. Both are recoverable now and
// awkward later, which is the whole reason this dialog exists.

interface Props {
  open: boolean
  draft: DraftPayRun
  supabase: SupabaseClient
  userId: string
  onClose: () => void
  onFinalized: (payRunId: string) => void
}

export function FinalizePayRunDialog({ open, draft, supabase, userId, onClose, onFinalized }: Props) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function go() {
    setSaving(true)
    const res = await finalizePayRun(supabase, userId, draft, note)
    setSaving(false)
    if (!res.ok) { notify.error(res.error); return }
    notify.success(`Pay run finalized — ${formatCurrency(draft.grossPay)} across ${draft.employeeCount} employee${draft.employeeCount !== 1 ? 's' : ''}.`)
    onFinalized(res.payRunId)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Finalize this pay period" icon={Lock} size="md" onSubmit={go}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} loading={saving}><Lock className="w-3.5 h-3.5" /> Finalize pay run</Button>
        </div>
      }>
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-bg-tertiary px-4 py-3">
          <p className="text-xs text-ink-muted">{format(draft.period.start, 'MMM d')} – {format(draft.period.end, 'MMM d, yyyy')}</p>
          <p className="text-2xl font-bold text-ink tabular-nums mt-1">{formatCurrency(draft.grossPay)}</p>
          <p className="text-[11px] text-ink-faint tabular-nums mt-0.5">
            {draft.employeeCount} employee{draft.employeeCount !== 1 ? 's' : ''} ·{' '}
            {formatDuration(draft.regularMinutes + draft.otMinutes)} worked
            {draft.otMinutes > 0 && ` (${decimalHours(draft.otMinutes)} h OT)`}
            {draft.ptoHours > 0 && ` · ${draft.ptoHours} h paid time off`}
          </p>
        </div>

        {/* Say it before payday, not after. */}
        {draft.openShifts > 0 && (
          <Banner tone="warn" icon={AlertTriangle}>
            {draft.openShifts} shift{draft.openShifts !== 1 ? 's are' : ' is'} still open and won’t be paid in this
            run. Clock {draft.openShifts !== 1 ? 'them' : 'it'} out first if {draft.openShifts !== 1 ? 'they belong' : 'it belongs'} in this period.
          </Banner>
        )}
        {draft.unratedMinutes > 0 && (
          <Banner tone="warn" icon={AlertTriangle}>
            {formatDuration(draft.unratedMinutes)} was worked with no wage set and will pay $0.
          </Banner>
        )}

        <Input label="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. cheques issued Friday" hint="Kept with the pay run for your records." />

        <Banner tone="info" icon={Info}>
          Finalizing freezes these numbers. Editing a shift afterwards won’t change what this run
          says you paid — EdgeQuote will flag the difference instead, so the record of the cheque
          you actually cut stays intact.
        </Banner>
      </div>
    </Modal>
  )
}
