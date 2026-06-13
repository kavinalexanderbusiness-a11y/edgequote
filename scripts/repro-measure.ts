/* eslint-disable no-console */
// Reproduce the measure-tool pricing path that runs when the 3rd point closes
// the first polygon: pricingPackage → assessProspect → pricingPackage(valueGrade).
import { pricingPackage, DEFAULT_PRICING, estimateVisitMinutes } from '@/lib/pricing'
import { assessProspect } from '@/lib/prospect'
import type { ProspectContext } from '@/lib/prospect'

const cfg = DEFAULT_PRICING
const total = 2200        // sqft from a 3-point triangle
const overgrowth = 1
const nearbyCount = 2

// Minimal prospect context (as loadProspectContext would return).
const prospect: ProspectContext = {
  nearbyJobs: 2, nearestKm: 1.2, nearbyRecurring: 1, nearbyPendingQuotes: 0,
  hoods: [{ name: 'Queensland', revenue: 1800, customers: 2, jobs: 6, revPerJob: 300 }],
  observedMinPer1000: null, timedJobs: 0,
} as unknown as ProspectContext

try {
  console.log('1) base package…')
  const basePkg = pricingPackage(total, cfg, { overgrowth, nearbyCount, neighborhoodName: 'Queensland' })
  console.log('   oneTime', basePkg.oneTime)

  console.log('2) assessProspect…')
  const assessment = assessProspect(basePkg, prospect, {
    distanceKm: 4, travelFee: 6, neighborhoodName: 'Queensland',
    estimatedMinutes: estimateVisitMinutes(total, prospect.observedMinPer1000), timedJobs: prospect.timedJobs,
  })
  console.log('   score', assessment.score)

  console.log('3) graded package (valueGrade)…')
  const pkg = pricingPackage(total, cfg, { overgrowth, nearbyCount, neighborhoodName: 'Queensland', valueGrade: assessment.score })
  console.log('   weekly', pkg.options[0].price, 'valuePricing', JSON.stringify(pkg.valuePricing))

  // Also exercise every grade so any grade-specific branch is hit.
  for (const g of ['A+', 'A', 'B', 'C', 'D', 'F', null]) {
    const p = pricingPackage(total, cfg, { overgrowth, nearbyCount, valueGrade: g })
    if (!p.options.length) throw new Error('no options for grade ' + g)
  }
  console.log('\nNO CRASH — pricing path completed for all grades ✓')
} catch (e) {
  console.error('\nCRASH:', e instanceof Error ? e.message : e)
  console.error((e as Error).stack)
  process.exit(1)
}
