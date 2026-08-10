// ── Quote lifecycle characterization — run by CI (npm run verify:quote-status) ──
//
// lib/quoteStatus.ts is THE place two quote-workflow questions are decided, and both
// were behaviorally untested:
//   1. EXPIRY — has a sent quote lapsed? 'expired' is a DISPLAY overlay, never stored,
//      derived from status + valid_until. A wrong answer either nags the owner about a
//      live quote or lets a lapsed price still be accepted.
//   2. SEND-GATING — can this quote go to a customer at all? A quote with no price or no
//      customer must be stopped at the door, not discovered at invoicing.
//
// Every function takes an explicit todayISO/fromISO (no Date.now), so these are fully
// deterministic. CHARACTERIZATION only — expected values read from the implementation;
// no production change. (markSentPatch is passed an explicit nowISO for determinism.)

import {
  displayQuoteStatus, isQuoteExpired, daysUntilExpiry, isExpiringSoon,
  defaultValidUntil, markSentPatch, sendBlockedReason, canSendQuote, sendBlockedLabel,
  DEFAULT_QUOTE_VALID_DAYS, EXPIRING_SOON_DAYS,
  SYSTEM_ADVANCED_QUOTE_STATUSES, isSystemAdvancedQuoteStatus, QUOTE_STATUS_MEANING,
  type ExpirableQuote,
} from '../src/lib/quoteStatus'
import { STATUS_LABELS } from '../src/types'
import { readFileSync } from 'node:fs'
const QUOTE_STATUSES_FOR_LABELS = ['draft','sent','accepted','scheduled','completed','paid','declined'] as const

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const q = (status: string, valid_until: string | null = null): ExpirableQuote =>
  ({ status: status as ExpirableQuote['status'], valid_until })
const TODAY = '2026-06-10'

// ═══════════════════════════════════════════════════════════════════════════
H('1. displayQuoteStatus / isQuoteExpired — only a SENT quote can expire')
check('a sent quote past its valid_until reads expired',
  displayQuoteStatus(q('sent', '2026-06-09'), TODAY), 'expired')
check('today is still a VALID day — not expired (strict <, matches daysUntilExpiry 0)',
  displayQuoteStatus(q('sent', '2026-06-10'), TODAY), 'sent')
check('a sent quote with a future date reads sent',
  displayQuoteStatus(q('sent', '2026-06-11'), TODAY), 'sent')
check('a sent quote with NO valid_until never expires (legacy quotes stand)',
  displayQuoteStatus(q('sent', null), TODAY), 'sent')
check('an ACCEPTED quote with a long-past date is NOT "expired" (a won job can\'t lapse)',
  displayQuoteStatus(q('accepted', '2026-01-01'), TODAY), 'accepted')
check('a draft is never expired regardless of date', displayQuoteStatus(q('draft', '2026-01-01'), TODAY), 'draft')
check('isQuoteExpired agrees with the overlay (true)', isQuoteExpired(q('sent', '2026-06-09'), TODAY), true)
check('isQuoteExpired agrees with the overlay (false, accepted)', isQuoteExpired(q('accepted', '2026-01-01'), TODAY), false)

// ═══════════════════════════════════════════════════════════════════════════
H('2. daysUntilExpiry — whole days, null when there is nothing to warn about')
check('five days out → 5', daysUntilExpiry(q('sent', '2026-06-15'), TODAY), 5)
check('the last valid day → 0', daysUntilExpiry(q('sent', '2026-06-10'), TODAY), 0)
check('already lapsed → negative', daysUntilExpiry(q('sent', '2026-06-05'), TODAY), -5)
check('a non-sent quote has no expiry clock → null', daysUntilExpiry(q('accepted', '2026-06-15'), TODAY), null)
check('no valid_until → null', daysUntilExpiry(q('sent', null), TODAY), null)

// ═══════════════════════════════════════════════════════════════════════════
H('3. isExpiringSoon — live, valid, and inside the warning window')
check('3 days out → expiring soon', isExpiringSoon(q('sent', '2026-06-13'), TODAY), true)
check('exactly the window edge (5 days) → still soon', isExpiringSoon(q('sent', '2026-06-15'), TODAY), true)
check('just past the window (6 days) → not yet', isExpiringSoon(q('sent', '2026-06-16'), TODAY), false)
check('the last valid day (0) → soon', isExpiringSoon(q('sent', '2026-06-10'), TODAY), true)
check('already expired (−1) → not "soon" (it\'s gone, not lapsing)', isExpiringSoon(q('sent', '2026-06-09'), TODAY), false)
check('a draft is never "expiring soon"', isExpiringSoon(q('draft', '2026-06-13'), TODAY), false)

// ═══════════════════════════════════════════════════════════════════════════
H('4. defaultValidUntil — the 30-day clock, with real calendar rollover')
check('default is DEFAULT_QUOTE_VALID_DAYS out', defaultValidUntil('2026-06-01'), '2026-07-01')
check('an explicit horizon is honoured', defaultValidUntil('2026-06-01', 5), '2026-06-06')
check('rolls into the next month with zero-padding', defaultValidUntil('2026-01-05', 30), '2026-02-04')
check('rolls across a year boundary', defaultValidUntil('2026-12-20', 30), '2027-01-19')
check('the no-arg default equals passing the constant',
  defaultValidUntil('2026-06-01'), defaultValidUntil('2026-06-01', DEFAULT_QUOTE_VALID_DAYS))

