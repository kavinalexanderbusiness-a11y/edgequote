// ── Day plan, end to end, in a real browser ─────────────────────────────────
//   npx tsx scripts/dayplan-e2e.ts [baseUrl]
//
// Seeds ONE realistic day in the verification fixture tenant, drives the built
// app at 375 / 390 / 430 with scripts/dayplan-cdp.mjs, then removes every row it
// made. ⛔ Never the owner's book: openFixtureTenant aborts loudly if the
// credentials resolve to a tenant that is not marked as a fixture
// (scripts/lib/verify-fixture, Session 33).
//
// The seeded day is deliberately the awkward one this session exists for — a
// MIXED day:
//   · three ordinary route stops, located, with stated durations
//   · one multi-worker project that a single person cannot staff
//   · one visit with NO duration at all
// so the browser has to render an ordered route, a blocking staffing verdict,
// an assumed-duration caveat and a travel claim, all at once, on a phone.

import { spawn } from 'node:child_process'
import { openFixtureTenant, isSkipped } from './lib/verify-fixture'

const baseUrl = process.argv[2] || 'http://127.0.0.1:3117'

// Tomorrow, so the day is inside lib/dayFitLoad's horizon (workers are only
// claimed for dates whose time off was actually read) and reachable by the
// board's own "Tomorrow" button.
const d = new Date()
d.setDate(d.getDate() + 1)
const DATE = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Two tight pairs, ~2 km apart: enough for the grouping count to say something
// real, close enough that a straight-line estimate is not absurd.
const BASE = { lat: 51.0447, lng: -114.0719 }
const SPOTS = [
  { lat: 51.0500, lng: -114.0700 },
  { lat: 51.0505, lng: -114.0695 },
  { lat: 51.0700, lng: -114.0900 },
  { lat: 51.0705, lng: -114.0905 },
  { lat: 51.0710, lng: -114.0910 },
]

// tsx compiles this to CJS, where top-level await is unavailable.
async function main(): Promise<number> {

const opened = await openFixtureTenant('DAY-PLAN')
if (isSkipped(opened)) {
  console.log(`⚠ day-plan e2e skipped: ${opened.skipped}`)
  return 0
}
const t = opened

const propertyIds: string[] = []
const jobIds: string[] = []
let settingsExisted = false

async function cleanup() {
  if (jobIds.length) await t.db.from('jobs').delete().in('id', jobIds)
  if (propertyIds.length) await t.db.from('properties').delete().in('id', propertyIds)
  // ⛔ business_settings is deliberately LEFT. It is the fixture tenant's
  // configuration, not this run's residue — and the tenant cannot recreate it
  // (RLS gates the INSERT on the provisioning licence), so deleting it would
  // make the tenant unusable for the next run and for every other guard.
  void settingsExisted
  await t.close()
}

let failed = false
try {
  // ── Settings: a base to route from, and a day worth 8 hours ───────────────
  // ⚠️ The fixture tenant CANNOT create this row itself: `settings: insert own`
  // is gated on can_provision_business(), the beta-signup licence, and a
  // fixture tenant is deliberately unlicensed. So the row is provisioned once
  // by the platform (service role) and this run only reads it — and, because
  // `settings: delete own` IS allowed, removes it again on the way out.
  const { data: existing, error: rErr } = await t.db.from('business_settings')
    .select('user_id, base_lat, base_lng, daily_capacity_hours').eq('user_id', t.uid).maybeSingle()
  if (rErr) throw new Error(`settings read failed: ${rErr.message}`)
  const row = existing as { base_lat: number | null; base_lng: number | null } | null
  if (!row || row.base_lat == null || row.base_lng == null) {
    throw new Error('the fixture tenant has no base address — provision business_settings '
      + `for ${t.uid} (base_lat/base_lng) before running this; RLS forbids doing it here.`)
  }
  settingsExisted = false   // provisioned FOR this proof; removed again below.

  const customer = await t.fixtureCustomer()

  // ── Properties, pre-located so nothing is ever geocoded ───────────────────
  for (const [i, s] of SPOTS.entries()) {
    const { data, error } = await t.db.from('properties').insert({
      user_id: t.uid, customer_id: customer.id,
      address: `${t.tag('STOP')}-${i + 1} — not a real address`,
      lat: s.lat, lng: s.lng,
      // `properties_one_primary` allows exactly one primary per customer, and
      // the column defaults to true — so a second insert collides.
      is_primary: i === 0,
    }).select('id').single()
    if (error || !data) throw new Error(`property ${i} failed: ${error?.message}`)
    propertyIds.push((data as { id: string }).id)
  }

  // ── The day ───────────────────────────────────────────────────────────────
  const rows = [
    { title: t.tag('ROUTE-1'), duration_minutes: 60, crew_size: 1 },
    { title: t.tag('ROUTE-2'), duration_minutes: 45, crew_size: 1 },
    { title: t.tag('ROUTE-3'), duration_minutes: 45, crew_size: 1 },
    // The project a lone operator cannot staff — the session's headline case.
    { title: t.tag('PROJECT'), duration_minutes: 360, crew_size: 3 },
    // …and a visit nobody has estimated.
    { title: t.tag('UNKNOWN'), duration_minutes: null, crew_size: 1 },
  ]
  for (const [i, r] of rows.entries()) {
    const { data, error } = await t.db.from('jobs').insert({
      user_id: t.uid, customer_id: customer.id, property_id: propertyIds[i],
      title: r.title, service_type: t.tag('SERVICE'),
      scheduled_date: DATE, status: 'scheduled',
      duration_minutes: r.duration_minutes, crew_size: r.crew_size,
      price: null,
    }).select('id').single()
    if (error || !data) throw new Error(`job ${r.title} failed: ${error?.message}`)
    jobIds.push((data as { id: string }).id)
  }

  console.log(`seeded ${jobIds.length} visits on ${DATE} in the fixture tenant`)
  console.log(`  (1 project × 3 workers · 1 with no duration · base set · all located)\n`)

  // ── Drive the browser ─────────────────────────────────────────────────────
  const code = await new Promise<number>(resolve => {
    const p = spawn(process.execPath, ['scripts/dayplan-cdp.mjs', baseUrl, jobIds[0], '--fixture'],
      { stdio: 'inherit' })
    p.on('exit', c => resolve(c ?? 1))
  })
  failed = code !== 0
} catch (e) {
  failed = true
  console.error(`✗ day-plan e2e: ${(e as Error).message}`)
} finally {
  await cleanup()
  const { data: leftJobs } = await t.db.from('jobs').select('id').eq('user_id', t.uid)
  const { data: leftProps } = await t.db.from('properties').select('id').eq('user_id', t.uid)
  const residue = (leftJobs?.length ?? 0) + (leftProps?.length ?? 0)
  console.log(residue === 0
    ? '\n✓ fixture tenant left clean'
    : `\n✗ fixture residue: ${leftJobs?.length ?? 0} jobs, ${leftProps?.length ?? 0} properties`)
  if (residue !== 0) failed = true
}

return failed ? 1 : 0
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1) })
