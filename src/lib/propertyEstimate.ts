import { pricePlans, type PricedPlan, type ServicePricingPlan } from '@/lib/measurePricing'
import { M2_TO_SQFT, M_TO_FT } from '@/lib/measure/geometry'

export type AreaUnit = 'sqft' | 'sqm'
export type AreaPart = { id: string; label: string; mode: 'area' | 'rectangle'; area: string; length: string; width: string; unit: AreaUnit; excluded: boolean }
export type AreaResult = { sqft: number | null; included: number; excluded: number; problem: string | null }

export function newAreaPart(id: string, excluded = false): AreaPart {
  return { id, label: '', mode: 'area', area: '', length: '', width: '', unit: 'sqft', excluded }
}

function positive(input: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input.trim())) return null
  const n = Number(input)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function partSqft(part: AreaPart): number | null {
  const a = positive(part.mode === 'rectangle' ? part.length : part.area)
  const b = part.mode === 'rectangle' ? positive(part.width) : 1
  if (a === null || b === null) return null
  const sqft = a * b * (part.unit === 'sqm' ? M2_TO_SQFT : 1)
  return Number.isFinite(sqft) && sqft <= 100_000_000 ? sqft : null
}

/** Owner-entered areas only. Empty, invalid or over-excluded areas never imply free work. */
export function estimateArea(parts: readonly AreaPart[]): AreaResult {
  let included = 0, excluded = 0
  for (const part of parts) {
    const value = partSqft(part)
    if (value === null) {
      return { sqft: null, included, excluded, problem: 'Enter a positive area for each section, or remove unused sections.' }
    }
    if (part.excluded) excluded += value
    else included += value
  }
  const net = included - excluded
  if (net <= 0) return { sqft: null, included, excluded, problem: excluded ? 'Excluded area must be smaller than the service area.' : 'Add the area you want to service.' }
  const sqft = net
  if (!Number.isFinite(sqft) || sqft > 100_000_000) return { sqft: null, included, excluded, problem: 'Check the area and units before pricing this property.' }
  return { sqft, included, excluded, problem: null }
}

/** Display conversion never replaces the original inputs; repeated unit switches cannot drift. */
export function displayPartInput(part: AreaPart, field: 'area' | 'length' | 'width', unit: AreaUnit): string {
  const value = positive(part[field])
  if (part.unit === unit || value === null) return part[field]
  const factor = field === 'area' ? M2_TO_SQFT : M_TO_FT
  return String(Number((part.unit === 'sqm' ? value * factor : value / factor).toPrecision(12)))
}

export function editPartInput(part: AreaPart, field: 'area' | 'length' | 'width', input: string, unit: AreaUnit): AreaPart {
  return { ...part, area: displayPartInput(part, 'area', unit), length: displayPartInput(part, 'length', unit), width: displayPartInput(part, 'width', unit), unit, [field]: input }
}

/** The Price Book remains the only money engine. A reviewed area is required even for flat plans. */
export function propertyEstimatePlans(plans: ServicePricingPlan[], area: AreaResult): PricedPlan[] {
  return area.sqft === null ? [] : pricePlans(plans, area.sqft, 'area')
}

export const AUTOMATIC_MEASUREMENT = {
  available: false,
  message: 'Automatic lawn and driveway detection is not connected yet. Enter your measured areas to calculate an estimate.',
} as const