// ═══════════════════════════════════════════════════════════════════════════
H('5. markSentPatch — one event, and it OMITS rather than overwrites')
const NOW = '2026-06-01T12:00:00.000Z'
check('a fresh send sets status + sent_at + a 30-day valid_until',
  markSentPatch({ sent_at: null, valid_until: null }, '2026-06-01', NOW),
  { status: 'sent', sent_at: NOW, valid_until: '2026-07-01' })
check('re-sending preserves the first-send anchor (sent_at is OMITTED, not reset)',
  markSentPatch({ sent_at: '2026-05-01T00:00:00.000Z', valid_until: null }, '2026-06-01', NOW),
  { status: 'sent', valid_until: '2026-07-01' })
check('an existing valid_until stands (the expiry clock isn\'t restarted)',
  markSentPatch({ sent_at: null, valid_until: '2026-12-31' }, '2026-06-01', NOW),
  { status: 'sent', sent_at: NOW })
check('when both already exist, only the status is asserted',
  markSentPatch({ sent_at: '2026-05-01T00:00:00.000Z', valid_until: '2026-12-31' }, '2026-06-01', NOW),
  { status: 'sent' })

// ═══════════════════════════════════════════════════════════════════════════
H('6. sendBlockedReason / canSendQuote — stop an undeliverable quote at the door')
check('no customer → no_customer (checked FIRST)', sendBlockedReason({ customer_id: null, total: 100 }), 'no_customer')
check('a real customer + price → clear to send (null)', sendBlockedReason({ customer_id: 'c1', total: 100 }), null)
check('a $0 total is "no price" — "$0.00" is as broken as blank', sendBlockedReason({ customer_id: 'c1', total: 0 }), 'no_price')
check('a null total is no_price', sendBlockedReason({ customer_id: 'c1', total: null }), 'no_price')
check('a negative total is no_price', sendBlockedReason({ customer_id: 'c1', total: -5 }), 'no_price')
check('missing both → customer wins the precedence', sendBlockedReason({ customer_id: null, total: null }), 'no_customer')
check('an empty object is blocked (no customer)', sendBlockedReason({}), 'no_customer')
check('canSendQuote is true only when nothing blocks', [canSendQuote({ customer_id: 'c1', total: 100 }), canSendQuote({ customer_id: 'c1', total: 0 })], [true, false])

// ═══════════════════════════════════════════════════════════════════════════
H('7. sendBlockedLabel + constants')
check('the no_price label tells the owner what to DO', sendBlockedLabel('no_price'), 'This quote has no price yet — add one before sending it.')
check('the no_customer label tells the owner what to DO', sendBlockedLabel('no_customer'), 'This quote has no customer linked — add one so it can be sent and followed up.')
check('DEFAULT_QUOTE_VALID_DAYS is 30', DEFAULT_QUOTE_VALID_DAYS, 30)
check('EXPIRING_SOON_DAYS is 5', EXPIRING_SOON_DAYS, 5)


// ═══════════════════════════════════════════════════════════════════════════
// STATUS PRESENTATION — the words the owner reads, pinned to what the row means.
//
// These labels are not cosmetic; they were derived by reading the live contracts.
// portal_accept_quote sets status='accepted' at the instant of CUSTOMER CONSENT and
// snapshots accepted_price — so "Approved" is the honest owner-facing word for it.
// resync_quote_on_job_recurring, sync_quote_on_job_complete and
// sync_quote_on_invoice_paid are DATABASE TRIGGERS, so scheduled/completed/paid are
// advanced by the app from real events rather than chosen by anyone.
//
// If a label is renamed back to the database's vocabulary, or a state is quietly
// dropped out of the picker, this fails.
console.log('\n── status presentation ──')
check('accepted reads as the customer APPROVING (portal_accept_quote records consent)', STATUS_LABELS.accepted, 'Approved')
check('draft stays plain', STATUS_LABELS.draft, 'Draft')
check('sent stays plain (it is the only state that can expire)', STATUS_LABELS.sent, 'Sent')
check('declined stays plain', STATUS_LABELS.declined, 'Declined')
check('every stored status has an owner-facing label', QUOTE_STATUSES_FOR_LABELS.every(s => !!STATUS_LABELS[s]), true)
check('every stored status explains what it MEANS', QUOTE_STATUSES_FOR_LABELS.every(s => !!QUOTE_STATUS_MEANING[s]), true)
// Exactly the three the app advances itself — no more (which would strip the owner's
// ability to correct a row) and no fewer (which would hide that the app manages it).
check('exactly scheduled/completed/paid are system-advanced', SYSTEM_ADVANCED_QUOTE_STATUSES.slice().sort().join(','), 'completed,paid,scheduled')
check('accepted is NOT system-advanced — a customer or the owner sets it', isSystemAdvancedQuoteStatus('accepted'), false)
check('sent is NOT system-advanced — the owner sends', isSystemAdvancedQuoteStatus('sent'), false)
// Capability guard: grouping the picker must never quietly become filtering it.
{
  const control = readFileSync('src/components/quotes/QuoteStatusControl.tsx', 'utf8')
  const offersAll = QUOTE_STATUSES_FOR_LABELS.every(s => control.includes(`'${s}'`))
  check('the picker still offers every stored status', offersAll, true)
  check('… split into owner-set and automatic groups, not filtered away',
    control.includes('You set these') && control.includes('Set automatically'), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
