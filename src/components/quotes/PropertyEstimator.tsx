'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { Calculator, Check, ChevronRight, Plus, Ruler, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SurfaceScanner, type ScannedArea } from '@/components/quotes/SurfaceScanner'
import { getCacheGeneration, getCacheOwner, subscribeCacheOwner } from '@/lib/clientCache'
import { defaultPlan, formatPlanPrice, measurementTypeFor } from '@/lib/measurePricing'
import { M2_TO_SQFT } from '@/lib/measure/geometry'
import { AUTOMATIC_MEASUREMENT, displayPartInput, editPartInput, estimateArea, newAreaPart, propertyEstimatePlans, type AreaPart, type AreaUnit } from '@/lib/propertyEstimate'
import type { ServiceTemplate, ServicePricingPlanRow } from '@/types'

export interface PropertyEstimatorProps {
  ownerId: string
  businessName: string
  services: Array<Pick<ServiceTemplate, 'id' | 'name' | 'measured_by' | 'pricing_display_type'>>
  plans: Array<Pick<ServicePricingPlanRow, 'id' | 'service_template_id' | 'term' | 'basis' | 'rate' | 'is_recommended' | 'sort_order'>>
  loadError?: string
}

export function PropertyEstimator(props: PropertyEstimatorProps) {
  const router = useRouter()
  const generation = useSyncExternalStore(subscribeCacheOwner, getCacheGeneration, () => -1)
  const ownerMatches = generation !== -1 && getCacheOwner() === props.ownerId
  if (!ownerMatches) return <Card className="max-w-3xl mx-auto p-6 space-y-3">
    <h1 className="text-xl font-bold text-ink">Property estimator</h1>
    <p className="text-sm text-ink-muted">Checking your workspace. Refresh if you have changed accounts.</p>
    <Button variant="secondary" onClick={() => router.refresh()}>Refresh workspace</Button>
  </Card>
  return <EstimatorWorkspace key={`${props.ownerId}:${generation}`} {...props} />
}

