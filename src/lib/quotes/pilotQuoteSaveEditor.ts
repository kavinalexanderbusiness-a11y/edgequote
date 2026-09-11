import type { Quote, QuoteFormValues, QuoteOption, QuoteService } from '@/types'
import { splitServices } from '../quoteServices'
import { sortedOptions } from '../quoteOptions'

/** Dormant editor adapter for a complete, owner-authorized baseline. The caller
 * must refuse incomplete/failed reads; an empty replacement set is real data.
 * This preserves the existing page's defaults and its shared line/option order.
 * The existing measured snapshot is intentionally carried into the editor. */
export function pilotQuoteSaveEditorDefaults(
  quote: Quote, services: QuoteService[], options: QuoteOption[],
): Partial<QuoteFormValues> {
  const { primary, extras } = splitServices(services)
  return {
    customer_id: quote.customer_id || '__manual',
    customer_name: quote.customer_name,
    address: quote.address,
    service_type: quote.service_type,
    service_template_id: quote.service_template_id || '',
    initial_price: primary ? primary.unit_price : (quote.initial_price || 0),
    services: extras.map(s => ({
      service_type: s.service_type,
      service_template_id: s.service_template_id || '',
      quantity: s.quantity,
      unit: s.unit || 'each',
      unit_price: s.unit_price,
      est_minutes: s.est_minutes || 0,
      kind: s.kind ?? 'service',
      discount_type: (s.discount_type || '') as '' | 'amount' | 'percent',
      discount_value: s.discount_value || 0,
      notes: s.notes || '',
    })),
    weekly_price: quote.weekly_price || 0,
    biweekly_price: quote.biweekly_price || 0,
    monthly_price: quote.monthly_price || 0,
    measured_sqft: quote.measured_sqft || 0,
    measurement_snapshot: quote.measurement_snapshot == null ? null : structuredClone(quote.measurement_snapshot),
    suggested_price: quote.suggested_price || 0,
    overgrowth_multiplier: 1,
    distance_km: 0,
    hours: quote.hours,
    crew_size: quote.crew_size,
    rate: quote.rate,
    travel_fee: quote.travel_fee,
    custom_travel_required: quote.custom_travel_required || false,
    show_travel_separately: quote.show_travel_separately || false,
    notes: quote.notes || '',
    internal_notes: quote.internal_notes || '',
    status: quote.status,
    has_options: options.length > 0,
    options: sortedOptions(options).map(o => ({
      id: o.id, name: o.name, description: o.description || '',
      price: Number(o.price) || 0, is_recommended: !!o.is_recommended,
    })),
    deposit_type: (quote.deposit_type ?? '') as '' | 'percent' | 'fixed',
    deposit_value: Number(quote.deposit_value) || 0,
  }
}
