import type { PilotQuoteSaveEditorSnapshot } from '../../src/lib/quotes/pilotQuoteSavePlan'
export const baselineId = (n: number) => `85000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const baselineStamp = '2026-09-10T12:00:00.000+00:00'
export const baselineBinding = { ownerId: baselineId(1), quoteId: baselineId(2) }
export const baselinePrivateSentinel = 'PRIVATE_BASELINE_SENTINEL'

// Explicit synthetic source observations. Not a production loader or default
// mapper; the actual initializer remains the only edit-shape adapter.
export function quoteSaveBaselineFixture(): PilotQuoteSaveEditorSnapshot {
  const { ownerId: owner, quoteId: quote } = baselineBinding, customer = baselineId(3), property = baselineId(4), stamp = baselineStamp
  const c = { id: customer, user_id: owner, updated_at: stamp, archived_at: null, name: 'Synthetic customer',
    phone: null, email: null, address: '10 Synthetic Street', acquisition_source: null }
  const p = { id: property, user_id: owner, customer_id: customer, updated_at: stamp, address: c.address, is_primary: true }
  const q = { id: quote, user_id: owner, updated_at: stamp, customer_id: customer, customer_name: c.name, property_id: property, address: c.address }
  return { code: 'snapshot', complete: true, editor_revision: 'a'.repeat(32),
    identity: { code: 'snapshot', complete: true, quote_revision: 'b'.repeat(32), quote: q, customers: [c], old_customer: c, properties: [p] },
    quote: { xmin: '10', row: { ...q, quote_number: 'BASELINE-SYNTHETIC', service_type: 'Synthetic service', service_template_id: null,
      initial_price: 100, weekly_price: null, biweekly_price: null, monthly_price: null, hours: 1.5, crew_size: 2, rate: 50, travel_fee: 0,
      overgrowth_multiplier: 1.25, custom_travel_required: true, show_travel_separately: false, notes: 'Public scope', internal_notes: 'Owner scope',
      measured_sqft: 1234.5, measurement_snapshot: { v: 2, type: 'area', unit: 'sqft', value: 1234.5, parts: [{ label: 'Lawn', value: 1234.5 }],
        measuredAt: stamp, serviceTemplateId: null, serviceName: 'Synthetic service', term: 'one_time', basis: 'flat', rate: 100, price: 100 },
      suggested_price: 90, value_grade: 'B', nearby_count: 3, price_source: 'engine', pricing_config_version_id: baselineId(5),
      deposit_type: 'percent', deposit_value: 50, status: 'sent', selected_option_id: null, accepted_price: null, total: 100, subtotal: 150, man_hours: 3,
      no_charge_reason: baselinePrivateSentinel, no_charge_by: owner } },
    services: [], options: [], addons: [{ xmin: '13', row: { id: baselineId(9), user_id: owner, quote_id: quote, created_at: stamp, updated_at: stamp,
      sort_order: 0, name: 'Private unrelated extra', description: baselinePrivateSentinel, price: 10, is_selected: false } }],
    templates: [], acceptance: { latest: null, current: false, material_fingerprint: 'c'.repeat(32), terms_fingerprint: 'd'.repeat(32) },
    pricing_inputs: { xmin: '11', row: { user_id: owner, pricing_base_charge: 45, pricing_mow_rate: 2, pricing_recommended_mult: 1.1,
      pricing_premium_mult: 1.2, pricing_travel_rate: 1, crew_cost_per_hour: 30, fee_recovery_percent: 0, payment_fee_strategy: 'absorb' } } }
}
export function baselineService(n: number, sort_order = n) {
  return { xmin: String(20 + n), row: { id: baselineId(20 + n), user_id: baselineBinding.ownerId, quote_id: baselineBinding.quoteId,
    created_at: baselineStamp, sort_order, service_type: 'Synthetic service ' + n, service_template_id: null,
    quantity: 1.25, unit: null, unit_price: 12.345, est_minutes: null, discount_type: null, discount_value: null, notes: null, kind: 'service' } }
}
export function baselineOption(n: number, sort_order = n) {
  return { xmin: String(30 + n), row: { id: baselineId(30 + n), user_id: baselineBinding.ownerId, quote_id: baselineBinding.quoteId,
    created_at: baselineStamp, updated_at: baselineStamp, sort_order, name: 'Synthetic option ' + n, description: null, price: 100 + n,
    is_recommended: n === 1 } }
}
