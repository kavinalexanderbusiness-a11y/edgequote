// Actual pure estimator/catalogue functions. No SDK, provider, storage or React
// substitute is loaded; the independent browser proof covers the UI bindings.
import {
  newAreaPart, partSqft, estimateArea, displayPartInput, editPartInput,
  propertyEstimatePlans, AUTOMATIC_MEASUREMENT, type AreaPart,
} from '../../src/lib/propertyEstimate'
import { M2_TO_SQFT, M_TO_FT } from '../../src/lib/measure/geometry'
import { pricePlans, type ServicePricingPlan } from '../../src/lib/measurePricing'
import { PRODUCT_PLAN_STATUS, PROPOSED_PRODUCT_PLANS } from '../../src/lib/productPlans'

type Check = (name: string, passed: boolean, detail?: string) => void

export function verifyPropertyEstimator(check: Check): void {
  const equal = (name: string, actual: unknown, expected: unknown) => check(name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  const near = (name: string, actual: number | null, expected: number) => check(name,
    actual !== null && Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10,
    `expected approximately ${expected}, got ${actual}`)
  const part = (changes: Partial<AreaPart> = {}): AreaPart => ({ ...newAreaPart('fixture-area'), area: '1000', ...changes })
  const plan = (changes: Partial<ServicePricingPlan> = {}): ServicePricingPlan => ({
    service_template_id: 'fixture-service', term: 'one_time', basis: 'per_unit', rate: 0.035, ...changes,
  })

  console.log('\nProperty estimates use entered measurements and configured catalogue prices')
  equal('new section has no invented area', partSqft(newAreaPart('empty')), null)
  equal('new subtraction section is explicitly excluded', newAreaPart('excluded', true).excluded, true)
  equal('no sections is unknown, not free work', estimateArea([]).sqft, null)
  near('entered square feet remain square feet', partSqft(part({ area: ' 1234.5 ' })), 1234.5)
  near('entered square metres use the canonical area conversion', partSqft(part({ area: '123.45', unit: 'sqm' })), 123.45 * M2_TO_SQFT)
  near('feet rectangle multiplies dimensions, not dormant area', partSqft(part({ mode: 'rectangle', area: '9999', length: '12.5', width: '8' })), 100)
  near('metre rectangle converts its square area once', partSqft(part({ mode: 'rectangle', unit: 'sqm', length: '12.5', width: '8' })), 100 * M2_TO_SQFT)
  const mixed = estimateArea([
    part({ area: '1000' }), part({ mode: 'rectangle', length: '20', width: '10' }),
    part({ area: '100', excluded: true }), part({ area: '10', unit: 'sqm', excluded: true }),
  ])
  near('multiple included sections add together', mixed.included, 1200)
  near('exclusions can mix measurement units', mixed.excluded, 100 + 10 * M2_TO_SQFT)
  near('only net included minus excluded area reaches pricing', mixed.sqft, 1100 - 10 * M2_TO_SQFT)
  equal('valid mixed sections have no area error', mixed.problem, null)
  for (const invalid of ['', ' ', '0', '0.0', '-1', 'NaN', 'Infinity', '1e3', '1,000', '12 sqm', '1..2', '9'.repeat(400)]) {
    const bad = part({ area: invalid })
    check(`invalid area is refused (${JSON.stringify(invalid.length > 30 ? 'overflowing decimal' : invalid)})`,
      partSqft(bad) === null && estimateArea([bad]).sqft === null)
  }
  equal('one unfinished rectangle dimension refuses pricing', partSqft(part({ mode: 'rectangle', length: '10', width: '' })), null)
  equal('negative rectangle dimension cannot cancel into positive area', partSqft(part({ mode: 'rectangle', length: '-10', width: '-10' })), null)
  equal('overflowing rectangle product is refused', partSqft(part({ mode: 'rectangle', length: '9'.repeat(200), width: '9'.repeat(200) })), null)
  equal('an unused blank section prevents partial area pricing', estimateArea([part(), newAreaPart('unfinished')]).sqft, null)
  equal('an invalid exclusion cannot be silently omitted', estimateArea([part(), part({ excluded: true, area: '' })]).sqft, null)
  equal('fully excluded work has no estimate', estimateArea([part(), part({ excluded: true })]).sqft, null)
  equal('over-excluded work has no negative estimate', estimateArea([part(), part({ excluded: true, area: '1001' })]).sqft, null)
  equal('exclusion without an included area cannot price', estimateArea([part({ excluded: true })]).sqft, null)
  near('upper supported area is still measurable', estimateArea([part({ area: '100000000' })]).sqft, 100000000)
  equal('a single excessive area is refused', partSqft(part({ area: '100000001' })), null)
  equal('many valid pieces cannot exceed the aggregate limit', estimateArea([part({ area: '60000000' }), part({ area: '60000000' })]).sqft, null)

  const original = Object.freeze(part({ area: '1234.56789012345', length: '43.21', width: '12.345' }))
  const originalBytes = JSON.stringify(original), originalSqft = partSqft(original)
  for (let i = 0; i < 200; i++) {
    for (const field of ['area', 'length', 'width'] as const) {
      displayPartInput(original, field, 'sqm'); displayPartInput(original, field, 'sqft')
    }
  }
  equal('repeated display-unit switches never mutate stored inputs', JSON.stringify(original), originalBytes)
  equal('repeated display-unit switches preserve exact physical area', partSqft(original), originalSqft)
  equal('returning to original units preserves original input precision', displayPartInput(original, 'area', 'sqft'), original.area)
  near('area display uses square conversion', Number(displayPartInput(original, 'area', 'sqm')), Number(original.area) / M2_TO_SQFT)
  near('dimension display uses linear conversion', Number(displayPartInput(original, 'length', 'sqm')), Number(original.length) / M_TO_FT)
  equal('invalid input stays invalid when display units switch', displayPartInput(part({ area: '12oops' }), 'area', 'sqm'), '12oops')
  const editedArea = editPartInput(original, 'area', '200', 'sqm')
  near('deliberate area edit after unit switch uses current units', partSqft(editedArea), 200 * M2_TO_SQFT)
  equal('deliberate edit creates a new part without rewriting original', JSON.stringify(original), originalBytes)
  const metricRectangle = part({ unit: 'sqm', mode: 'rectangle', length: '5.4321', width: '2.3456' })
  const changedLength = editPartInput(metricRectangle, 'length', '10', 'sqft')
  near('editing one dimension converts the untouched metric dimension', partSqft(changedLength), 10 * 2.3456 * M_TO_FT)
  equal('edited rectangle records entered display units', changedLength.unit, 'sqft')
  const feetRectangle = part({ mode: 'rectangle', length: '20', width: '8' })
  const changedWidth = editPartInput(feetRectangle, 'width', '3', 'sqm')
  near('reverse unit edit converts the untouched feet dimension', partSqft(changedWidth), (20 / M_TO_FT) * 3 * M2_TO_SQFT)
  equal('clearing a converted dimension makes measurement unknown', partSqft(editPartInput(metricRectangle, 'length', '', 'sqft')), null)

  const measured = estimateArea([part({ area: '1392' })])
  const catalogue = [
    plan({ term: 'monthly', basis: 'flat', rate: 66.95, sort_order: 3 }),
    plan({ term: 'one_time', sort_order: 0 }),
    plan({ term: 'seasonal', basis: 'flat', rate: 900, sort_order: 4 }),
    plan({ term: 'weekly', rate: 0.05, is_recommended: true, sort_order: 1 }),
    plan({ term: 'biweekly', rate: 0, sort_order: 2 }),
  ]
  const catalogueBytes = JSON.stringify(catalogue)
  const estimated = propertyEstimatePlans(catalogue, measured)
  equal('estimator exactly delegates prices and metadata to canonical plans', estimated, pricePlans(catalogue, 1392, 'area'))
  equal('configured sub-cent rate, unknown rate and flat cents survive', estimated.map(p => p.price), [49, 70, null, 66.95, 900])
  equal('commercial terms keep per-visit/month/season meaning', estimated.map(p => p.priceSuffix), ['/visit', '/visit', '/visit', '/month', '/season'])
  equal('owner order and recommendation survive pricing', estimated.map(p => [p.term, p.isRecommended]), [['one_time', false], ['weekly', true], ['biweekly', false], ['monthly', false], ['seasonal', false]])
  equal('pricing never rewrites the configured catalogue', JSON.stringify(catalogue), catalogueBytes)
  for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const unknown = propertyEstimatePlans([plan({ rate })], measured)
    check(`unconfigured or non-finite rate stays unknown (${String(rate)})`, unknown.length === 1 && unknown[0].price === null)
  }
  equal('missing flat rate remains unknown rather than free', propertyEstimatePlans([
    plan({ basis: 'flat', rate: null as unknown as number }),
  ], measured)[0].price, null)
  equal('even a flat plan waits for valid reviewed input area', propertyEstimatePlans([plan({ basis: 'flat', rate: 100 })], estimateArea([])), [])
  equal('empty price book never acquires invented prices', propertyEstimatePlans([], measured), [])
  equal('positive low prices get no invented minimum charge', propertyEstimatePlans([plan({ rate: 0.0001 })], estimateArea([part({ area: '100' })])), pricePlans([plan({ rate: 0.0001 })], 100, 'area'))
  check('automatic detection is unavailable until actually connected', AUTOMATIC_MEASUREMENT.available === false)
  check('proposed product catalogue does not activate enforcement', PRODUCT_PLAN_STATUS.enforcementEnabled === false)
  check('proposed subscription prices, billing cadence and quotas remain undecided', PROPOSED_PRODUCT_PLANS.every(p =>
    p.status === 'proposed' && p.price === null && p.billingCadence === null && p.scanAllowance === null && p.seatLimit === null))
}
