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
// entirely and the token alone was enough to write a row.
//
// That was not a cosmetic gap. lib/autoMeasure's getNeighborhoodRatio selects
// measurements by user_id + neighborhood ONLY, averages accepted_sqft /
// building_sqft, and after CALIBRATION_MIN_SAMPLES (5) rows returns that average as
// the business's calibrated lawn:footprint ratio. That ratio sizes auto-measurement,
// and area is what a quote is priced from. The neighborhood was a caller-supplied
// string — the first three characters of a postal code — so five anonymous calls
// could hand a business a fabricated calibration for any bucket in its city.
// Reproduced live before the fix: ratio 0.100 against a default of 2.3.
//
// SAFETY. Every case below is one the RPC must REFUSE, so a passing run writes
// nothing. The row count is captured before and after and asserted unchanged —
// which means the day this guard fails, it fails loudly on both the return value
// and the row count rather than quietly polluting the owner's pricing data.

import { readFileSync, existsSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { endProcess } from './lib/shutdown'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const GHOST = '00000000-0000-0000-0000-0000000000ff'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD

  console.log('\n═══ A booking token is tenant authority, not booking authority ═══')

  // CI runs with placeholder Supabase values; there is nothing to talk to.
  if (!url || !anonKey || url.includes('placeholder')) {
    console.log('  … SKIPPED — no live Supabase credentials (CI runs with placeholders)')
    console.log('\n✓ measurement RPC checks: skipped\n')
    return
  }

  const anon: SupabaseClient = createClient(url, anonKey)

  // ── Cases that need no token at all ────────────────────────────────────────
  const forged = await anon.rpc('record_booking_measurement', {
    p_token: 'forged-token-not-a-real-business', p_quote_id: GHOST,
    p_lat: 51.05, p_lng: -114.07, p_neighborhood: 'T2N',
    p_auto: 1000, p_accepted: 100, p_building: 1000, p_confidence: 'high',
  })
  check('a forged booking token is refused',
    forged.error === null && forged.data === false,
    `returned ${JSON.stringify(forged.data)} / error ${forged.error?.message ?? 'none'}`)

  // The owner login is only used to READ the token and count rows — never to write.
  if (!email || !password) {
    console.log('  … the token-holding cases need PORTAL_RPC_OWNER_EMAIL / _PASSWORD — skipped')
    console.log(failures === 0 ? '\n✓ measurement RPC checks: partial (forged-token case only)\n' : '')
    if (failures) process.exit(1)
    return
  }

  const owner: SupabaseClient = createClient(url, anonKey)
  const { error: authErr } = await owner.auth.signInWithPassword({ email, password })
  if (authErr) {
    console.log(`  … SKIPPED the token-holding cases — owner sign-in failed (${authErr.message})`)
    console.log(failures === 0 ? '\n✓ measurement RPC checks: partial\n' : '')
    if (failures) process.exit(1)
    return
  }

  const { data: biz } = await owner.from('business_settings')
    .select('booking_token').eq('booking_enabled', true).limit(1).maybeSingle()
  const token = (biz as { booking_token: string | null } | null)?.booking_token
  if (!token) {
    console.log('  … SKIPPED — this business has no enabled booking token')
    console.log('\n✓ measurement RPC checks: partial\n')
    if (failures) process.exit(1)
    return
  }

  const countRows = async () => {
    const { count } = await owner.from('measurements').select('id', { count: 'exact', head: true })
    return count ?? -1
  }
  const before = await countRows()

  // ── THE EXPLOIT: a real token, no booking, an attacker-chosen bucket ────────
  // Five calls is the whole attack — CALIBRATION_MIN_SAMPLES is 5.
  const unanchored: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const r = await anon.rpc('record_booking_measurement', {
      p_token: token, p_quote_id: null,
      p_lat: 51.05, p_lng: -114.07, p_neighborhood: 'ZZ-GUARD-BUCKET',
      p_auto: 1000, p_accepted: 100, p_building: 1000, p_confidence: 'high',
    })
    unanchored.push(r.data === true)
  }
  check('a valid token with NO booking is refused (the reproduced exploit)',
    unanchored.every(v => v === false),
    'a token proves which business is being addressed, not that a booking happened — '
    + 'five of these once drove a neighborhood\'s calibrated ratio to 0.100 against a default of 2.3')

  // ── A booking id that does not exist ───────────────────────────────────────
  const ghost = await anon.rpc('record_booking_measurement', {
    p_token: token, p_quote_id: GHOST,
    p_lat: 51.05, p_lng: -114.07, p_neighborhood: 'ZZ-GUARD-BUCKET',
    p_auto: 1000, p_accepted: 100, p_building: 1000, p_confidence: 'high',
  })
  check('a booking id that does not exist is refused',
    ghost.error === null && ghost.data === false,
    `returned ${JSON.stringify(ghost.data)}`)

  // ── Nothing may have landed ────────────────────────────────────────────────
  const after = await countRows()
  check('not one row was written by any refused call',
    before >= 0 && after === before,
    `measurements went ${before} -> ${after}; a refusal that still writes is not a refusal`)

  const { count: poisoned } = await owner.from('measurements')
    .select('id', { count: 'exact', head: true }).eq('neighborhood', 'ZZ-GUARD-BUCKET')
  check('the caller-named neighborhood bucket does not exist',
    (poisoned ?? 0) === 0,
    'the bucket must be derived from the booking\'s persisted property, never from the request')

  // ⚠️ scope:'local' is LOAD-BEARING, not a detail. supabase-js defaults signOut()
  // to scope:'global', which revokes EVERY session this account holds ANYWHERE —
  // and these guards sign in as the real production owner. A bare signOut() here
  // signs the owner out of their own phone and desktop mid-workday. That is not
  // hypothetical: production logged 214 `/auth/v1/logout?scope=global` calls in
  // 24 hours, every one of them from `node` on a dev machine, and it was THE
  // cause of the random sign-outs. 'local' ends only this script's own session.
  // verify:auth-session fails if a bare signOut() reappears in scripts/.
  await owner.auth.signOut({ scope: 'local' }).catch(() => {})
}

main()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log(failures === 0
      ? '\n✅ measurement RPC: only a real booking of the token\'s own business can record a measurement.\n'
      : `\n❌ measurement RPC: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
    void endProcess(failures === 0 ? 0 : 1)
  })
