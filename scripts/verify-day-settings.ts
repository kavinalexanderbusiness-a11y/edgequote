// ── Day Settings verification — npm run verify:day-settings ─────────────────
//
// THE invariant this pins: changing a day's working hours (or crew) must NEVER
// change whether that day is enabled. Only the explicit Disable/Enable action
// may do that.
//
// The production bug it was written for: Day Settings stores an hours override
// on `day_statuses`, whose `status` column is NOT NULL DEFAULT 'custom' — so a
// bare capacity override has to be written as status 'custom' with blocks=false.
// The calendar then shaded and badged EVERY row it found, ignoring `blocks`, so
// re-timing a working day painted it with the same 'Custom 🚫' treatment as a
// real day off. The flag was never overwritten, omitted, or reset — the write
// path was correct all along (verified against production rows); the READ path
// disagreed with it.
//
// Two halves, so a regression on either side fails loudly:
//   1. setDayCapacity's payload — blocks/status carried through untouched, for
//      an enabled day, a disabled day, and a brand-new day.
//   2. showsDayStatus / isCapacityOnlyRow — which rows the calendar may treat
//      as a status.
// Pure + deterministic (the supabase client is a recording stub), no I/O —
// same discipline as verify-recurrence / verify-onboarding.

import { setDayCapacity, showsDayStatus, isCapacityOnlyRow, type DayStatusRow } from '../src/lib/dayStatus'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

const row = (o: Partial<DayStatusRow>): DayStatusRow => ({
  id: 'r1', date: '2026-08-03', status: 'custom', blocks: false, label: null, notes: null,
  starts_at: null, ends_at: null, crew_size: null, created_by: null, ...o,
})

// Records the row setDayCapacity upserts, so we assert on the exact payload that
// would reach Postgres rather than on a mock's return value.
function stubSupabase() {
  const seen: Record<string, unknown>[] = []
  const client = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) { seen.push(payload); return Promise.resolve({ error: null }) },
      }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, seen }
}

async function capacityPayload(cur: DayStatusRow | null, patch: { crewSize?: number | null; startsAt?: string | null; endsAt?: string | null }) {
  const { client, seen } = stubSupabase()
  await setDayCapacity(client, 'user-1', '2026-08-03', cur, patch)
  return seen[0]
}

async function main() {
  H('setDayCapacity — changing hours never changes `blocks`')

  // The reported bug, as a test: an ENABLED day whose hours change stays enabled.
  const enabled = await capacityPayload(row({ blocks: false }), { startsAt: '10:30', endsAt: '17:30' })
  check('enabled day stays enabled', enabled.blocks, false)
  check('  hours are written', [enabled.starts_at, enabled.ends_at], ['10:30', '17:30'])

  // The mirror case: re-timing a DISABLED day must not silently re-enable it.
  const disabled = await capacityPayload(row({ blocks: true, status: 'rain' }), { startsAt: '09:00', endsAt: '15:00' })
  check('disabled day stays disabled', disabled.blocks, true)
  check('  its status is preserved', disabled.status, 'rain')

  // A brand-new day (no row yet): an hours override must create a WORKING day.
  const fresh = await capacityPayload(null, { startsAt: '07:00', endsAt: '16:00' })
  check('new day is created enabled', fresh.blocks, false)
  check('  placeholder status is custom', fresh.status, 'custom')

  // Crew-only changes obey the same rule.
  const crewOnly = await capacityPayload(row({ blocks: true, status: 'holiday' }), { crewSize: 3 })
  check('crew change leaves blocks alone', crewOnly.blocks, true)

  // Untouched fields survive (the "independent facts about the same day" rule).
  const partial = await capacityPayload(row({ blocks: false, starts_at: '08:00', ends_at: '17:00', crew_size: 2 }), { crewSize: 4 })
  check('unspecified hours are preserved', [partial.starts_at, partial.ends_at], ['08:00', '17:00'])
  check('  and blocks is still false', partial.blocks, false)

  H('showsDayStatus — what the calendar may paint as unavailable')

  // THE regression: a bare hours override is not a status.
  check('hours override is capacity-only', isCapacityOnlyRow(row({ starts_at: '10:30', ends_at: '17:30' })), true)
  check('  → calendar shows no status', showsDayStatus(row({ starts_at: '10:30', ends_at: '17:30' })), false)
  check('crew-only override is capacity-only', isCapacityOnlyRow(row({ crew_size: 3 })), true)

  // Real statuses must still paint — the fix must not hide genuine days off.
  check('manually disabled day shows', showsDayStatus(row({ status: 'custom', blocks: true })), true)
  check('rain day shows', showsDayStatus(row({ status: 'rain', blocks: true })), true)
  check('holiday shows', showsDayStatus(row({ status: 'holiday', blocks: true })), true)

  // Information must not be lost for rows a placeholder cannot describe.
  check('labelled non-blocking row shows', showsDayStatus(row({ label: 'Training day' })), true)
  check('future non-blocking status shows', showsDayStatus(row({ status: 'training', blocks: false })), true)

  // A disabled day that ALSO carries an hours override is still a day off.
  check('disabled + hours override shows', showsDayStatus(row({ blocks: true, starts_at: '09:00', ends_at: '15:00' })), true)

  check('no row shows nothing', showsDayStatus(null), false)

  console.log(`\n${fail === 0 ? '✅' : '❌'} day-settings: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
