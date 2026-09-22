'use client'

import { useEffect, useMemo, useState } from 'react'
import { Heart } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { formatCurrency, cn } from '@/lib/utils'
import type { TipRequest, TipPercent } from '@/lib/payments/tips'

export function TipChooserDialog({ open, baseAmount, busy = false, onClose, onConfirm }: {
  open: boolean
  baseAmount: number
  busy?: boolean
  onClose: () => void
  onConfirm: (tip: TipRequest) => void
}) {
  const [choice, setChoice] = useState<TipPercent | 'custom'>(0)
  const [custom, setCustom] = useState('')
  useEffect(() => { if (open) { setChoice(0); setCustom('') } }, [open])
  const customCents = Math.round(Number(custom) * 100)
  const capCents = Math.min(Math.round(baseAmount * 100), 50_000)
  const validCustom = choice !== 'custom' || (Number.isSafeInteger(customCents) && customCents >= 0 && customCents <= capCents)
  const total = useMemo(() => baseAmount + (choice === 'custom' ? (validCustom ? customCents / 100 : 0) : baseAmount * choice / 100), [baseAmount, choice, customCents, validCustom])

  function submit() {
    if (!validCustom) return
    onConfirm(choice === 'custom' ? { kind: 'custom', cents: customCents } : { kind: 'percent', value: choice })
  }

  return <Modal open={open} onClose={onClose} title="Add a tip?" icon={Heart} size="sm" dismissable={!busy}
    onSubmit={submit}
    footer={<div className="flex gap-2 justify-end"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} disabled={!validCustom}>Continue · {formatCurrency(total)}</Button></div>}>
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">Optional. Tips are recorded separately from the invoice total.</p>
      <div className="grid grid-cols-4 gap-2">
        {([0, 10, 15, 20] as TipPercent[]).map(pct => <button key={pct} type="button" onClick={() => setChoice(pct)}
          className={cn('rounded-lg border px-2 py-2 text-sm font-semibold', choice === pct ? 'border-accent bg-accent/10 text-accent-text' : 'border-border text-ink hover:border-border-strong')}>
          {pct === 0 ? 'No tip' : `${pct}%`}
        </button>)}
      </div>
      <button type="button" onClick={() => setChoice('custom')}
        className={cn('w-full rounded-lg border px-3 py-2 text-left text-sm font-semibold', choice === 'custom' ? 'border-accent bg-accent/10 text-accent-text' : 'border-border text-ink')}>Custom amount</button>
      {choice === 'custom' && <Input label="Custom tip" type="number" min="0" max={(capCents / 100).toFixed(2)} step="0.01" value={custom} onChange={e => setCustom(e.target.value)} placeholder="0.00"
        error={!validCustom ? `Enter an amount up to ${formatCurrency(capCents / 100)}.` : undefined} />}
      <div className="flex justify-between text-sm"><span className="text-ink-muted">Invoice payment</span><span className="text-ink tabular-nums">{formatCurrency(baseAmount)}</span></div>
    </div>
  </Modal>
}
