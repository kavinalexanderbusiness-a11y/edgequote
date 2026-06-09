'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Customer, Property, JobFormValues, JobStatus, RecurUnit } from '@/types'
import { recurrenceLabel } from '@/lib/recurrence'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { DaySuggestion } from '@/lib/geo'
import { Repeat, Sparkles } from 'lucide-react'

// Flexible recurrence: any interval (count + unit), three end modes.
export interface Recurrence {
  unit: RecurUnit | null // null = does not repeat
  count: number
  endDate: string | null
  endCount: number | null
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

type RepeatPreset = 'none' | 'w1' | 'w2' | 'w3' | 'w4' | 'm1' | 'custom'

const PRESET_OPTIONS: { value: RepeatPreset; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'w1', label: 'Every week' },
  { value: 'w2', label: 'Every 2 weeks' },
  { value: 'w3', label: 'Every 3 weeks' },
  { value: 'w4', label: 'Every 4 weeks' },
  { value: 'm1', label: 'Monthly' },
  { value: 'custom', label: 'Custom…' },
]

function presetToInterval(preset: RepeatPreset, customUnit: RecurUnit, customCount: number): { unit: RecurUnit; count: number } | null {
  switch (preset) {
    case 'none': return null
    case 'w1': return { unit: 'week', count: 1 }
    case 'w2': return { unit: 'week', count: 2 }
    case 'w3': return { unit: 'week', count: 3 }
    case 'w4': return { unit: 'week', count: 4 }
    case 'm1': return { unit: 'month', count: 1 }
    case 'custom': return { unit: customUnit, count: Math.max(1, customCount) }
  }
}

export function JobForm({ customers, defaultValues, excludeJobId, onSubmit, onCancel, isEdit }: JobFormProps) {
  const supabase = createClient()
  const [properties, setProperties] = useState<Property[]>([])
  const [topSuggestion, setTopSuggestion] = useState<DaySuggestion | null>(null)

  // Recurrence state
  const [preset, setPreset] = useState<RepeatPreset>('none')
  const [customUnit, setCustomUnit] = useState<RecurUnit>('week')
  const [customCount, setCustomCount] = useState(3)
  const [endMode, setEndMode] = useState<'never' | 'on' | 'after'>('never')
  const [endDate, setEndDate] = useState('')
  const [endCount, setEndCount] = useState(10)

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
        actual_minutes: 0,
        ...defaultValues,
      },
    })

  const customerId = watch('customer_id')
  const status = watch('status')
  const selectedPropertyId = watch('property_id')
  const selProp = properties.find(p => p.id === selectedPropertyId)
  const propCoord = selProp && selProp.lat != null && selProp.lng != null
    ? { lat: selProp.lat, lng: selProp.lng } : null

  const interval = presetToInterval(preset, customUnit, customCount)

  function buildRecurrence(): Recurrence {
    if (!interval) return { unit: null, count: 1, endDate: null, endCount: null }
    return {
      unit: interval.unit,
      count: interval.count,
      endDate: endMode === 'on' && endDate ? endDate : null,
      endCount: endMode === 'after' ? Math.max(1, endCount) : null,
    }
  }

  function applyLawnPreset(kind: 'weekly' | 'biweekly' | 'monthly') {
    setPreset(kind === 'weekly' ? 'w1' : kind === 'biweekly' ? 'w2' : 'm1')
    const svc = kind === 'monthly' ? 'Monthly Service' : 'Lawn Mowing'
    setValue('service_type', svc)
    if (!watch('title')) {
      setValue('title', svc + (selProp?.address ? ` — ${selProp.address}` : ''))
    }
  }

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

  const endSummary =
    endMode === 'after' ? `ends after ${Math.max(1, endCount)} visit${endCount !== 1 ? 's' : ''}`
    : endMode === 'on' && endDate ? `until ${endDate}`
    : 'no end date (kept rolling on your calendar)'

  return (
    <form
      onSubmit={handleSubmit((values) => onSubmit(
        values,
        buildRecurrence(),
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

      {status === 'completed' && (
        <Input label="Actual time on site (minutes)" type="number" min="0" step="5"
          hint="Captured for future pricing intelligence — planned vs. actual time."
          {...register('actual_minutes', { min: 0 })} />
      )}

      {/* Repeat — prominent & discoverable (new jobs) */}
      {!isEdit && (
        <div className="border border-border-strong rounded-xl overflow-hidden">
          <div className="bg-bg-tertiary px-4 py-3 flex items-center gap-2 border-b border-border">
            <Repeat className="w-4 h-4 text-accent" />
            <span className="text-sm font-semibold text-ink">Repeat</span>
            {interval && <span className="ml-auto text-xs text-accent font-medium">{recurrenceLabel(interval.unit, interval.count)} · {endSummary}</span>}
          </div>
          <div className="p-4 space-y-3">
            {/* One-click lawn-care presets */}
            <div className="flex flex-wrap gap-2">
              {([
                { kind: 'weekly', label: 'Weekly Lawn Care' },
                { kind: 'biweekly', label: 'Bi-Weekly Lawn Care' },
                { kind: 'monthly', label: 'Monthly Service' },
              ] as const).map(p => (
                <button key={p.kind} type="button" onClick={() => applyLawnPreset(p.kind)}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Repeats</label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as RepeatPreset)}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
              >
                {PRESET_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-bg-secondary">{o.label}</option>)}
              </select>
            </div>

            {preset === 'custom' && (
              <div className="grid grid-cols-2 gap-4">
                <Input label="Every" type="number" min="1" value={customCount}
                  onChange={(e) => setCustomCount(Math.max(1, Number(e.target.value) || 1))} />
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Unit</label>
                  <select
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value as RecurUnit)}
                    className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                  >
                    <option value="day" className="bg-bg-secondary">Days</option>
                    <option value="week" className="bg-bg-secondary">Weeks</option>
                    <option value="month" className="bg-bg-secondary">Months</option>
                  </select>
                </div>
              </div>
            )}

            {preset !== 'none' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Ends</label>
                  <select
                    value={endMode}
                    onChange={(e) => setEndMode(e.target.value as 'never' | 'on' | 'after')}
                    className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                  >
                    <option value="never" className="bg-bg-secondary">Never ends</option>
                    <option value="on" className="bg-bg-secondary">Ends on date</option>
                    <option value="after" className="bg-bg-secondary">Ends after N visits</option>
                  </select>
                </div>
                {endMode === 'on' && (
                  <Input label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                )}
                {endMode === 'after' && (
                  <Input label="Number of visits" type="number" min="1" value={endCount}
                    onChange={(e) => setEndCount(Math.max(1, Number(e.target.value) || 1))} />
                )}
                <p className="text-xs text-ink-faint">
                  Repeats {recurrenceLabel(interval!.unit, interval!.count).toLowerCase()}, {endSummary}.
                </p>
              </>
            )}
          </div>
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
