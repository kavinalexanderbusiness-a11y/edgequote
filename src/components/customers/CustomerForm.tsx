'use client'

import { useForm, Controller } from 'react-hook-form'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { Customer, CustomerFormValues, ACQUISITION_SOURCES } from '@/types'

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>
  customers?: Customer[]
  onSubmit: (values: CustomerFormValues) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
}

const PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']

export function CustomerForm({ defaultValues, customers = [], onSubmit, onCancel, isEdit }: CustomerFormProps) {
  const { register, handleSubmit, control, watch, setValue, formState: { errors, isSubmitting } } = useForm<CustomerFormValues>({
    defaultValues: {
      province: 'AB',
      acquisition_source: '',
      referred_by_customer_id: '',
      ...defaultValues,
    },
  })

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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <Input
        label="Full Name"
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

      <Textarea
        label="Notes"
        placeholder="Property details, gate codes, preferred contact times..."
        {...register('notes')}
      />
      <div className="flex items-center justify-end gap-3 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>
          {isEdit ? 'Save Changes' : 'Add Customer'}
        </Button>
      </div>
    </form>
  )
}