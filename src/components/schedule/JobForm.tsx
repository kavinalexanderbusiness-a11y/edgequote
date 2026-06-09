'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Customer, Property, JobFormValues, JobStatus } from '@/types'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { DaySuggestion } from '@/lib/geo'
import { Repeat, Sparkles } from 'lucide-react'

export type RepeatMode = 'none' | 'weekly' | 'biweekly' | 'monthly'

export interface Recurrence {
  repeat: RepeatMode
  endDate: string | null // null = never ends
}

export interface SuggestionMeta {
  suggestedDate: string | null
  suggestedNearby: number | null
}

interface JobFormProps {
  customers: Customer[]
  defaultValues?: Partial<JobFormValues>
  excludeJobId?: string
  onSubmit: (values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
}

const STATUS_OPTIONS: { value: JobStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const REPEAT_OPTIONS = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Every month' },
]

export function JobForm({ customers, defaultValues, excludeJobId, onSubmit, onCancel, isEdit }: JobFormProps) {
  const supabase = createClient()
  const [properties, setProperties] = useState<Property[]>([])
  const [repeat, setRepeat] = useState<RepeatMode>('none')
  const [endMode, setEndMode] = useState<'never' | 'on'>('never')
  const [endDate, setEndDate] = useState('')
  const [topSuggestion, setTopSuggestion] = useState<DaySuggestion | null>(null)

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
  const selectedPropertyId = watch('property_id')
  const selProp = properties.find(p => p.id === selectedPropertyId)
  const propCoord = selProp && selProp.lat != null && selProp.lng != null
    ? { lat: selProp.lat, lng: selProp.lng } : null

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
    <form
      onSubmit={handleSubmit((values) => onSubmit(
        values,
        { repeat, endDate: repeat !== 'none' && endMode === 'on' && endDate ? endDate : null },
        { suggestedDate: topSuggestion?.date ?? null, suggestedNearby: topSuggestion?.nearbyCount ?? null },
      ))}
      className="space-y-4"
    >
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

      {(propCoord || selProp?.address) && (
        <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
            <Sparkles className="w-3.5 h-3.5 text-accent" /> Best day to schedule
          </div>
          <BestDaySuggestions
            coord={propCoord}
            address={selProp?.address ?? null}
            excludeJobId={excludeJobId}
            onPick={(date) => setValue('scheduled_date', date, { shouldValidate: true })}
            onTop={setTopSuggestion}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Input label="Date" type="date"
          error={errors.scheduled_date?.message}
          {...register('scheduled_date', { required: 'Required' })} />
        <Input label="Duration (minutes)" type="number" step="1" min="0"
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

      {/* Recurring visits — only when creating a new job */}
      {!isEdit && (
        <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
            <Repeat className="w-3.5 h-3.5" /> Recurring Visits
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Repeat</label>
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as RepeatMode)}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
              >
                {REPEAT_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-bg-secondary">{o.label}</option>)}
              </select>
            </div>
            {repeat !== 'none' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Ends</label>
                <select
                  value={endMode}
                  onChange={(e) => setEndMode(e.target.value as 'never' | 'on')}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                >
                  <option value="never" className="bg-bg-secondary">Never</option>
                  <option value="on" className="bg-bg-secondary">On a date</option>
                </select>
              </div>
            )}
          </div>
          {repeat !== 'none' && endMode === 'on' && (
            <Input label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          )}
          {repeat !== 'none' && (
            <p className="text-xs text-ink-faint">
              {endMode === 'never'
                ? `Repeats ${repeat === 'weekly' ? 'every week' : repeat === 'biweekly' ? 'every 2 weeks' : 'every month'}, with no end date. Visits are kept rolling on your calendar.`
                : `Repeats ${repeat === 'weekly' ? 'every week' : repeat === 'biweekly' ? 'every 2 weeks' : 'every month'} from the date above until the end date.`}
            </p>
          )}
        </div>
      )}

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