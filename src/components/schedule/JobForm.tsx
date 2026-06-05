'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Customer, Property, JobFormValues, JobStatus } from '@/types'

interface JobFormProps {
  customers: Customer[]
  defaultValues?: Partial<JobFormValues>
  onSubmit: (values: JobFormValues) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
}

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function JobForm({ customers, defaultValues, onSubmit, onCancel, isEdit }: JobFormProps) {
  const supabase = createClient()
  const [properties, setProperties] = useState<Property[]>([])

  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting } } =
    useForm<JobFormValues>({
      defaultValues: {
        customer_id: '',
        property_id: '',
        title: '',
        service_type: '',
        scheduled_date: '',
        start_time: '',
        end_time: '',
        duration_minutes: 60,
        crew_size: 1,
        status: 'scheduled',
        notes: '',
        ...defaultValues,
      },
    })

  const customerId = watch('customer_id')

  // Load properties for the selected customer
  useEffect(() => {
    if (!customerId) { setProperties([]); return }
    async function loadProps() {
      const { data } = await supabase
        .from('properties')
        .select('*')
        .eq('customer_id', customerId)
        .order('is_primary', { ascending: false })
      const props = (data as Property[]) || []
      setProperties(props)
      // Auto-select the primary property if none chosen yet
      if (props.length > 0 && !watch('property_id')) {
        setValue('property_id', props[0].id)
      }
    }
    loadProps()
  }, [customerId, supabase, setValue, watch])

  const customerOptions = [
    { value: '', label: 'Select a customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
  ]

  const propertyOptions = [
    { value: '', label: properties.length ? 'Select a property...' : 'No properties found' },
    ...properties.map(p => ({ value: p.id, label: p.address + (p.is_primary ? ' (primary)' : '') })),
  ]

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Controller name="customer_id" control={control}
        render={({ field }) => (
          <Select label="Customer" options={customerOptions} {...field} />
        )} />

      <Controller name="property_id" control={control}
        render={({ field }) => (
          <Select label="Property" options={propertyOptions} {...field} />
        )} />

      <Input label="Job Title" placeholder="e.g. Lawn Mowing — 123 Main St"
        error={errors.title?.message}
        {...register('title', { required: 'Required' })} />

      <Input label="Service Type" placeholder="e.g. Lawn Mowing"
        {...register('service_type')} />

      <div className="grid grid-cols-2 gap-4">
        <Input label="Date" type="date"
          error={errors.scheduled_date?.message}
          {...register('scheduled_date', { required: 'Required' })} />
        <Input label="Duration (minutes)" type="number" step="15" min="0"
          {...register('duration_minutes', { min: 0 })} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input label="Start Time" type="time" {...register('start_time')} />
        <Input label="End Time" type="time" {...register('end_time')} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input label="Crew Size" type="number" min="1"
          {...register('crew_size', { min: { value: 1, message: 'Min 1' } })} />
        <Controller name="status" control={control}
          render={({ field }) => (
            <Select label="Status" options={STATUS_OPTIONS} {...field} />
          )} />
      </div>

      <Textarea label="Notes" placeholder="Access instructions, gate codes, special requests..."
        {...register('notes')} />

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" loading={isSubmitting}>
          {isEdit ? 'Update Job' : 'Add Job'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}