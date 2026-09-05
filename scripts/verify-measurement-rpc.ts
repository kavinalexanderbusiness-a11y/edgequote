// ── Verify: record_booking_measurement refuses everything but a real booking ──
//   npm run verify:measurement-rpc
//
// WHY THIS SCRIPT EXISTS, AND WHY IT IS EXECUTABLE RATHER THAN A SOURCE SCAN
// This guard REPLAYS the exploit. It calls the live RPC as the anonymous role and
// asserts each attack is refused AND that nothing was written. A source-only check
// on the migration file would pass happily while the deployed function said
// something else — and the whole class of bug here lives in the deployed function,
// not in the repo.
//
// THE EXPLOIT IT PINS. record_booking_measurement is SECURITY DEFINER and
// EXECUTE-able by `anon`, because the public booking form is its intended caller.
// Its gate is a booking token that is public by construction: it IS the
// /book/<token> URL a business prints on its own website. An earlier pass re-scoped
// the caller's quote id to the token's business, but the check was conditional —
// `if p_quote_id is not null and not exists (...)` — so passing NULL skipped it
// entirely and the token alone was enough to write a row. lib/autoMeasure averages
// a business's measurements per neighborhood and, after five rows, returns that
// average as the business's calibrated lawn:footprint ratio — the number a quote is
// priced from. Reproduced live before the fix: ratio 0.100 against a default of 2.3.
//
// ⭐⭐ WHERE THE WRITE-INTENT CALLS ARE AIMED (S123 validation-exposure audit, §2).
// This guard used to sign in as the REAL owner, read their LIVE booking token and
// fire six write-intent calls at it — with the deployed function's refusal as the
// only thing between a routine `npm run verify` and six rows of fabricated pricing
// calibration in a real book. The token-holding half now runs ONLY inside the
// fixture harness: openFixtureTenant() signs in as the fixture tenant, asks the
// DATABASE that it is one (is_verify_fixture_tenant — a table no signed-in user can
// read or write) and ABORTS THE PROCESS otherwise, before anything below runs. The
// token the attacks are aimed at is minted by this run, for that tenant, and
// withdrawn afterwards. The owner's credentials are not read here at all: with only
// the owner's env present, the token-holding half SKIPS and no write-intent call
// carries any real business's token.
//
// If the refusal ever regresses, the rows land in the fixture tenant's own
// `measurements`, tagged with this run's id — never in anyone's book — and the
// before/after count plus the tagged-bucket count fail loudly.
//
// ⭐ UNKNOWN IS NOT PERMISSION (S121 review of 6f246d68). The fixture tenant's
// settings row is shared with every other fixture guard, so: nothing is minted
// unless the prior state was READ without error (you cannot restore what you
// could not read); the restore is then MEASURED — re-read while still signed
// in, because after the harness signs out an RLS read sees nothing and a
// "clean" result would be blindness, not cleanliness. The one call outside
// the harness names a run-tagged synthetic bucket, never a real neighborhood,
// so residue from a regression there is findable rather than invisible.

import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { openFixtureTenant, isSkipped, fixtureResidue, loadEnvLocal } from './lib/verify-fixture'
import { endProcess } from './lib/shutdown'

loadEnvLocal()

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const GHOST = '00000000-0000-0000-0000-0000000000ff'

