'use client'

import { useEffect, useId, useRef } from 'react'
import type { UseFormRegister, UseFormSetValue } from 'react-hook-form'
import { Wallet } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import { formatCurrency } from '@/lib/utils'
import type { QuoteFormValues } from '@/types'

interface SchedulingDepositFieldsProps {
  depositType: QuoteFormValues['deposit_type']
  depositValue: QuoteFormValues['deposit_value']
  register: UseFormRegister<QuoteFormValues>
  setValue: UseFormSetValue<QuoteFormValues>
  onEnabledChange: (enabled: boolean) => void
}

// Lives in the builder so collapsing More options cannot discard the unit.
export function useSchedulingDepositToggle(
  depositType: QuoteFormValues['deposit_type'],
  depositValue: QuoteFormValues['deposit_value'],
  setValue: UseFormSetValue<QuoteFormValues>,
) {
  // Turning the rule off retains the editor's amount AND unit. A fixed $75
  // must never silently become 75% when the owner turns it back on.
  const lastEnabledType = useRef<'percent' | 'fixed'>(depositType === 'fixed' ? 'fixed' : 'percent')
  useEffect(() => {
    if (depositType === 'percent' || depositType === 'fixed') lastEnabledType.current = depositType
  }, [depositType])

  return (on: boolean) => {
    if (on) {
      setValue('deposit_type', lastEnabledType.current)
      if (!(Number(depositValue) > 0)) setValue('deposit_value', 50)
    } else {
      // The save helper writes both columns as null while disabled.
      setValue('deposit_type', '')
    }
  }
}

export function SchedulingDepositFields({ depositType, depositValue, register, setValue, onEnabledChange }: SchedulingDepositFieldsProps) {
  const statusId = useId()
  const enabled = depositType === 'percent' || depositType === 'fixed'

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
        <Wallet className="w-3.5 h-3.5" /> Scheduling deposit
      </p>
      <Toggle
        checked={enabled}
        onChange={onEnabledChange}
        label="Require a scheduling deposit"
        ariaDescribedBy={statusId}
      />
      <p id={statusId} className="text-xs text-ink-muted">
        {enabled ? 'Deposit required before scheduling is confirmed.' : 'No deposit is required to confirm scheduling.'}
      </p>
      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-3 items-end">
            <label className="block">
              <span className="block text-xs font-medium text-ink-muted mb-1">Deposit as</span>
              <select
                value={depositType}
                onChange={event => setValue('deposit_type', event.target.value as 'percent' | 'fixed')}
                className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="percent">% of the price</option>
                <option value="fixed">Fixed amount ($)</option>
              </select>
            </label>
            <Input
              label={depositType === 'percent' ? 'Percent' : 'Amount ($)'}
              type="number"
              step="0.01"
              min="0"
              max={depositType === 'percent' ? '100' : undefined}
              {...register('deposit_value', { min: 0 })}
            />
          </div>
          <p className="text-[11px] text-ink-faint">
            The customer can approve as usual — their preferred timing is only confirmed once{' '}
            {depositType === 'percent' && Number(depositValue) > 0
              ? `${Number(depositValue)}% of the accepted price`
              : depositType === 'fixed' && Number(depositValue) > 0
                ? formatCurrency(Number(depositValue))
                : 'the deposit'}{' '}
            has actually been received. E-transfer and cash you record count the same as card.
          </p>
        </>
      )}
    </div>
  )
}
