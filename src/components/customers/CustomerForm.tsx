'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useForm, Controller } from 'react-hook-form'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { useAutosave } from '@/hooks/useAutosave'
import { AutosaveStatus, DraftRestoreBanner } from '@/components/ui/Autosave'
import { findCustomerMatch } from '@/lib/customers'
import { Customer, CustomerFormValues, ACQUISITION_SOURCES } from '@/types'
import { Users } from 'lucide-react'

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>
  customers?: Customer[]
  onSubmit: (values: CustomerFormValues) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
  /** Autosave key — defaults per add/edit; pass a precise one (e.g. `customer:${id}`). */
  autosaveKey?: string
}

const PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']

export function CustomerForm({ defaultValues, customers = [], onSubmit, onCancel, isEdit, autosaveKey }: CustomerFormProps) {
  const { register, handleSubmit, control, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<CustomerFormValues>({
    defaultValues: {
      province: 'AB',
      acquisition_source: '',
      referred_by_customer_id: '',
      birthday: '',
      anniversary: '',
      ...defaultValues,
    },
  })

  // Autosave the whole form — survives refresh / crash / accidental close. Shared engine.
  const formValues = watch()
  const autosave = useAutosave<CustomerFormValues>({
    key: autosaveKey || `customer:${isEdit ? 'edit' : 'new'}`,
    value: formValues,
    isEmpty: v => !v.name?.trim() && !v.email?.trim() && !v.phone?.trim() && !v.address?.trim(),
  })
  const submit = handleSubmit(async v => { await onSubmit(v); autosave.clear() })

  // Live duplicate detection — reuses the ONE matching engine (phone/email/address
  // confident, name not). Only when creating, so we never warn a customer about
  // themselves. Surfaces the existing record instead of creating a duplicate.
  const name = watch('name'); const email = watch('email'); const phone = watch('phone'); const addr = watch('address')
  const dupMatch = useMemo(
    () => (isEdit ? null : findCustomerMatch(customers, { name, phone, email, address: addr })),
    [isEdit, customers, name, phone, email, addr],
  )

  const source = watch('acquisition_source')
  const sourceOptions = [
    { value: '', label: 'How did they find you?' },
    ...ACQUISITION_SOURCES.map(s => ({ value: s, label: s })),
  ]
  const referrerOptions = [
    { value: '', label: 'Select referring customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
  ]

  return (
    <form onSubmit={submit} className="space-y-5">
      {autosave.draft && (
        <DraftRestoreBanner
          savedAt={autosave.savedAt}
          label="unsaved customer"
          onRestore={() => { const v = autosave.restore(); if (v) reset(v) }}
          onDiscard={autosave.discard}
        />
      )}
      <Input
        label="Full Name" autoFocus
        placeholder="Jane Smith"
        error={errors.name?.message}
        {...register('name', { required: 'Name is required' })}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Email"
          type="email"
          placeholder="jane@example.com"
          {...register('email')}
        />
        <Input
          label="Phone"
          type="tel"
          placeholder="(403) 555-0100"
          {...register('phone')}
        />
      </div>

      {/* Duplicate guard — link to the existing record instead of creating a copy */}
      {dupMatch && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
          <Users className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-ink flex-1 min-w-0">
            <p>
              {dupMatch.confident
                ? <>Looks like this customer already exists — <span className="font-semibold">{dupMatch.customer.name}</span> (same {dupMatch.reason}).</>
                : <>Possible existing customer — <span className="font-semibold">{dupMatch.customer.name}</span> (same name).</>}
            </p>
            <Link href={`/dashboard/customers/${dupMatch.customer.id}`} className="inline-flex items-center gap-1 mt-1 text-accent font-medium hover:underline">
              Open {dupMatch.customer.name.split(' ')[0]} instead →
            </Link>
          </div>
        </div>
      )}

      <Controller
        name="address"
        control={control}
        render={({ field }) => (
          <AddressAutocomplete
            label="Street Address"
            placeholder="123 Main Street"
            value={field.value || ''}
            onChange={field.onChange}
            onSelect={(p) => {
              field.onChange(p.address)
              if (p.city) setValue('city', p.city)
              if (p.province) setValue('province', p.province)
              if (p.postal) setValue('postal_code', p.postal)
            }}
          />
        )}
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="col-span-2">
          <Input
            label="City"
            placeholder="Calgary"
            {...register('city')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Province</label>
          <select
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
            {...register('province')}
          >
            {PROVINCES.map(p => <option key={p} value={p} className="bg-bg-secondary">{p}</option>)}
          </select>
        </div>
      </div>
      <Input
        label="Postal Code"
        placeholder="T2P 1G1"
        {...register('postal_code')}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Controller
          name="acquisition_source"
          control={control}
          render={({ field }) => (
            <Select label="How they found you" options={sourceOptions} {...field} />
          )}
        />
        {source === 'Referral' && (
          <Controller
            name="referred_by_customer_id"
            control={control}
            render={({ field }) => (
              <Select label="Referred by" options={referrerOptions} {...field} />
            )}
          />
        )}
      </div>

      {/* Optional dates that power birthday / anniversary campaigns (Grow → Customer
          automation). Month + day are used; the year is fine to leave approximate. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Birthday (optional)"
          type="date"
          {...register('birthday')}
        />
        <Input
          label="Customer anniversary (optional)"
          type="date"
          {...register('anniversary')}
        />
      </div>

      <Textarea
        label="Notes"
        placeholder="Property details, gate codes, preferred contact times..."
        {...register('notes')}
      />
      <div className="flex items-center justify-end gap-3 pt-2">
        <AutosaveStatus status={autosave.status} savedAt={autosave.savedAt} className="mr-auto" />
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>
          {isEdit ? 'Save Changes' : 'Add Customer'}
        </Button>
      </div>
    </form>
  )
}