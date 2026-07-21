// ── Send-governor verification — npm run verify:comms-governor ──────────────
//
// MSG-1's one promise: no sender decides WHEN or HOW OFTEN on its own anymore.
// The governor's decision is a pure function (governVerdict), so every edge is
// pinned here without a database — including the failure semantics, which are
// the part a manual test never exercises: commercial sends fail CLOSED on any
// uncertain read (the automation engine's quiet-hours lesson), service sends
// fail OPEN (a receipt must not die on a log hiccup).
//
// Style follows verify-automations/verify-onboarding: pure, deterministic, no I/O.

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  governVerdict, localHour, isCommercial,
  SEND_WINDOW_START, SEND_WINDOW_END, COMMERCIAL_GAP_DAYS, COMMERCIAL_CAP_30D, OWNER_DAILY_CAP,
  type GovernorState,
} from '../src/lib/comms/governor'
import { SKIP_REASON } from '../src/lib/comms/skipReasons'
import { describeSkip } from '../src/lib/comms/skipReasons'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

const ok = (over: Partial<GovernorState>): GovernorState => ({
  commercial: true, hour: 10, recentToCustomer: 0, monthToCustomer: 0, ownerToday: 3,
  ...over,
})

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE HAPPY PATH — a clean commercial send at 10am goes out')
check('clean commercial send allowed', governVerdict(ok({})), { allowed: true, reason: null })
check('clean service send allowed', governVerdict(ok({ commercial: false })), { allowed: true, reason: null })

// ═══════════════════════════════════════════════════════════════════════════
H('2. QUIET HOURS — commercial only, window edges exact')
check(`hour ${SEND_WINDOW_START} (open edge) allowed`, governVerdict(ok({ hour: SEND_WINDOW_START })).allowed, true)
check(`hour ${SEND_WINDOW_START - 1} blocked`, governVerdict(ok({ hour: SEND_WINDOW_START - 1 })), { allowed: false, reason: SKIP_REASON.QUIET_HOURS })
check(`hour ${SEND_WINDOW_END - 1} (last open hour) allowed`, governVerdict(ok({ hour: SEND_WINDOW_END - 1 })).allowed, true)
check(`hour ${SEND_WINDOW_END} (close edge) blocked`, governVerdict(ok({ hour: SEND_WINDOW_END })), { allowed: false, reason: SKIP_REASON.QUIET_HOURS })
check('midnight blocked', governVerdict(ok({ hour: 0 })).allowed, false)
check('service send at 4am is NOT quiet-hours governed (an early on-my-way IS the business)',
  governVerdict(ok({ commercial: false, hour: 4 })).allowed, true)
// The winter cron reality this window exists for: cron/campaigns fires 15:00 UTC
// = 08:00 Mountain STANDARD. If the window opened at 9, every winter campaign
// run would be silently suppressed forever.
check('the campaign cron\'s winter hour (08:00 MST) is inside the window',
  governVerdict(ok({ hour: 8 })).allowed, true)

// ═══════════════════════════════════════════════════════════════════════════
H('3. UNKNOWN HOUR — the automation engine\'s bug, not repeated')
check('unknown hour blocks a commercial send (fail closed)',
  governVerdict(ok({ hour: 'unknown' })), { allowed: false, reason: SKIP_REASON.QUIET_HOURS })
check('unknown hour does NOT block a service send',
  governVerdict(ok({ commercial: false, hour: 'unknown' })).allowed, true)
check('localHour(null) is unknown, never a guess', localHour(null, new Date()), 'unknown')
check('localHour(garbage tz) is unknown, never a throw', localHour('Not/AZone', new Date()), 'unknown')
check('localHour resolves a real timezone to a real hour',
  typeof localHour('America/Edmonton', new Date()) === 'number', true)
// The exact shipped bug: UTC hour presented as owner-local. 15:00 UTC must NOT
// read as 15:00 in Edmonton.
check('localHour is the OWNER\'s hour, not the server\'s',
  localHour('America/Edmonton', new Date('2026-01-15T15:00:00Z')), 8)

// ═══════════════════════════════════════════════════════════════════════════
H('4. FREQUENCY — the cross-sender brain none of the five dedupers had')
check('a commercial send within the gap blocks',
  governVerdict(ok({ recentToCustomer: 1 })), { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP })
check('30-day cap blocks at the cap',
  governVerdict(ok({ monthToCustomer: COMMERCIAL_CAP_30D })), { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP })
