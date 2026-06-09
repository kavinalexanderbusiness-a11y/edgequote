'use client'

import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/Input'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { QuoteMeasure } from '@/components/quotes/QuoteMeasure'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { QuoteFormValues, Customer, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { formatCurrency, suggestTravelFee } from '@/lib/utils'
import { laborSuggestion, pricingConfigFromSettings } from '@/lib/pricing'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { Clock, DollarSign, Car, Calculator, AlertTriangle, MapPin, Repeat, Ruler, Sparkles } from 'lucide-react'

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
        initial_price: 0,
        weekly_price: 0,
        biweekly_price: 0,
        monthly_price: 0,
        measured_sqft: 0,
        suggested_price: 0,
        overgrowth_multiplier: 1,
        distance_km: 0,
        hours: 2,
        crew_size: 1,
        rate: DEFAULT_RATE,
        travel_fee: 0,
        notes: '',
        status: 'draft',
        ...defaultValues,
      },
    })

  const [calcLoading, setCalcLoading] = useState(false)
  const [calcMsg, setCalcMsg] = useState<string | null>(null)
  const [showMeasure, setShowMeasure] = useState(false)
  const [includeTravel, setIncludeTravel] = useState(true)
  const [initialManual, setInitialManual] = useState<boolean>((defaultValues?.initial_price ?? 0) > 0)
  const [showBestDays, setShowBestDays] = useState(false)

  const hours = watch('hours') || 0
  const crewSize = watch('crew_size') || 1
  const rate = watch('rate') || DEFAULT_RATE
  const travelFee = watch('travel_fee') || 0
  const customerId = watch('customer_id')
  const templateId = watch('service_template_id')
  const overgrowth = Number(watch('overgrowth_multiplier')) || 1
  const distanceKm = Number(watch('distance_km')) || 0
  const address = watch('address')
  const showTravelSeparately = watch('show_travel_separately')
  const customTravelRequired = watch('custom_travel_required')
  const initialPrice = Number(watch('initial_price')) || 0
  const weeklyPrice = Number(watch('weekly_price')) || 0
  const biweeklyPrice = Number(watch('biweekly_price')) || 0
  const monthlyPrice = Number(watch('monthly_price')) || 0

  const suggestedInitial = laborSuggestion(Number(hours), Number(crewSize), Number(rate), overgrowth || 1)
  const effectiveTotal = initialPrice + Number(travelFee || 0)

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

  useEffect(() => {
    if (!initialManual) setValue('initial_price', suggestedInitial)
  }, [suggestedInitial, initialManual, setValue])

  const travelSuggestion = distanceKm > 0 ? suggestTravelFee(distanceKm, tiers) : null

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

  async function calculateDistance(addr?: string) {
    setCalcMsg(null)
    const base = settings?.base_address
    const dest = addr || address
    if (!base) { setCalcMsg('Set your base address in Settings first.'); return }
    if (!dest) { setCalcMsg('Enter a service address first.'); return }
    setCalcLoading(true)
    try {
      const res = await fetch('/api/distance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: base, destination: dest }),
      })
      const data = await res.json()
      if (res.ok && typeof data.km === 'number') {
        setValue('distance_km', data.km)
        const sugg = suggestTravelFee(data.km, tiers)
        if (includeTravel && !sugg.isCustom && sugg.fee !== null) setValue('travel_fee', sugg.fee)
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

  function toggleIncludeTravel(on: boolean) {
    setIncludeTravel(on)
    if (!on) {
      setValue('travel_fee', 0)
    } else if (distanceKm > 0) {
      const s = suggestTravelFee(distanceKm, tiers)
      if (!s.isCustom && s.fee !== null) setValue('travel_fee', s.fee)
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
  const statusOptions = [
    { value: 'draft', label: 'Draft' }, { value: 'sent', label: 'Sent' },
    { value: 'accepted', label: 'Accepted' }, { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' }, { value: 'paid', label: 'Paid' },
    { value: 'declined', label: 'Declined' },
  ]
  const showManualName = !customerId || customerId === '__manual'

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
                    onSelect={(p) => { field.onChange(p.formatted); calculateDistance(p.formatted) }}
                    error={errors.address?.message}
                  />
                )} />
              <Button type="button" variant="secondary" size="sm"
                onClick={() => { if (!address) { setCalcMsg('Enter an address first.'); return } setShowMeasure(true) }}>
                <Ruler className="w-3.5 h-3.5" /> Measure & price from satellite
              </Button>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><h2 className="text-sm font-semibold text-ink">Service & Labour (suggestion)</h2></CardHeader>
            <CardBody className="space-y-4">
              <Controller name="service_template_id" control={control}
                render={({ field }) => (<Select label="Service (from your templates)" options={templateOptions} {...field} />)} />
              <Input label="Service Name" placeholder="e.g. Lawn Mowing"
                error={errors.service_type?.message}
                {...register('service_type', { required: 'Service is required' })} />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input label="Estimated Hours" type="number" step="0.25" min="0"
                  error={errors.hours?.message}
                  {...register('hours', { required: 'Required', min: { value: 0.25, message: 'Min 0.25' } })} />
                <Input label="Crew Size" type="number" min="1" max="20"
                  error={errors.crew_size?.message}
                  {...register('crew_size', { required: 'Required', min: { value: 1, message: 'Min 1' } })} />
              </div>

              <Input label="Adjustment Multiplier" type="number" step="0.05" min="0"
                hint="Multiplies the rate. e.g. 0.75 (easy), 1.0 (standard), 1.25 (overgrown). Any decimal."
                {...register('overgrowth_multiplier', { min: 0 })} />

              <Input label="Base Rate ($/man-hour)" type="number" step="5" min="0"
                hint="The multiplier adjusts this. Only used to suggest the Initial price below."
                error={errors.rate?.message}
                {...register('rate', { required: 'Required', min: { value: 0, message: 'Rate cannot be negative' } })} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Pricing</h2>
              {initialManual && (
                <span className="text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">Manual Pricing Active</span>
              )}
            </CardHeader>
            <CardBody className="space-y-4">
              <div>
                <Input label="Initial / First Visit Price ($)" type="number" step="1" min="0"
                  hint={initialManual ? 'You set this manually — it overrides the labour suggestion.' : `Suggested from labour: ${formatCurrency(suggestedInitial)}. Type to override.`}
                  {...register('initial_price', { min: 0, onChange: () => setInitialManual(true) })} />
                {initialManual && (
                  <button type="button" onClick={() => setInitialManual(false)}
                    className="text-xs text-accent hover:underline mt-1.5">
                    Use suggested ({formatCurrency(suggestedInitial)})
                  </button>
                )}
              </div>

              <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                  <Repeat className="w-3.5 h-3.5" /> Recurring Maintenance Options (optional)
                </div>
                <p className="text-xs text-ink-faint">Fill any you want to offer. They show on the quote as options the customer can pick.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Input label="Weekly ($/visit)" type="number" step="1" min="0" {...register('weekly_price', { min: 0 })} />
                  <Input label="Bi-Weekly ($/visit)" type="number" step="1" min="0" {...register('biweekly_price', { min: 0 })} />
                  <Input label="Monthly ($/visit)" type="number" step="1" min="0" {...register('monthly_price', { min: 0 })} />
                </div>
              </div>

              <div className="bg-bg-tertiary border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                    <Car className="w-3.5 h-3.5" /> Travel
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => calculateDistance()} loading={calcLoading}>
                    <MapPin className="w-3.5 h-3.5" /> Calculate Distance
                  </Button>
                </div>
                {calcMsg && <p className="text-xs text-accent">{calcMsg}</p>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                  <Input label="Distance (km)" type="number" step="1" min="0"
                    {...register('distance_km', { min: 0 })} />
                  <Input label="Travel Fee ($)" type="number" step="5" min="0"
                    {...register('travel_fee', { min: 0 })} />
                </div>
                {travelSuggestion && (
                  <div className="text-sm">
                    {travelSuggestion.isCustom ? (
                      <span className="text-amber-400">{travelSuggestion.tierLabel}: custom fee required</span>
                    ) : (
                      <span className="text-ink-muted">{travelSuggestion.tierLabel}: <span className="text-accent font-semibold">{formatCurrency(travelSuggestion.fee || 0)}</span></span>
                    )}
                  </div>
                )}
                {customTravelRequired && (
                  <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    Beyond your furthest travel tier — enter a custom travel fee above.
                  </div>
                )}
                {travelSuggestion && !travelSuggestion.isCustom && (
                  <Button type="button" variant="secondary" size="sm" onClick={applySuggestedTravel}>
                    Apply suggested travel fee
                  </Button>
                )}
                <div className="pt-1 space-y-2">
                  <Toggle checked={includeTravel} onChange={toggleIncludeTravel}
                    label={includeTravel ? 'Charging travel fee' : 'Absorbing travel — no fee'} />
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
            <CardHeader><h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> Best scheduling opportunities</h2></CardHeader>
            <CardBody>
              {!address ? (
                <p className="text-xs text-ink-faint">Enter a service address to see the best days to schedule near your existing jobs.</p>
              ) : !showBestDays ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowBestDays(true)}>
                  <Sparkles className="w-3.5 h-3.5" /> Find best days to schedule
                </Button>
              ) : (
                <BestDaySuggestions address={address} />
              )}
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
                <span className="text-ink font-medium">{Number(hours).toFixed(1)} hrs · {crewSize} crew</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-muted"><DollarSign className="w-3.5 h-3.5" /> Labour suggests</span>
                <span className="text-ink-muted">{formatCurrency(suggestedInitial)}</span>
              </div>
              <div className="border-t border-border pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-muted">Initial Visit{initialManual ? ' (manual)' : ''}</span>
                  <span className="text-ink font-semibold">{formatCurrency(initialPrice)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-ink-muted"><Car className="w-3.5 h-3.5" /> Travel{showTravelSeparately ? ' (shown)' : ''}</span>
                  <span className="text-ink font-medium">{formatCurrency(Number(travelFee))}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  <span className="text-sm font-semibold text-ink">First Invoice Total</span>
                  <span className="text-2xl font-bold text-accent">{formatCurrency(effectiveTotal)}</span>
                </div>
              </div>
              {(weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0) && (
                <div className="border-t border-border pt-3 space-y-1.5">
                  <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Maintenance options</p>
                  {weeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium">{formatCurrency(weeklyPrice)}/visit</span></div>}
                  {biweeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium">{formatCurrency(biweeklyPrice)}/visit</span></div>}
                  {monthlyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium">{formatCurrency(monthlyPrice)}/visit</span></div>}
                </div>
              )}
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

      {showMeasure && (
        <QuoteMeasure
          address={address}
          travelFee={Number(travelFee) || 0}
          cfg={pricingConfigFromSettings(settings)}
          onClose={() => setShowMeasure(false)}
          onApply={(price, totalSqft, suggested) => {
            setValue('initial_price', price)
            setValue('measured_sqft', totalSqft)
            setValue('suggested_price', suggested)
            setInitialManual(true); setShowMeasure(false)
          }}
        />
      )}
    </form>
  )
}