// ── Follow-up engine characterization — run by CI (npm run verify:followup) ──
//
// lib/followup.ts is THE quote-chasing engine — the cron chaser, the dashboard queue,
// the quote list, the weekly review and the Suggestions Center all decide staleness here.
// verify-automations pins one thing (the cron agrees with the manual queue at the default
// cadence); everything below it was uncovered, and it is both revenue- and COMPLIANCE-
// critical:
//   • the consent gate (canChaseCustomer / chaseBlockedReason) — chasing someone who
//     can't be reached spends an attempt on nobody, and mislabelling WHY sends the owner
//     hunting a consent problem that doesn't exist (the documented NO_CONTACT case);
//   • the cap (followUpsExhausted / dueForAutoFollowUp) — two chases then stop, so the
//     automation can't turn into pestering;
//   • the queue order (compareFollowUp) — oldest first, stale money first;
//   • the policy clamps (resolveFollowUpPolicy) — a hostile jsonb value can't make the
//     chaser a same-day spammer or an endless one.
//
// Deterministic: quoteIsQuiet is driven with an injected refMs (never the wall clock),
// and the consent/cap/order/policy functions are pure. The reachability RULES belong to
// lib/comms/reach; here we pin that followup ROUTES to the right canonical SkipReason and
// applies its own missing-customer / no-contact guards. CHARACTERIZATION only — expected
// values read from the implementation; no production change.

import {
  followUpAnchor, quoteIsQuiet, followUpsExhausted, dueForAutoFollowUp,
  canChaseCustomer, chaseBlockedReason, compareFollowUp, resolveFollowUpPolicy,
  markWonPatch, logFollowUpPatch, daysSince, startOfDayMs,
  FOLLOW_UP_DAYS, FOLLOW_UP_MAX,
} from '../src/lib/followup'
import { SKIP_REASON } from '../src/lib/comms/skipReasons'
import type { Quote } from '../src/types'
import type { ReachCustomer } from '../src/lib/comms/reach'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean) { check(name, cond, true) }

const DAY = 86_400_000
const REF = Date.parse('2026-06-10T12:00:00Z')       // a fixed absolute instant — TZ-independent
const ago = (n: number) => new Date(REF - n * DAY).toISOString()
const q = (o: Partial<Quote>): Quote => o as Quote
const cust = (o: Partial<ReachCustomer>): ReachCustomer =>
  ({ phone: null, email: null, sms_opt_in: false, email_opt_in: false, message_prefs: null, ...o })

// ═══════════════════════════════════════════════════════════════════════════
H('1. followUpAnchor — the clock a follow-up resets to')
check('the last nudge wins over the send date', followUpAnchor(q({ sent_at: ago(10), last_followed_up_at: ago(1) })), ago(1))
check('falls back to the send date when never nudged', followUpAnchor(q({ sent_at: ago(10), last_followed_up_at: null })), ago(10))
check('neither → null (untimestamped)', followUpAnchor(q({ sent_at: null, last_followed_up_at: null })), null)

// ═══════════════════════════════════════════════════════════════════════════
H('2. quoteIsQuiet — the staleness rule, measured against an injected clock')
check('quiet exactly at the delay (>=)', quoteIsQuiet(q({ status: 'sent', sent_at: ago(3) }), 3, REF), true)
check('one day short is not yet quiet', quoteIsQuiet(q({ status: 'sent', sent_at: ago(2) }), 3, REF), false)
check('measures from the LAST nudge, not the original send',
  quoteIsQuiet(q({ status: 'sent', sent_at: ago(10), last_followed_up_at: ago(1) }), 3, REF), false)
check('sent but never timestamped → surface it (quiet)',
  quoteIsQuiet(q({ status: 'sent', sent_at: null, last_followed_up_at: null }), 3, REF), true)
check('a quote that has been ANSWERED (not sent) is never quiet',
  quoteIsQuiet(q({ status: 'accepted', sent_at: ago(100) }), 3, REF), false)

// ═══════════════════════════════════════════════════════════════════════════
H('3. followUpsExhausted / dueForAutoFollowUp — the cap that stops pestering')
check('at the cap → exhausted', followUpsExhausted(q({ follow_up_count: 2 }), { delayDays: 3, maxCount: 2 }), true)
check('under the cap → not exhausted', followUpsExhausted(q({ follow_up_count: 1 }), { delayDays: 3, maxCount: 2 }), false)
check('no count yet counts as 0', followUpsExhausted(q({}), { delayDays: 3, maxCount: 2 }), false)
// A never-timestamped sent quote is quiet on ANY clock, so dueForAutoFollowUp is
// deterministic here — isolating the CAP half of the gate.
check('due when quiet and attempts remain',
  dueForAutoFollowUp(q({ status: 'sent', sent_at: null, follow_up_count: 0 }), { delayDays: 3, maxCount: 2 }), true)
check('NOT due once the cap is hit, even though it is still quiet (no pestering)',
  dueForAutoFollowUp(q({ status: 'sent', sent_at: null, follow_up_count: 2 }), { delayDays: 3, maxCount: 2 }), false)
check('an answered quote is never due', dueForAutoFollowUp(q({ status: 'accepted', sent_at: null }), { delayDays: 3, maxCount: 2 }), false)