function EstimatorWorkspace({ businessName, services, plans, loadError }: PropertyEstimatorProps) {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [surface, setSurface] = useState('lawn')
  const [serviceId, setServiceId] = useState('')
  const [unit, setUnit] = useState<AreaUnit>('sqft')
  const [parts, setParts] = useState<AreaPart[]>([newAreaPart('1')])
  const nextId = useRef(2)
  const [term, setTerm] = useState('')
  const [reviewed, setReviewed] = useState<string | null>(null)
  const [hasEdited, setHasEdited] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const areaServices = services.filter(service => measurementTypeFor(service) === 'area')
  const service = areaServices.find(item => item.id === serviceId)
  const area = estimateArea(parts)
  const servicePlans = service ? plans.filter(plan => plan.service_template_id === service.id) : []
  const priced = propertyEstimatePlans(servicePlans, area)
  const available = priced.filter(plan => plan.price !== null && Number.isFinite(plan.price))
  const chosen = available.find(plan => plan.term === term) ?? defaultPlan(available)
  // Data refreshes and every estimate input are part of review identity. A changed rate is never pre-approved.
  const reviewKey = JSON.stringify({ label, surface, service, parts, chosen })
  const isReviewed = reviewed === reviewKey && !loadError
  const canReview = !!service && area.sqft !== null && !!chosen && !loadError
  const areaLabel = unit === 'sqft' ? 'sq ft' : 'm²'
  const lengthLabel = unit === 'sqft' ? 'ft' : 'm'
  const number = (sqft: number) => (unit === 'sqm' ? sqft / M2_TO_SQFT : sqft).toLocaleString('en-CA', { maximumFractionDigits: 2 })
  const updatePart = (id: string, update: (part: AreaPart) => AreaPart) => {
    setHasEdited(true)
    setParts(current => current.map(part => part.id === id ? update(part) : part))
  }
  const addPart = (excluded: boolean) => {
    const id = String(nextId.current++)
    setParts(current => current.length >= 20 ? current : [...current, { ...newAreaPart(id, excluded), unit }])
  }
  const useScannedArea = ({ sqft, ...imageBasis }: ScannedArea) => {
    if (parts.length >= 20) return false
    const id = String(nextId.current++)
    const part = { ...newAreaPart(id), label: `${surface === 'driveway' ? 'Driveway' : surface === 'lawn' ? 'Lawn' : 'Area'} from image`, area: String(sqft), imageBasis }
    setParts(current => current.length >= 20 ? current : current.length === 1 && !current[0].label.trim() && !current[0].excluded && !current[0].area.trim() && !current[0].length.trim() && !current[0].width.trim()
      ? [part] : [...current, part])
    setHasEdited(true); setScannerOpen(false)
    return true
  }
  const imageParts = parts.filter(part => part.imageBasis).length
  const source = imageParts === 0 ? 'measurements entered by you' : imageParts === parts.length ? 'reviewed image selection' : 'entered measurements and reviewed image selection'

  return <div className="max-w-5xl mx-auto space-y-6 pb-8">
    <PageHeader title="Property estimator" description={`${businessName} · Measure the work. See your price.`}
      crumb={{ label: 'Quotes', href: '/dashboard/quotes' }} />

    {loadError && <Card className="p-5 space-y-3 border-amber-500/30" role="alert">
      <p className="font-semibold text-ink">Your pricing could not be loaded</p>
      <p className="text-sm text-ink-muted">{loadError}</p>
      <Button variant="secondary" onClick={() => router.refresh()}>Try again</Button>
    </Card>}

    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
      <div className="space-y-5 min-w-0">
        <Card className="p-5 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold text-ink"><Ruler className="w-4 h-4 text-accent-text" />1. Choose the work</h2>
          <Input label="Property or job label" placeholder="Address or a name you’ll recognize" value={label} maxLength={200}
            onChange={event => setLabel(event.target.value)} hint="Optional. Kept on this page only." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Area type" value={surface} onChange={event => setSurface(event.target.value)}
              options={[{ value: 'lawn', label: 'Lawn' }, { value: 'driveway', label: 'Driveway' }, { value: 'other', label: 'Other area' }]} />
            <Select label="Your service" value={serviceId} onChange={event => { setServiceId(event.target.value); setTerm('') }}
              placeholder="Choose a service" disabled={!!loadError}
              options={areaServices.map(item => ({ value: item.id, label: item.name }))} />
          </div>
          {!loadError && areaServices.length === 0 && <div className="rounded-xl bg-bg-tertiary p-4 space-y-2">
            <p className="text-sm text-ink-muted">Add an area-based service and its pricing plans to start estimating.</p>
            <ButtonLink href="/dashboard/settings/templates" variant="secondary">Open Price Book</ButtonLink>
          </div>}
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap gap-3 items-center justify-between">
            <h2 className="font-semibold text-ink">2. Enter measured areas</h2>
            <div className="w-32"><Select label="Units" value={unit} onChange={event => setUnit(event.target.value as AreaUnit)}
              options={[{ value: 'sqft', label: 'Feet · sq ft' }, { value: 'sqm', label: 'Metres · m²' }]} /></div>
          </div>
          <p className="text-xs text-ink-muted">Use your own measurements. Include each area once; subtract areas you won’t service.</p>
          {scannerOpen ? <SurfaceScanner onUse={useScannedArea} onClose={() => setScannerOpen(false)} canApply={parts.length < 20} />
            : <Button variant="secondary" disabled={parts.length >= 20} onClick={() => setScannerOpen(true)}>Scan an overhead image</Button>}
          <div className="space-y-3">
            {parts.map((part, index) => <fieldset key={part.id} className="rounded-xl border border-border p-4 space-y-3">
              <legend className="px-1 text-xs font-semibold text-ink-muted">{part.excluded ? 'Exclusion' : 'Area'} {index + 1}</legend>
              <div className="flex gap-2 items-end">
                <div className="flex-1 min-w-0"><Input label={`Section ${index + 1} name`} value={part.label} maxLength={80}
                  placeholder={part.excluded ? 'e.g. garden bed' : surface === 'driveway' ? 'e.g. main driveway' : 'e.g. front lawn'}
                  onChange={event => updatePart(part.id, p => ({ ...p, label: event.target.value }))} /></div>
                <Button variant="ghost" aria-label={`Remove section ${index + 1}`} onClick={() => { setHasEdited(true); setParts(current => current.filter(p => p.id !== part.id)) }}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select label={`Section ${index + 1} measurement`} value={part.mode} onChange={event => updatePart(part.id, p => ({ ...p, mode: event.target.value as AreaPart['mode'], imageBasis: undefined }))}
                  options={[{ value: 'area', label: 'Enter area' }, { value: 'rectangle', label: 'Length × width' }]} />
                <Select label={`Section ${index + 1} treatment`} value={part.excluded ? 'exclude' : 'include'} onChange={event => updatePart(part.id, p => ({ ...p, excluded: event.target.value === 'exclude' }))}
                  options={[{ value: 'include', label: 'Include' }, { value: 'exclude', label: 'Subtract' }]} />
              </div>
              {part.mode === 'area'
                ? <Input label={`Section ${index + 1} area (${areaLabel})`} value={displayPartInput(part, 'area', unit)} inputMode="decimal" maxLength={24}
                    onChange={event => updatePart(part.id, p => editPartInput(p, 'area', event.target.value, unit))} />
                : <div className="grid grid-cols-2 gap-3">{(['length', 'width'] as const).map(field => <Input key={field}
                    label={`Section ${index + 1} ${field} (${lengthLabel})`} inputMode="decimal" maxLength={24}
                    value={displayPartInput(part, field, unit)} onChange={event => updatePart(part.id, p => editPartInput(p, field, event.target.value, unit))} />)}</div>}
              {part.imageBasis && <p className="text-xs text-ink-muted">Reviewed image selection · {part.imageBasis.pixelCount.toLocaleString('en-CA')} pixels · reference {part.imageBasis.referenceFeet.toLocaleString('en-CA', { maximumFractionDigits: 2 })} ft. Editing the measurement replaces this image basis.</p>}
            </fieldset>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => addPart(false)} disabled={parts.length >= 20}><Plus className="w-4 h-4" />Add area</Button>
            <Button variant="ghost" onClick={() => addPart(true)} disabled={parts.length >= 20}>Subtract an area</Button>
          </div>
          {parts.length >= 20 && <p className="text-xs text-ink-muted">Up to 20 sections per estimate.</p>}
          {hasEdited && area.problem && <p className="text-sm text-amber-400" role="status">{area.problem}</p>}
          <details className="text-xs text-ink-muted border-t border-border pt-3">
            <summary className="cursor-pointer py-2">About automatic scanning</summary>
            <p className="pt-2 leading-relaxed">{AUTOMATIC_MEASUREMENT.message}</p>
          </details>
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 min-w-0" aria-label="Estimate summary">
        <Card className="p-5 space-y-4">
          <h2 className="flex items-center gap-2 font-semibold text-ink"><Calculator className="w-4 h-4 text-accent-text" />3. Review your estimate</h2>
          <div className="border-b border-border pb-4">
            <p className="text-xs text-ink-muted">Net service area</p>
            <p className="text-3xl font-bold tracking-tight text-ink mt-1">{area.sqft === null ? '—' : number(area.sqft)} <span className="text-sm font-medium text-ink-muted">{areaLabel}</span></p>
            {area.sqft !== null && <p className="text-xs text-ink-muted mt-2">{number(area.included)} included − {number(area.excluded)} excluded</p>}
            <p className="text-xs text-ink-faint mt-2">Source: {source}.</p>
          </div>
          {!service && <p className="text-sm text-ink-muted">Choose a service to see your configured prices.</p>}
          {service && area.sqft === null && <p className="text-sm text-ink-muted">Complete the measurements to calculate this estimate.</p>}
          {service && !loadError && servicePlans.length === 0 && <div className="space-y-2">
            <p className="text-sm text-ink-muted">This service has no pricing plans yet.</p>
            <ButtonLink href="/dashboard/settings/templates" variant="secondary">Set up pricing</ButtonLink>
          </div>}
          {!loadError && priced.length > 0 && <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-ink-muted mb-2">{service?.name} · Choose a plan</legend>
            {priced.map(plan => <label key={plan.term} className={`block rounded-xl border p-3 ${chosen?.term === plan.term ? 'border-accent/50 bg-accent/5' : 'border-border'} ${plan.price === null ? 'opacity-60' : 'cursor-pointer'}`}>
              <span className="flex items-start gap-2">
                <input type="radio" name="estimate-plan" className="mt-1 accent-accent" disabled={plan.price === null} checked={chosen?.term === plan.term}
                  onChange={() => setTerm(plan.term)} />
                <span className="min-w-0"><span className="block text-sm font-semibold text-ink">{plan.label}{plan.isRecommended ? ' · Recommended' : ''}</span>
                  <span className="block text-lg font-bold text-ink mt-1">{formatPlanPrice(plan) ?? 'Rate not configured'}</span>
                  <span className="block text-xs text-ink-muted mt-1 break-words">{plan.basisText}</span></span>
              </span>
            </label>)}
          </fieldset>}
          <p className="text-xs text-ink-muted leading-relaxed">Base service price only. Review travel, materials, site conditions and taxes when preparing the final quote.</p>
          <Button className="w-full" disabled={!canReview} onClick={() => setReviewed(reviewKey)}>
            {isReviewed ? <Check className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {isReviewed ? 'Estimate reviewed' : reviewed ? 'Review updated estimate' : 'Review estimate'}
          </Button>
          {isReviewed && <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-1" role="status">
            <p className="font-semibold text-sm text-ink">{label.trim() || 'Property estimate'}</p>
            <p className="text-sm text-ink">{service?.name} · {chosen && formatPlanPrice(chosen)}</p>
            <p className="text-xs text-ink-muted">{number(area.sqft!)} {areaLabel} · {surface === 'other' ? 'Other area' : surface === 'lawn' ? 'Lawn' : 'Driveway'} · Manually reviewed</p>
          </div>}
          <p className="text-xs text-ink-faint text-center">Estimate only — not saved or sent. Leaving this page clears it.</p>
        </Card>
      </aside>
    </div>

  </div>
}