check('30-day cap allows just under the cap',
  governVerdict(ok({ monthToCustomer: COMMERCIAL_CAP_30D - 1 })).allowed, true)
check('service sends are never frequency-capped',
  governVerdict(ok({ commercial: false, recentToCustomer: 5, monthToCustomer: 50 })).allowed, true)
check('a FAILED frequency read blocks a commercial send (fail closed)',
  governVerdict(ok({ recentToCustomer: null })), { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP })
check('a FAILED month read blocks a commercial send (fail closed)',
  governVerdict(ok({ monthToCustomer: null })), { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP })

// ═══════════════════════════════════════════════════════════════════════════
H('5. THE RUNAWAY GUARD — every category, sized above legitimate peak')
check('owner daily cap blocks commercial', governVerdict(ok({ ownerToday: OWNER_DAILY_CAP })), { allowed: false, reason: SKIP_REASON.DAILY_CAP })
check('owner daily cap blocks service too — a runaway does not care which template',
  governVerdict(ok({ commercial: false, ownerToday: OWNER_DAILY_CAP })), { allowed: false, reason: SKIP_REASON.DAILY_CAP })
check('one under the cap allows', governVerdict(ok({ ownerToday: OWNER_DAILY_CAP - 1 })).allowed, true)
check('a FAILED owner count blocks commercial (fail closed)',
  governVerdict(ok({ ownerToday: null })), { allowed: false, reason: SKIP_REASON.DAILY_CAP })
check('a FAILED owner count does NOT block service (fail open — receipts survive log hiccups)',
  governVerdict(ok({ commercial: false, ownerToday: null })).allowed, true)
check('the cap clears legitimate peak by 5× (≈30 jobs/day × 3 messages)', OWNER_DAILY_CAP >= 450, true)
check('the gap is at least 2 days (a "cross-sender" gap of hours would be theatre)', COMMERCIAL_GAP_DAYS >= 2, true)

// ═══════════════════════════════════════════════════════════════════════════
H('6. WHAT COUNTS AS COMMERCIAL — the CEM classes, and only them')
check('marketing/seasonal/review_chase are commercial',
  ['marketing', 'win_back', 'introduction', 'referral_request', 'review_chase', 'seasonal_offer', 'birthday'].map(isCommercial),
  [true, true, true, true, true, true, true])
check('service/transactional/conversational are not',
  ['review_request', 'on_my_way', 'reminder', 'invoice', 'receipt', 'payment_reminder', 'quote', 'booking_received', 'custom'].map(isCommercial),
  [false, false, false, false, false, false, false, false, false])
check('an UNKNOWN template is treated as commercial (future senders fail toward governance)',
  isCommercial('some_future_blast'), true)

// ═══════════════════════════════════════════════════════════════════════════
H('7. THE SEAM IS WIRED — both real send paths consult the governor')
// A pure harness can pin the rules and still miss the only failure that matters:
// nobody calling them. Same discipline as verify-trades' import closure.
const SRC = join(__dirname, '..', 'src')
const dispatchSrc = readFileSync(join(SRC, 'lib', 'comms', 'dispatch.ts'), 'utf8')
const routeSrc = readFileSync(join(SRC, 'app', 'api', 'comms', 'send', 'route.ts'), 'utf8')
check('dispatchToCustomer consults governCheck', /governCheck\s*\(/.test(dispatchSrc), true)
check('api/comms/send consults governCheck (it owns its send deliberately)', /governCheck\s*\(/.test(routeSrc), true)
const bulkSrc = readFileSync(join(SRC, 'components', 'customers', 'CustomerList.tsx'), 'utf8')
check('the bulk review action sends review_chase (rides the marketing opt-out — CASL)',
  /setMsgTemplate\('review_chase'\)/.test(bulkSrc), true)
check('the bulk review action no longer sends review_request',
  /setMsgTemplate\('review_request'\)/.test(bulkSrc), false)

// ═══════════════════════════════════════════════════════════════════════════
H('8. THE TIMELINE STAYS TRUTHFUL — every verdict has a human label')
check('quiet hours resolves', describeSkip(SKIP_REASON.QUIET_HOURS).label, 'held for quiet hours')
check('frequency cap resolves', describeSkip(SKIP_REASON.FREQUENCY_CAP).label, 'messaged too recently')
check('daily cap resolves', describeSkip(SKIP_REASON.DAILY_CAP).label, 'daily send limit reached')

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