// ═══════════════════════════════════════════════════════════════════════════
H('4. consent gate — can this chase actually go out? (CASL / reachability)')
const reachable = cust({ phone: '4035550100', email: 'a@b.com', sms_opt_in: true, email_opt_in: true })
check('a reachable customer can be chased', canChaseCustomer(reachable), true)
check('…and has no block reason', chaseBlockedReason(reachable), null)
check('a MISSING customer is not reachable (an absent row is not permission)', canChaseCustomer(null), false)
check('a missing customer routes to NO_CONTACT', chaseBlockedReason(null), SKIP_REASON.NO_CONTACT)
check('no phone AND no email → NO_CONTACT (the actionable truth, not a per-channel excuse)',
  chaseBlockedReason(cust({ phone: null, email: null })), SKIP_REASON.NO_CONTACT)
check('WITH contact but opted out → delegates to reach (NO_OPT_IN, not NO_CONTACT)',
  chaseBlockedReason(cust({ phone: '4035550100', email: 'a@b.com', sms_opt_in: false, email_opt_in: false })),
  SKIP_REASON.NO_OPT_IN)
check('one open channel is enough to be reachable (SMS in, email out)',
  canChaseCustomer(cust({ phone: '4035550100', sms_opt_in: true, email: null, email_opt_in: false })), true)

// ═══════════════════════════════════════════════════════════════════════════
H('5. compareFollowUp — oldest first, then stale money first')
// Both same-day quotes carry a real total so the value tiebreak is well defined —
// the comparator subtracts Number(total), and the "stale money first" rule only has
// meaning when there is money to compare.
const queue = [
  q({ sent_at: ago(1), total: 100 }),        // 0: recent, cheaper
  q({ sent_at: null, total: 50 }),           // 1: untimestamped → oldest (anchor 0)
  q({ sent_at: ago(1), total: 900 }),        // 2: same day as #0, richer → wins the tie
  q({ sent_at: ago(10), total: 100 }),       // 3: oldest real date
].map((qq, i) => ({ qq, i }))
const order = queue.slice().sort((x, y) => compareFollowUp(x.qq, y.qq)).map(z => z.i)
check('untimestamped sorts to the front, then oldest date, then highest total on a tie',
  order, [1, 3, 2, 0])

// ═══════════════════════════════════════════════════════════════════════════
H('6. resolveFollowUpPolicy — tolerant + clamped (no spammer, no endless chase)')
check('nothing set → the defaults', resolveFollowUpPolicy(null), { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })
check('a valid override is honoured',
  resolveFollowUpPolicy({ quote_followup_delay_days: 7, quote_followup_max: 1 }), { delayDays: 7, maxCount: 1 })
check('a hostile delay is clamped to 60 days, a hostile cap to 10',
  resolveFollowUpPolicy({ quote_followup_delay_days: 999, quote_followup_max: 99 }), { delayDays: 60, maxCount: 10 })
check('a delay below the 1-day floor falls back to the default',
  resolveFollowUpPolicy({ quote_followup_delay_days: 0 }).delayDays, FOLLOW_UP_DAYS)
check('maxCount 0 is valid (chaser off), delay still parsed',
  resolveFollowUpPolicy({ quote_followup_max: 0, quote_followup_delay_days: 5 }), { delayDays: 5, maxCount: 0 })
check('garbage values fall back to defaults',
  resolveFollowUpPolicy({ quote_followup_delay_days: 'abc' }), { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })

// ═══════════════════════════════════════════════════════════════════════════
H('7. markWonPatch — record the win, snapshot what was bought, OMIT the unknown')
check('no follow-ups drove the win',
  markWonPatch(0),
  { status: 'accepted', accepted_after_followup: false, follow_up_count_at_acceptance: 0, accepted_price: null })
check('follow-ups DID drive the win',
  markWonPatch(2),
  { status: 'accepted', accepted_after_followup: true, follow_up_count_at_acceptance: 2, accepted_price: null })
check('a known cadence is snapshotted',
  markWonPatch(1, { acceptedPrice: 150, selectedCadence: 'weekly' }),
  { status: 'accepted', accepted_after_followup: true, follow_up_count_at_acceptance: 1, accepted_price: 150, selected_cadence: 'weekly' })
check('an unknown cadence is OMITTED, not defaulted (absence is a fact)',
  markWonPatch(1, { acceptedPrice: 150, selectedCadence: null }),
  { status: 'accepted', accepted_after_followup: true, follow_up_count_at_acceptance: 1, accepted_price: 150 })

// ═══════════════════════════════════════════════════════════════════════════
H('8. logFollowUpPatch / daysSince / startOfDayMs — the deterministic edges')
check('logging a manual follow-up increments the count', logFollowUpPatch(q({ follow_up_count: 1 })).follow_up_count, 2)
check('logging from no prior count starts at 1', logFollowUpPatch(q({})).follow_up_count, 1)
ok('logFollowUpPatch stamps a real ISO timestamp', Number.isFinite(Date.parse(logFollowUpPatch(q({})).last_followed_up_at)))
check('daysSince(null) is null (nothing to measure)', daysSince(null), null)
check('startOfDayMs advances exactly one day between consecutive dates',
  startOfDayMs('2026-06-11') - startOfDayMs('2026-06-10'), DAY)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
