// Unknown equipment hours must not become a meter reading or a service verdict.
// Includes real PostgreSQL storage checks; never connects to production.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  type Equipment, costOfOwnership, fleetSummary, needsService,
  serviceStatus, shouldUpdateHourMeter,
} from '../src/lib/equipment'
import { loadPGlite, splitStatements } from './lib/pg-sql'

const TODAY = '2026-09-10'
const equipment = (overrides: Partial<Equipment> = {}): Equipment => ({
  id: 'eq1', user_id: 'owner', created_at: TODAY, updated_at: TODAY,
  name: 'Equipment', category: 'other', make: null, model: null,
  serial_number: null, purchase_date: null, purchase_price: 500,
  status: 'active', hours: null, service_interval_hours: null,
  service_interval_days: null, last_service_at: null, last_service_hours: null,
  notes: null, warranty_expires: null, warranty_provider: null,
  useful_life_years: null, salvage_value: null, ...overrides,
})

async function main() {
  const unknown = equipment({ service_interval_hours: 50 })
  const unknownStatus = serviceStatus(unknown, TODAY)
  assert.equal(unknownStatus.state, 'untracked')
  assert.equal(unknownStatus.hoursRemaining, null)
  assert.equal(unknownStatus.tone, 'neutral')
  assert.match(unknownStatus.reason, /engine hours/i)
  assert.equal(costOfOwnership(unknown, []).perHour, null)
  assert.equal(needsService(unknown, TODAY), false)
  assert.equal(serviceStatus(equipment(), TODAY).reason, 'No service schedule set')
  console.log('PASS: unknown/non-engine hours produce neither a fake reading nor cost/hour')

  const zero = equipment({ hours: 0, service_interval_hours: 50 })
  assert.equal(serviceStatus(zero, TODAY).state, 'ok')
  assert.equal(serviceStatus(zero, TODAY).hoursRemaining, 50)
  assert.equal(costOfOwnership(zero, []).perHour, null)
  assert.equal(costOfOwnership(equipment({ hours: 100 }), []).perHour, 5)
  assert.equal(shouldUpdateHourMeter(null, 0), true)
  assert.equal(shouldUpdateHourMeter(0, 0), false)
  assert.equal(shouldUpdateHourMeter(10, 0), false)
  assert.equal(shouldUpdateHourMeter(10, 20), true)
  assert.equal(shouldUpdateHourMeter(null, null), false)
  assert.equal(shouldUpdateHourMeter(0, null), false)
  console.log('PASS: real zero is distinct from unknown; a logged zero can establish the meter')

  const unmeteredService = equipment({
    hours: 100, service_interval_hours: 50, last_service_at: '2026-09-01',
  })
  const missingBaseline = serviceStatus(unmeteredService, TODAY)
  assert.equal(missingBaseline.hoursRemaining, null)
  assert.equal(missingBaseline.state, 'untracked')
  assert.match(missingBaseline.reason, /last service.*missing/i)
  // A service actually recorded at zero remains a legitimate baseline.
  assert.equal(serviceStatus({ ...unmeteredService, last_service_hours: 0 }, TODAY).state, 'due')
  const reversed = serviceStatus({ ...unmeteredService, hours: 0, last_service_hours: 100 }, TODAY)
  assert.equal(reversed.hoursRemaining, null)
  assert.equal(reversed.state, 'untracked')
  assert.match(reversed.reason, /below the last service/i)
  console.log('PASS: unknown or inconsistent service baselines cannot reset the hour countdown')

  const dated = { ...unknown, purchase_date: '2026-08-01', service_interval_days: 30 }
  assert.equal(serviceStatus(dated, TODAY).state, 'due')
  assert.equal(serviceStatus(dated, TODAY).daysRemaining, -10)
  assert.equal(needsService(dated, TODAY), true)
  const soon = { ...dated, purchase_date: '2026-08-20' }
  assert.equal(serviceStatus(soon, TODAY).state, 'due_soon')
  const healthyDate = { ...dated, purchase_date: '2026-09-01' }
  const partial = serviceStatus(healthyDate, TODAY)
  assert.equal(partial.state, 'untracked')
  assert.equal(partial.tone, 'neutral')
  assert.equal(partial.daysRemaining, 21)
  assert.match(partial.reason, /21 days.*engine hours/i)
  assert.equal(serviceStatus({ ...healthyDate, service_interval_hours: null }, TODAY).state, 'ok')
  const missingDate = serviceStatus({ ...zero, service_interval_days: 30 }, TODAY)
  assert.equal(missingDate.state, 'untracked')
  assert.match(missingDate.reason, /purchase or last-service date/i)
  const bothMissing = serviceStatus({ ...unknown, service_interval_days: 30 }, TODAY)
  assert.equal(bothMissing.state, 'untracked')
  assert.doesNotMatch(bothMissing.reason, /null|NaN|Infinity/)
  assert.equal(fleetSummary([unknown, dated, { ...dated, status: 'retired' }], [], TODAY).needingService, 1)
  console.log('PASS: known date reminders survive; partial schedules never show a full all-clear')

  const engine = await loadPGlite()
  assert.ok(engine, 'PGlite is required to verify equipment storage; no silent skip')
  const db = await engine.PGlite.create({ extensions: engine.contribs })
  try {
    const files = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort()
    const baseline = files.find(f => f.endsWith('_baseline.sql'))!
    const definition = splitStatements(readFileSync('supabase/migrations/' + baseline, 'utf8'))
      .find(s => /create table if not exists public\."equipment"\s*\(/i.test(s))
    assert.ok(definition, 'Use the actual repository equipment table definition')
    await db.exec('create schema extensions; create extension "uuid-ossp" with schema extensions;')
    await db.exec(definition)
    // Existing zero must survive; a legacy default is not proof it was unknown.
    await db.exec("insert into public.equipment(user_id, name, hours) values ('00000000-0000-0000-0000-000000000001', 'Existing zero', 0)")
    const migration = files.find(f => f.endsWith('_equipment_unknown_hours.sql'))
    // After shipment the workflow folds this change into the generated baseline.
    // Test that baseline directly then; never apply a file from the archive.
    if (migration) {
      const sql = readFileSync('supabase/migrations/' + migration, 'utf8')
      await db.exec(sql)
      await db.exec(sql) // Cheap ALTER operations are intentionally idempotent.
    }
    await db.exec(`
      insert into public.equipment(user_id, name) values
        ('00000000-0000-0000-0000-000000000001', 'No meter');
      insert into public.equipment(user_id, name, hours) values
        ('00000000-0000-0000-0000-000000000001', 'Explicit unknown', null),
        ('00000000-0000-0000-0000-000000000001', 'Actual zero', 0),
        ('00000000-0000-0000-0000-000000000001', 'Known meter', 12.5);
    `)
    const rows = (await db.query('select name, hours from public.equipment order by name')).rows
    // The PostgreSQL driver returns numeric values as strings, unlike PostgREST.
    assert.deepEqual(rows, [
      { name: 'Actual zero', hours: '0' }, { name: 'Existing zero', hours: '0' },
      { name: 'Explicit unknown', hours: null }, { name: 'Known meter', hours: '12.5' },
      { name: 'No meter', hours: null },
    ])
    await db.exec("update public.equipment set hours = null where name = 'Known meter'")
    assert.equal((await db.query("select hours from public.equipment where name = 'Known meter'")).rows[0].hours, null)
    const column = (await db.query(`select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'equipment' and column_name = 'hours'`)).rows[0]
    assert.deepEqual(column, { is_nullable: 'YES', column_default: null })
    console.log('PASS: PostgreSQL round-trips omitted/null/zero/positive hours and preserves existing zeros')
  } finally {
    await db.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
