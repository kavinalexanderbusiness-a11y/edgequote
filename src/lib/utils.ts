import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { TravelFeeTier } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(dateStr))
}

export function calculateQuote(
  hours: number,
  crewSize: number,
  rate: number,
  travelFee: number
) {
  const manHours = hours * crewSize
  const subtotal = manHours * rate
  const total = subtotal + travelFee
  return { manHours, subtotal, total }
}

export function generateQuoteNumber(index: number): string {
  const year = new Date().getFullYear()
  const num = String(index).padStart(4, '0')
  return `EPS-${year}-${num}`
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// ── Phase 1 additions ──

/**
 * Suggest a travel fee from configured tiers (nothing hardcoded).
 */
export function suggestTravelFee(
  km: number,
  tiers: TravelFeeTier[]
): { fee: number | null; isCustom: boolean; tierLabel: string } {
  const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order)
  for (const tier of sorted) {
    const aboveMin = km >= tier.min_km
    const belowMax = tier.max_km === null ? true : km < tier.max_km
    if (aboveMin && belowMax) {
      const label =
        tier.max_km === null
          ? `${tier.min_km}+ km`
          : `${tier.min_km}–${tier.max_km} km`
      return {
        fee: tier.is_custom ? null : tier.fee ?? 0,
        isCustom: tier.is_custom,
        tierLabel: label,
      }
    }
  }
  return { fee: 0, isCustom: false, tierLabel: 'Unknown' }
}

/**
 * Apply overgrowth multiplier to a base rate.
 * multiplier of 0 means "custom quote required".
 */
export function applyOvergrowth(baseRate: number, multiplier: number): number {
  if (multiplier <= 0) return baseRate
  return baseRate * multiplier
}