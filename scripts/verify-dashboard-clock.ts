import assert from 'node:assert/strict'
import { dashboardClock } from '../src/lib/dashboard/clock'

for (const runtimeZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  process.env.TZ = runtimeZone
  const evening = dashboardClock('America/Edmonton', new Date('2026-09-21T01:30:00Z'))
  assert.equal(evening.today, '2026-09-20')
  assert.equal(evening.dateLine, 'Sunday, September 20')
  assert.equal(evening.greeting, 'Good evening')
  const morning = dashboardClock('America/Edmonton', new Date('2026-09-21T16:00:00Z'))
  assert.equal(morning.greeting, 'Good morning')
  assert.equal(morning.today, '2026-09-21')
  assert.equal(dashboardClock('America/Edmonton', new Date('2026-09-21T19:00:00Z')).greeting, 'Good afternoon')
  assert.deepEqual(dashboardClock('invalid', new Date('2026-09-21T01:30:00Z')), evening)
  // Winter offset and both sides of the spring DST transition.
  assert.equal(dashboardClock('America/Edmonton', new Date('2026-01-02T06:30:00Z')).today, '2026-01-01')
  for (const instant of ['2026-03-08T08:59:00Z', '2026-03-08T09:01:00Z']) {
    assert.equal(dashboardClock('America/Edmonton', new Date(instant)).today, '2026-03-08')
  }
  assert.equal(dashboardClock('Asia/Tokyo', new Date('2026-09-21T01:30:00Z')).today, '2026-09-21')
}
console.log('Dashboard clock: 33 assertions passed across three server time zones.')