/** One attack: the RPC as the public booking form calls it, as the anonymous role. */
const attack = (anon: SupabaseClient, token: string, quoteId: string | null, bucket: string) =>
  anon.rpc('record_booking_measurement', {
    p_token: token, p_quote_id: quoteId,
    p_lat: 51.05, p_lng: -114.07, p_neighborhood: bucket,
    p_auto: 1000, p_accepted: 100, p_building: 1000, p_confidence: 'high',
  })

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  console.log('\n═══ A booking token is tenant authority, not booking authority ═══')

  // CI runs with placeholder Supabase values; there is nothing to talk to.
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    console.log('\n✓ measurement RPC checks: skipped\n')
    return
  }

  const anon: SupabaseClient = createClient(url, anonKey)

  // ── The case that addresses no business at all ─────────────────────────────
  // A token that matches nothing resolves to no tenant, so this call can affect
  // no one; it is the one write-intent call permitted outside the harness. That
  // safety is a property of the deployed function this guard exists to test, so
  // the bucket is a run-tagged synthetic name, never a real postal prefix: if
  // the lookup ever regressed, the row it left would be findable by this tag.
  const forgedBucket = `ZZ-GUARD-FORGED-${randomUUID().slice(0, 8)}`
  const forged = await attack(anon, 'forged-token-not-a-real-business', GHOST, forgedBucket)
  check(`a forged booking token is refused (bucket ${forgedBucket})`,
    forged.error === null && forged.data === false,
    `returned ${JSON.stringify(forged.data)} / error ${forged.error?.message ?? 'none'}`)

  // ── The token-holding cases: FIXTURE TENANT ONLY ───────────────────────────
  // ⛔ No owner credential is read anywhere in this file. openFixtureTenant
  // returns `skipped` without them, and exits the process if the fixture
  // credentials resolve to a tenant the database does not mark as a fixture.
  const t = await openFixtureTenant('verify:measurement-rpc')
  if (isSkipped(t)) {
    console.log(`  … SKIPPED the token-holding cases — ${t.skipped}`)
    console.log(failures === 0 ? '\n✓ measurement RPC checks: partial (forged-token case only)\n' : '')
    return
  }
  const { db, uid, runId, tag } = t
  const bucket = tag('GUARD-BUCKET')

  type Settings = { booking_token: string | null; booking_enabled: boolean }
  const readSettings = async () => {
    const { data, error } = await db.from('business_settings')
      .select('booking_token, booking_enabled').eq('user_id', uid).limit(1)
    return { row: ((data as Settings[] | null)?.[0] ?? null), error }
  }

  // A booking token OF THE FIXTURE TENANT, minted for this run and withdrawn
  // below. The row it lives on is the fixture tenant's own (RLS: settings own)
  // and is SHARED with every other fixture guard, so the prior state must be
  // known before anything is written: an unreadable snapshot is a refusal to
  // mint, never "there was nothing there".
  const snapshot = await readSettings()
  if (snapshot.error) {
    fail('the fixture tenant\'s prior settings were read (nothing is minted otherwise)', snapshot.error.message)
    await t.close()
    return
  }
  const prior = snapshot.row
  const token = `zz-fixture-booking-${runId}-${randomUUID()}`
  const { error: mintErr } = await db.from('business_settings')
    .upsert({ user_id: uid, booking_token: token, booking_enabled: true }, { onConflict: 'user_id' })
  if (mintErr) {
    fail('a booking token could be minted for the fixture tenant', mintErr.message)
    await t.close()
    return
  }
  console.log(`  · attacks aimed at the fixture tenant's run-minted token (${token.slice(0, 27)}…)`)

  // Counted through the fixture tenant's own RLS — its rows, nobody else's.
  const countRows = async () => {
    const { count } = await db.from('measurements').select('id', { count: 'exact', head: true }).eq('user_id', uid)
    return count ?? -1
  }

  try {
  try {
    const before = await countRows()

    // ── THE EXPLOIT: a real token, no booking, an attacker-chosen bucket ──────
    // Five calls is the whole attack — CALIBRATION_MIN_SAMPLES is 5.
    const unanchored: boolean[] = []
    for (let i = 0; i < 5; i++) unanchored.push((await attack(anon, token, null, bucket)).data === true)
    check('a valid token with NO booking is refused (the reproduced exploit)',
      unanchored.every(v => v === false),
      'a token proves which business is being addressed, not that a booking happened — '
      + 'five of these once drove a neighborhood\'s calibrated ratio to 0.100 against a default of 2.3')

    // ── A booking id that does not exist ─────────────────────────────────────
    const ghost = await attack(anon, token, GHOST, bucket)
    check('a booking id that does not exist is refused',
      ghost.error === null && ghost.data === false,
      `returned ${JSON.stringify(ghost.data)}`)

    // ── Nothing may have landed ──────────────────────────────────────────────
    const after = await countRows()
    check('not one row was written by any refused call',
      before >= 0 && after === before,
      `measurements went ${before} -> ${after}; a refusal that still writes is not a refusal`)

    const { count: poisoned } = await db.from('measurements')
      .select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('neighborhood', bucket)
    check('the caller-named neighborhood bucket does not exist',
      (poisoned ?? 0) === 0,
      `the bucket must be derived from the booking's persisted property, never from the request (${bucket})`)
  } finally {
    // Withdraw the token: the fixture tenant goes back to exactly what it was.
    // `prior` is known here — an unreadable snapshot returned before minting.
    if (prior) {
      await db.from('business_settings')
        .update({ booking_token: prior.booking_token, booking_enabled: prior.booking_enabled }).eq('user_id', uid)
    } else {
      await db.from('business_settings').delete().eq('user_id', uid)
    }
  }

  // ── Cleanup, MEASURED — while still signed in ────────────────────────────
  // t.close() signs out. An RLS-scoped read as a signed-out client sees zero
  // rows with no error, so a residue check placed after it would pass by being
  // blind. Everything below runs BEFORE close(), and the session itself is
  // asserted live at the moment of measurement.
  const { data: sess } = await db.auth.getSession()
  check('the cleanup is measured by a still-authenticated session (not blind)',
    !!sess?.session?.access_token && sess.session.user?.id === uid, 'the session was gone before the residue was read')
  const now = await readSettings()
  check('the run-minted token was withdrawn and the settings row is back to its prior state',
    !now.error && (prior
      ? (now.row?.booking_token === prior.booking_token && now.row?.booking_enabled === prior.booking_enabled)
      : now.row === null),
    now.error ? now.error.message : `prior ${JSON.stringify(prior)} vs now ${JSON.stringify(now.row)}`)
  // Cleanup that is claimed but not measured is how ZZ- rows accumulated before.
  const residue = await fixtureResidue(t)
  check('the fixture tenant carries nothing from this run',
    Object.values(residue).every(n => n === 0), JSON.stringify(residue))
  } finally {
    await t.close()
  }
}

main()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log(failures === 0
      ? '\n✅ measurement RPC: only a real booking of the token\'s own business can record a measurement.\n'
      : `\n❌ measurement RPC: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
    void endProcess(failures === 0 ? 0 : 1)
  })
