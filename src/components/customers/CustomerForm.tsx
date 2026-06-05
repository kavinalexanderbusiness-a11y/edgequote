'use client'

import { useForm } from 'react-hook-form'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { CustomerFormValues } from '@/types'

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>
  onSubmit: (values: CustomerFormValues) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
}

const PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']

export function CustomerForm({ defaultValues, onSubmit, onCancel, isEdit }: CustomerFormProps) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<CustomerFormValues>({
    defaultValues: {
      province: 'AB',
      ...defaultValues,
    },
  })

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <Input
        label="Full Name"
        placeholder="Jane Smith"
        error={errors.name?.message}
        {...register('name', { required: 'Name is required' })}
      />
      <div className="grid grid-cols-2 gap-4">
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
      <Input
        label="Street Address"
        placeholder="123 Main Street"
        {...register('address')}
      />
      <div className="grid grid-cols-3 gap-4">
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
