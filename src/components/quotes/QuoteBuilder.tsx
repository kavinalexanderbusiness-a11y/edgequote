'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/Input'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import {
  QuoteFormValues, Customer, ServiceTemplate, TravelFeeTier, BusinessSettings,
  OVERGROWTH_LEVELS, SERVICE_FREQUENCIES,
} from '@/types'
import { calculateQuote, formatCurrency, suggestTravelFee } from '@/lib/utils'
import { Users, Clock, DollarSign, Car, Calculator, Sprout, AlertTriangle, MapPin, Repeat } from 'lucide-react'

interface QuoteBuilderProps {
  customers: Customer[]
  templates: ServiceTemplate[]
  tiers: TravelFeeTier[]
  settings?: BusinessSettings | null
  defaultCustomerId?: string
  defaultValues?: Partial<QuoteFormValues>
  onSubmit: (values: QuoteFormValues) => Promise<void>
  isEdit?: boolean
}

const DEFAULT_RATE = 50

export function QuoteBuilder({
  customers, templates, tiers, settings, defaultCustomerId, defaultValues, onSubmit, isEdit,
}: QuoteBuilderProps) {
  const router = useRouter()
  const { register, handleSubmit, watch, setValue, control, formState: { errors, isSubmitting } } =
    useForm<QuoteFormValues>({
      defaultValues: {
        customer_id: defaultCustomerId || '',
        customer_name: '',
        address: '',
        service_type: '',
        service_template_id: '',
        service_frequency: 'one_time',
        initial_price: 0,
        recurring_price: 0,
        recurring_interval: '',
        overgrowth_multiplier: 1,
        distance_km: 0,
        hours: 2,
        crew_size: 1,
        rate: DEFAULT_RATE,
        travel_fee: 0,
        custom_travel_required: false,
        show_travel_separately: false,
        notes: '',
        status: 'draft',
        ...defaultValues,
      },
    })

  const [calcLoading, setCalcLoading] = useState(false)
  const [calcMsg, setCalcMsg] = useState<string | null>(null)

  const hours = watch('hours') || 0
  const crewSize = watch('crew_size') || 1
  const rate = watch('rate') || DEFAULT_RATE
  const travelFee = watch('travel_fee') || 0
  const customerId = watch('customer_id')
  const templateId = watch('service_template_id')
  const overgrowth = Number(watch('overgrowth_multiplier')) || 1
  const distanceKm = Number(watch('distance_km')) || 0
  const address = watch('address')
  const frequency = watch('service_frequency')
  const showTravelSeparately = watch('show_travel_separately')
  const customTravelRequired = watch('custom_travel_required')

  const isRecurring = frequency === 'initial_weekly' || frequency === 'initial_biweekly'
  const isCustomOvergrowth = overgrowth === 0
  const effectiveRate = isCustomOvergrowth ? Number(rate) : Number(rate) * overgrowth
  const { manHours, subtotal, total } = calculateQuote(
    Number(hours), Number(crewSize), effectiveRate, Number(travelFee)
  )

  useEffect(() => {
    if (!customerId || customerId === '__manual') return
    const customer = customers.find(c => c.id === customerId)
    if (customer) {
      setValue('customer_name', customer.name)
      if (!isEdit && customer.address) {
        const full = [customer.address, customer.city, customer.province].filter(Boolean).join(', ')
        setValue('address', full)
      }
    }
  }, [customerId, customers, setValue, isEdit])

  useEffect(() => {
    if (!templateId) return
    const t = templates.find(s => s.id === templateId)
    if (t) {
      setValue('service_type', t.name)
      setValue('rate', t.default_rate)
      if (!isEdit && t.default_description) setValue('notes', t.default_description)
    }
  }, [templateId, templates, setValue, isEdit])

  // Keep recurring_interval in sync with frequency
  useEffect(() => {
    if (frequency === 'initial_weekly') setValue('recurring_interval', 'weekly')
    else if (frequency === 'initial_biweekly') setValue('recurring_interval', 'bi_weekly')
    else setValue('recurring_interval', '')
  }, [frequency, setValue])

  // When a one-time quote, keep initial_price synced to the computed total
  useEffect(() => {
    if (!isRecurring) setValue('initial_price', total)
  }, [total, isRecurring, setValue])

  const travelSuggestion = distanceKm > 0 ? suggestTravelFee(distanceKm, tiers) : null

  // Auto-flag custom travel when distance exceeds top tier
  useEffect(() => {
    if (travelSuggestion?.isCustom) {
      setValue('custom_travel_required', true)
    } else if (distanceKm > 0) {
      setValue('custom_travel_required', false)
    }
  }, [travelSuggestion, distanceKm, setValue])

  function applySuggestedTravel() {
    if (travelSuggestion && !travelSuggestion.isCustom && travelSuggestion.fee !== null) {
      setValue('travel_fee', travelSuggestion.fee)
    }
  }

  async function calculateDistance() {
    setCalcMsg(null)
    const base = settings?.base_address
    if (!base) { setCalcMsg('Set your base address in Settings first.'); return }
    if (!address) { setCalcMsg('Enter a service address first.'); return }
    setCalcLoading(true)
    try {
      const res = await fetch('/api/distance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: base, destination: address }),
      })
      const data = await res.json()
      if (res.ok && typeof data.km === 'number') {
        setValue('distance_km', data.km)
        setCalcMsg(`${data.km} km${data.durationText ? ` · ${data.durationText} drive` : ''}`)
      } else {
        setCalcMsg(data.error || 'Could not calculate distance.')
      }
    } catch {
      setCalcMsg('Distance lookup failed.')
    } finally {
      setCalcLoading(false)
    }
  }

  const customerOptions = [
    { value: '', label: 'Select a customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
    { value: '__manual', label: '+ Enter manually' },
  ]
  const activeTemplates = templates.filter(t => t.is_active)
  const templateOptions = [
    { value: '', label: 'Select a service...' },
    ...activeTemplates.map(t => ({ value: t.id, label: `${t.name} — ${formatCurrency(t.default_rate)}/hr` })),
  ]
  const frequencyOptions = SERVICE_FREQUENCIES.map(f => ({ value: f.value, label: f.label }))
  const overgrowthOptions = OVERGROWTH_LEVELS.map((o) => ({
    value: String(o.multiplier),
    label: o.multiplier === 0 ? `${o.label} (custom quote)` : `${o.label} (${o.multiplier}×)`,
  }))
  const statusOptions = [
    { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' },
    { value: 'accepted', label: 'Accepted' }, { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' },
    { value: 'declined', label: 'Declined' },
  ]
  const showManualName = !customerId || customerId === '__manual'
  const recurringLabel = frequency === 'initial_weekly' ? 'Weekly Maintenance' : 'Bi-Weekly Maintenance'

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader><h2 className="text-sm font-semibold text-ink">Customer</h2></CardHeader>
            <CardBody className="space-y-4">
              <Controller name="customer_id" control={control}
                render={({ field }) => (<Select label="Select Customer" options={customerOptions} {...field} />)} />
              {showManualName && (
                <Input label="Customer Name" placeholder="Full name"
                  error={errors.customer_name?.message}
                  {...register('customer_name', { required: 'Customer name is required' })} />
              )}
              <Controller name="address" control={control}
                rules={{ required: 'Address is required' }}
                render={({ field }) => (
                  <AddressAutocomplete
                    label="Service Address"
                    placeholder="123 Main Street, Calgary, AB"
                    value={field.value || ''}
                    onChange={field.onChange}
                    onSelect={(p) => field.onChange(p.formatted)}
                    error={errors.address?.message}
                  />
                )} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader><h2 className="text-sm font-semibold text-ink">Service Details</h2></CardHeader>
            <CardBody className="space-y-4">
              <Controller name="service_template_id" control={control}
                render={({ field }) => (<Select label="Service (from your templates)" options={templateOptions} {...field} />)} />
              <Input label="Service Name" placeholder="e.g. Lawn Mowing"
                hint="Auto-filled from template — editable"
                error={errors.service_type?.message}
                {...register('service_type', { required: 'Service is required' })} />

              <Controller name="service_frequency" control={control}
                render={({ field }) => (<Select label="Service Frequency" options={frequencyOptions} {...field} />)} />

              <div className="grid grid-cols-2 gap-4">
                <Input label="Estimated Hours" type="number" step="0.5" min="0.5"
                  error={errors.hours?.message}
                  {...register('hours', { required: 'Required', min: { value: 0.5, message: 'Min 0.5' } })} />
                <Input label="Crew Size" type="number" min="1" max="20"
                  error={errors.crew_size?.message}
                  {...register('crew_size', { required: 'Required', min: { value: 1, message: 'Min 1' } })} />
              </div>

              <Controller name="overgrowth_multiplier" control={control}
                render={({ field }) => (<Select label="Overgrowth Level (first visit)" options={overgrowthOptions} {...field} />)} />
              {isCustomOvergrowth && (
                <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  Over 2 feet requires a custom quote. Set the rate manually based on a site assessment.
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Input label="Base Rate ($/man-hour)" type="number" step="5" min="50"
                  hint="Overgrowth multiplies this. Min $50."
                  error={errors.rate?.message}
                  {...register('rate', { required: 'Required', min: { value: 50, message: 'Minimum rate is $50/man-hour' } })} />
                <Input label="Travel Fee ($)" type="number" step="5" min="0"
                  {...register('travel_fee', { min: 0 })} />
              </div>

              {/* Recurring pricing */}
              {isRecurring && (
                <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                    <Repeat className="w-3.5 h-3.5" /> Recurring Pricing
                  </div>
                  <p className="text-xs text-ink-faint">The first visit (with overgrowth) is the initial price. Set the cheaper recurring maintenance price below.</p>
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="Initial Visit ($)" type="number" step="1" min="0"
                      hint="First visit — usually higher"
                      {...register('initial_price', { min: 0 })} />
                    <Input label={`${recurringLabel} ($)`} type="number" step="1" min="0"
                      hint="Per recurring visit"
                      {...register('recurring_price', { min: 0 })} />
                  </div>
                </div>
              )}

              {/* Travel distance */}
              <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                    <Car className="w-3.5 h-3.5" /> Travel Distance
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={calculateDistance} loading={calcLoading}>
                    <MapPin className="w-3.5 h-3.5" /> Calculate Distance
                  </Button>
                </div>
                {calcMsg && <p className="text-xs text-accent">{calcMsg}</p>}
                <div className="grid grid-cols-2 gap-4 items-end">
                  <Input label="Distance (km)" type="number" step="1" min="0"
                    {...register('distance_km', { min: 0 })} />
                  {travelSuggestion && (
                    <div className="text-sm pb-2.5">
                      {travelSuggestion.isCustom ? (
                        <span className="text-amber-400">{travelSuggestion.tierLabel}: custom fee required</span>
                      ) : (
                        <span className="text-ink-muted">{travelSuggestion.tierLabel}: <span className="text-accent font-semibold">{formatCurrency(travelSuggestion.fee || 0)}</span></span>
                      )}
                    </div>
                  )}
                </div>
                {customTravelRequired && (
                  <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    This property is beyond your furthest travel tier. Enter a custom travel fee manually above.
                  </div>
                )}
                {travelSuggestion && !travelSuggestion.isCustom && (
                  <Button type="button" variant="secondary" size="sm" onClick={applySuggestedTravel}>
                    Apply suggested travel fee
                  </Button>
                )}
                <div className="pt-1">
                  <Controller name="show_travel_separately" control={control}
                    render={({ field }) => (
                      <Toggle checked={field.value} onChange={field.onChange}
                        label={field.value ? 'Show travel as separate line on PDF' : 'Travel rolled into total on PDF'} />
                    )} />
                </div>
              </div>

              <Textarea label="Notes" placeholder="Job-specific details, access instructions, gate codes..."
                {...register('notes')} />
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <Controller name="status" control={control}
                render={({ field }) => (<Select label="Quote Status" options={statusOptions} {...field} />)} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="sticky top-6">
            <CardHeader className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink">Quote Preview</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-muted"><Clock className="w-3.5 h-3.5" /> Hours</span>
                <span className="text-ink font-medium">{Number(hours).toFixed(1)} hrs</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-muted"><Users className="w-3.5 h-3.5" /> Crew Size</span>
                <span className="text-ink font-medium">{crewSize} worker{crewSize > 1 ? 's' : ''}</span>
              </div>
              {overgrowth !== 1 && !isCustomOvergrowth && (
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-ink-muted"><Sprout className="w-3.5 h-3.5" /> Overgrowth</span>
                  <span className="text-ink font-medium">{overgrowth}×</span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-muted"><DollarSign className="w-3.5 h-3.5" /> Rate</span>
                <span className="text-ink font-medium">
                  {overgrowth !== 1 && !isCustomOvergrowth ? (
                    <><span className="text-ink-faint line-through mr-1">{formatCurrency(Number(rate))}</span>{formatCurrency(effectiveRate)}/hr</>
                  ) : (<>{formatCurrency(Number(rate))}/hr</>)}
                </span>
              </div>
              <div className="border-t border-border pt-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-muted">Labour</span>
                  <span className="text-ink font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-sm mt-2">
                  <span className="flex items-center gap-2 text-ink-muted"><Car className="w-3.5 h-3.5" /> Travel{showTravelSeparately ? ' (shown)' : ' (in total)'}</span>
                  <span className="text-ink font-medium">{formatCurrency(Number(travelFee))}</span>
                </div>
              </div>
              <div className="border-t border-border pt-3">
                {isRecurring ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink-muted">Initial Visit</span>
                      <span className="text-lg font-bold text-ink">{formatCurrency(Number(watch('initial_price')) || total)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink-muted">{recurringLabel}</span>
                      <span className="text-lg font-bold text-accent">{formatCurrency(Number(watch('recurring_price')) || 0)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">Total</span>
                    <span className="text-2xl font-bold text-accent">{formatCurrency(total)}</span>
                  </div>
                )}
              </div>
              <div className="pt-2 space-y-2">
                <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                  {isEdit ? 'Update Quote' : 'Save Quote'}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>Cancel</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </form>
  )
}