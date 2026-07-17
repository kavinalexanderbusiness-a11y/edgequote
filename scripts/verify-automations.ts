/* eslint-disable no-console */
// End-to-end verification of the two automatic chasers' DECISION logic.
// Imports the real production functions — nothing is reimplemented here.
import { readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { dueForAutoFollowUp, needsFollowUp, quoteIsQuiet, resolveFollowUpPolicy, followUpsExhausted, FOLLOW_UP_DAYS, FOLLOW_UP_MAX } from '@/lib/followup'
import { dueForAutoReminder, resolveReminderPolicy, remindersExhausted, reminderAnchor, REMINDER_DELAY_DAYS, REMINDER_MAX } from '@/lib/payments/dunning'
import { displayInvoiceStatus, invoiceBalance } from '@/lib/payments/ledger'
import { resolveAutomations } from '@/lib/comms/automations'
import { displayQuoteStatus, isQuoteExpired, isExpiringSoon, daysUntilExpiry, defaultValidUntil } from '@/lib/quoteStatus'
import { prefAllows, msgCategory } from '@/lib/comms/templates'
// MERGE (main ← guardian-2): sendResultsFromAttempts is gone, and with it sections
// 18 and 23 (14 cases) that were its only tests. It existed to translate
// attempts → the legacy `results` map for /api/comms/send — guardian-2's only
// production caller. main's rework of that route builds the same shape inline, so
// the helper had no callers left. Resurrecting it purely to keep its own tests
// green would have added an exported function nothing calls. The CONTRACT those
// cases pinned (the route answers in SendResult vocabulary) still holds on main;
// it is simply no longer implemented by this helper, and main ships that route
// untested by this harness today — so removing them restores main's status quo
// rather than dropping live coverage.
import { dispatchToCustomer, type DispatchAttempt, type DispatchResult } from '@/lib/comms/dispatch'
import { logSend, logDispatch } from '@/lib/comms/log'
import { sendSms, sendEmail } from '@/lib/comms/send'
import { runChaseCron, type ChaseItem, type ChaseTally } from '@/lib/automation/chase'
import { SKIP_REASON, describeSkip } from '@/lib/comms/skipReasons'
import { canChaseCustomer, chaseBlockedReason } from '@/lib/followup'
import { cadenceDays, churnRisk, type CadenceRecLike } from '@/lib/signals'
import {
  buildTimeline, filterTimeline, searchTimeline, timelineForProperty, timelineGroupCounts,
  KIND_GROUP, TIMELINE_GROUPS, type TimelineEvent, type TimelineKind, type TlMessage, type TlPayment,
} from '@/lib/timeline'
import { effectiveFreq } from '@/lib/invoicing'
import { decide } from '@/lib/automation/decide'
import { AUTOMATION_RULES } from '@/lib/automation/rules'
import type { AutomationRule } from '@/lib/automation/types'
import type { Quote } from '@/types'
import type { FeeSettings } from '@/lib/invoiceTotals'

// The signals /api/cron/signals actually writes. Kept here so a rule watching a
// signal nothing emits fails the registry check below rather than sitting dead.
const EMITTED_SIGNALS = ['recurring_ran_out', 'churn_risk']

let pass = 0, fail = 0
const fails: string[] = []
function check(group: string, name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${group} › ${name}`); console.log(`  ❌ ${name}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
}
const H = (s: string) => console.log(`\n═══ ${s} ═══`)

// ── date helpers (local-anchored, matching the app) ──
const pad = (n: number) => String(n).padStart(2, '0')
function dateNDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
// EXACTLY n*24h ago, not "n calendar days ago at noon".
// followup/dunning measure elapsed days — Math.floor((now - anchor)/DAY) — so an
// anchor pinned to midday was only n-0.5 days old before noon and n+0.5 after it.
// Every boundary case ("sent 3d ago, delay 3 → due") therefore passed in the
// afternoon and failed in the morning. Deterministic at any hour now.
function isoNDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}
const TODAY = dateNDaysAgo(0)

// ── fixtures ──
const P = { delayDays: 3, maxCount: 2 }                    // quote policy under test
const RP = { delayDays: 3, maxCount: 3 }                   // invoice policy under test
const FEES: FeeSettings = { gst_percent: 0, payment_fee_strategy: 'absorb', fee_recovery_percent: 0 }

function quote(over: Partial<Quote>): Quote {
  return { id: 'q', user_id: 'u', status: 'sent', total: 100, sent_at: isoNDaysAgo(10), last_followed_up_at: null, follow_up_count: 0, ...over } as Quote
}
type Inv = Parameters<typeof dueForAutoReminder>[0] & { amount: number; amount_paid: number }
function invoice(over: Partial<Inv>): Inv {
  return { status: 'unpaid', due_date: dateNDaysAgo(10), amount: 100, amount_paid: 0, discount_type: null, discount_value: null, viewed_at: null, last_reminded_at: null, reminder_count: 0, ...over } as Inv
}

// ═════════════════════════════════════════════════════════════════════════════
H('1. QUOTE FOLLOW-UP — stop conditions (a quote that was answered is never chased)')
for (const s of ['accepted', 'declined', 'scheduled', 'completed', 'paid', 'draft'] as const) {
  check('stop', `status='${s}' → not chased`, dueForAutoFollowUp(quote({ status: s }), P), false)
}
check('stop', `status='sent' → chased`, dueForAutoFollowUp(quote({}), P), true)

H('2. QUOTE FOLLOW-UP — delay boundary (owner-configured)')
check('delay', 'sent today (0d) → not due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(0) }), P), false)
check('delay', 'sent 2d ago, delay 3 → not due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(2) }), P), false)
check('delay', 'sent 3d ago, delay 3 → DUE (boundary is >=)', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(3) }), P), true)
check('delay', 'sent 2d ago, delay 1 → due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(2) }), { delayDays: 1, maxCount: 2 }), true)
check('delay', 'sent 5d ago, delay 7 → not due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(5) }), { delayDays: 7, maxCount: 2 }), false)
check('delay', 'sent_at null → surfaced', dueForAutoFollowUp(quote({ sent_at: null }), P), true)

H('3. QUOTE FOLLOW-UP — DUPLICATE PROTECTION (the anchor moves on claim)')
check('dup', 'just chased (anchor=now) → NOT due again', dueForAutoFollowUp(quote({ last_followed_up_at: isoNDaysAgo(0), follow_up_count: 1 }), P), false)
check('dup', 'chased 2d ago, delay 3 → still not due', dueForAutoFollowUp(quote({ last_followed_up_at: isoNDaysAgo(2), follow_up_count: 1 }), P), false)
check('dup', 'chased 3d ago → due again', dueForAutoFollowUp(quote({ last_followed_up_at: isoNDaysAgo(3), follow_up_count: 1 }), P), true)
check('dup', 'anchor overrides an ancient sent_at', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(90), last_followed_up_at: isoNDaysAgo(0), follow_up_count: 1 }), P), false)

H('4. QUOTE FOLLOW-UP — maximum count')
check('max', 'count 0 of 2 → due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(10), follow_up_count: 0 }), P), true)
check('max', 'count 1 of 2 → due', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(10), follow_up_count: 1 }), P), true)
check('max', 'count 2 of 2 → EXHAUSTED', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(10), follow_up_count: 2 }), P), false)
check('max', 'count 3 of 2 (over) → exhausted', dueForAutoFollowUp(quote({ sent_at: isoNDaysAgo(10), follow_up_count: 3 }), P), false)
check('max', 'maxCount 0 → chaser fully disabled', dueForAutoFollowUp(quote({}), { delayDays: 3, maxCount: 0 }), false)
check('max', 'followUpsExhausted(2 of 2)', followUpsExhausted(quote({ follow_up_count: 2 }), P), true)

H('5. QUOTE FOLLOW-UP — manual queue vs cron use the SAME staleness rule')
const q3 = quote({ sent_at: isoNDaysAgo(3) })
check('engine', 'needsFollowUp == quoteIsQuiet(default)', needsFollowUp(q3), quoteIsQuiet(q3, FOLLOW_UP_DAYS))
check('engine', 'needsFollowUp is single-arg (filter-safe)', [q3].filter(needsFollowUp).length, 1)
check('engine', 'cron@default agrees with manual queue', dueForAutoFollowUp(q3, { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX }), needsFollowUp(q3))

// ═════════════════════════════════════════════════════════════════════════════
H('6. INVOICE REMINDER — PAYMENT IMMEDIATELY BEFORE CRON (the money already landed)')
check('paid', 'paid in full → NOT chased', dueForAutoReminder(invoice({ status: 'paid', amount_paid: 100 }), FEES, TODAY, RP), false)
check('paid', 'balance cleared but status still "partial" → NOT chased (ledger decides, not status)',
  dueForAutoReminder(invoice({ status: 'partial', amount_paid: 100 }), FEES, TODAY, RP), false)
check('paid', 'overpaid → not chased', dueForAutoReminder(invoice({ status: 'overpaid', amount_paid: 150 }), FEES, TODAY, RP), false)
check('paid', 'partial WITH balance owing → still chased', dueForAutoReminder(invoice({ status: 'partial', amount_paid: 40 }), FEES, TODAY, RP), true)
check('paid', 'balance of 1 cent → not chased (>0.01 threshold)', dueForAutoReminder(invoice({ status: 'partial', amount_paid: 99.995 }), FEES, TODAY, RP), false)

H('7. INVOICE REMINDER — other stop conditions')
check('stop', 'cancelled → not chased', dueForAutoReminder(invoice({ status: 'cancelled' }), FEES, TODAY, RP), false)
check('stop', 'draft → not chased', dueForAutoReminder(invoice({ status: 'draft' }), FEES, TODAY, RP), false)
check('stop', 'not yet due (due tomorrow) → not chased', dueForAutoReminder(invoice({ due_date: dateNDaysAgo(-1) }), FEES, TODAY, RP), false)
check('stop', 'due TODAY → not chased (not yet overdue)', dueForAutoReminder(invoice({ due_date: TODAY }), FEES, TODAY, RP), false)
check('stop', 'no due date → not chased (no anchor)', dueForAutoReminder(invoice({ due_date: null }), FEES, TODAY, RP), false)

H('8. INVOICE REMINDER — delay measured from the DUE DATE')
check('delay', 'due 1d ago, delay 3 → not due', dueForAutoReminder(invoice({ due_date: dateNDaysAgo(1) }), FEES, TODAY, RP), false)
check('delay', 'due 2d ago, delay 3 → not due', dueForAutoReminder(invoice({ due_date: dateNDaysAgo(2) }), FEES, TODAY, RP), false)
check('delay', 'due 3d ago, delay 3 → DUE (boundary)', dueForAutoReminder(invoice({ due_date: dateNDaysAgo(3) }), FEES, TODAY, RP), true)

H('9. INVOICE REMINDER — duplicate protection + limits')
check('dup', 'just reminded → NOT due again', dueForAutoReminder(invoice({ last_reminded_at: isoNDaysAgo(0), reminder_count: 1 }), FEES, TODAY, RP), false)
check('dup', 'reminded 3d ago → due again', dueForAutoReminder(invoice({ last_reminded_at: isoNDaysAgo(3), reminder_count: 1 }), FEES, TODAY, RP), true)
check('dup', 'anchor overrides an ancient due_date', dueForAutoReminder(invoice({ due_date: dateNDaysAgo(90), last_reminded_at: isoNDaysAgo(0), reminder_count: 1 }), FEES, TODAY, RP), false)
check('max', 'count 3 of 3 → EXHAUSTED', dueForAutoReminder(invoice({ reminder_count: 3 }), FEES, TODAY, RP), false)
check('max', 'count 2 of 3 → due', dueForAutoReminder(invoice({ reminder_count: 2 }), FEES, TODAY, RP), true)
check('max', 'maxCount 0 → fully disabled', dueForAutoReminder(invoice({}), FEES, TODAY, { delayDays: 3, maxCount: 0 }), false)
check('max', 'remindersExhausted(3 of 3)', remindersExhausted(invoice({ reminder_count: 3 }), RP), true)
check('anchor', 'anchor = last_reminded_at when present', reminderAnchor(invoice({ last_reminded_at: 'X' })), 'X')
check('anchor', 'anchor = due_date when never reminded', reminderAnchor(invoice({ due_date: '2026-01-01' })), '2026-01-01')

H('10. INVOICE REMINDER — reuses the ledger (no second overdue rule)')
check('engine', 'ledger says overdue for the chased case',
  displayInvoiceStatus(invoice({ due_date: dateNDaysAgo(5) }), FEES, TODAY), 'overdue')
check('engine', 'ledger says paid for the skipped case',
  displayInvoiceStatus(invoice({ status: 'paid', amount_paid: 100 }), FEES, TODAY), 'paid')
check('engine', 'amount in the message = ledger balance',
  invoiceBalance(invoice({ amount: 100, amount_paid: 40 }), FEES).balance, 60)
check('engine', 'GST-inclusive balance follows settings',
  invoiceBalance(invoice({ amount: 100, amount_paid: 0 }), { ...FEES, gst_percent: 5 }).balance, 105)

// ═════════════════════════════════════════════════════════════════════════════
H('11. DISABLED AUTOMATION — defaults')
const A = resolveAutomations(null)
check('auto', 'quote_followup defaults OFF', A.quote_followup, false)
check('auto', 'invoice_reminder defaults OFF', A.invoice_reminder, false)
check('auto', 'reminder defaults ON', A.reminder, true)
check('auto', 'review defaults ON', A.review, true)
check('auto', 'explicit true enables quote_followup', resolveAutomations({ quote_followup: true }).quote_followup, true)
check('auto', 'explicit true enables invoice_reminder', resolveAutomations({ invoice_reminder: true }).invoice_reminder, true)
check('auto', 'truthy-but-not-true does NOT enable', resolveAutomations({ quote_followup: 'yes' }).quote_followup, false)
check('auto', 'explicit false disables reminder', resolveAutomations({ reminder: false }).reminder, false)

H('12. POLICY RESOLUTION — clamping hostile input')
check('policy', 'unset → defaults', resolveFollowUpPolicy({}), { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })
check('policy', 'null → defaults', resolveFollowUpPolicy(null), { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })
check('policy', 'delay 0 → default (never same-day spam)', resolveFollowUpPolicy({ quote_followup_delay_days: 0 }).delayDays, FOLLOW_UP_DAYS)
check('policy', 'delay -5 → default', resolveFollowUpPolicy({ quote_followup_delay_days: -5 }).delayDays, FOLLOW_UP_DAYS)
check('policy', 'delay 9999 → clamped to 60', resolveFollowUpPolicy({ quote_followup_delay_days: 9999 }).delayDays, 60)
check('policy', 'max 9999 → clamped to 10', resolveFollowUpPolicy({ quote_followup_max: 9999 }).maxCount, 10)
check('policy', 'max 0 → honoured (disable)', resolveFollowUpPolicy({ quote_followup_max: 0 }).maxCount, 0)
check('policy', 'garbage string → defaults', resolveFollowUpPolicy({ quote_followup_delay_days: 'abc', quote_followup_max: 'x' }), { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX })
check('policy', 'reminder unset → defaults', resolveReminderPolicy({}), { delayDays: REMINDER_DELAY_DAYS, maxCount: REMINDER_MAX })
check('policy', 'reminder delay 9999 → clamped', resolveReminderPolicy({ invoice_reminder_delay_days: 9999 }).delayDays, 60)
check('policy', 'the two policies read DIFFERENT keys',
  [resolveFollowUpPolicy({ invoice_reminder_delay_days: 9 }).delayDays, resolveReminderPolicy({ invoice_reminder_delay_days: 9 }).delayDays], [FOLLOW_UP_DAYS, 9])

// ═════════════════════════════════════════════════════════════════════════════
H('13. OPT-OUT — granular consent category mapping')
check('consent', 'estimate_followup → estimates category', msgCategory('estimate_followup'), 'estimates')
check('consent', 'payment_reminder → invoices category', msgCategory('payment_reminder'), 'invoices')
check('consent', 'opted out of estimates blocks estimate_followup', prefAllows({ estimates: false } as never, 'estimate_followup'), false)
check('consent', 'opted out of invoices blocks payment_reminder', prefAllows({ invoices: false } as never, 'payment_reminder'), false)
check('consent', 'opting out of marketing does NOT block payment_reminder', prefAllows({ marketing: false } as never, 'payment_reminder'), true)
check('consent', 'null prefs pass (channel opt-in still gates)', prefAllows(null, 'payment_reminder'), true)

H('15. TRIGGER vs LEDGER — the CAS status-guard must never disagree with the balance')
// The cron decides with the LEDGER (invoiceBalance) but its CAS claim guards on
// STATUS, which the recompute_invoice_paid trigger maintains as:
//     v_total := round(amount * (1 + gst/100), 2)
// If the ledger's total ever diverged from that, a fully-paid invoice could carry a
// chaseable status (or vice-versa). Assert they agree across the whole matrix.
// (invoices.amount is already NET of discount and already includes baked-in fee
// recovery — invoiceTotals only reverses the discount to *display* a breakdown.)
const triggerTotal = (amount: number, gst: number) => Math.round(amount * (1 + gst / 100) * 100) / 100
{
  const matrix: { amount: number; gst: number; d: { discount_type: 'percent' | 'amount' | null; discount_value: number | null }; label: string }[] = [
    { amount: 100, gst: 0, d: { discount_type: null, discount_value: null }, label: 'plain' },
    { amount: 100, gst: 5, d: { discount_type: null, discount_value: null }, label: 'gst 5%' },
    { amount: 80, gst: 0, d: { discount_type: 'percent', discount_value: 20 }, label: 'percent discount' },
    { amount: 80, gst: 5, d: { discount_type: 'amount', discount_value: 20 }, label: '$ discount + gst' },
    { amount: 103, gst: 5, d: { discount_type: null, discount_value: null }, label: 'fee-recovery baked in' },
  ]
  for (const m of matrix) {
    const inv = invoice({ amount: m.amount, ...m.d })
    const ledger = invoiceBalance(inv, { ...FEES, gst_percent: m.gst }).total
    check('agree', `ledger total == trigger total (${m.label})`, ledger, triggerTotal(m.amount, m.gst))
  }
  // Fee strategy must not re-apply at invoice time (it's already inside `amount`).
  const inv = invoice({ amount: 100 })
  check('agree', 'global_price_increase does NOT re-inflate the invoice total',
    invoiceBalance(inv, { gst_percent: 0, payment_fee_strategy: 'global_price_increase', fee_recovery_percent: 3 }).total, 100)

  // Therefore: paid-in-full is unchaseable by BOTH layers, on the same numbers.
  const full = invoice({ amount: 80, discount_type: 'percent', discount_value: 20, amount_paid: 80, status: 'paid', due_date: dateNDaysAgo(10) })
  check('agree', 'fully-paid discounted invoice → balance 0', invoiceBalance(full, FEES).balance, 0)
  check('agree', '➜ NOT chased', dueForAutoReminder(full, FEES, TODAY, RP), false)
  const owing = invoice({ amount: 80, discount_type: 'percent', discount_value: 20, amount_paid: 50, status: 'partial', due_date: dateNDaysAgo(10) })
  check('agree', 'genuinely underpaid → chased', dueForAutoReminder(owing, FEES, TODAY, RP), true)
  check('agree', 'chased for the real balance (30)', invoiceBalance(owing, FEES).balance, 30)
}

H('16. PAYMENT IMMEDIATELY AFTER CLAIM — the residual window')
{
  // t0: due, claim would succeed.
  const before = invoice({ due_date: dateNDaysAgo(10), status: 'unpaid', amount_paid: 0 })
  check('window', 't0: decision says chase', dueForAutoReminder(before, FEES, TODAY, RP), true)
  // t1: the CAS claim lands. Re-decide with the claimed state.
  const claimed = { ...before, last_reminded_at: new Date().toISOString(), reminder_count: 1 }
  check('window', 't1: after claim, immediately NOT due again (duplicate-safe)', dueForAutoReminder(claimed, FEES, TODAY, RP), false)
  // t2: payment lands AFTER the claim but BEFORE the send — the send is already in flight.
  const paidAfterClaim = { ...claimed, status: 'paid' as const, amount_paid: 100 }
  check('window', 't2: a re-check WOULD catch it (basis for a pre-send guard)', dueForAutoReminder(paidAfterClaim, FEES, TODAY, RP), false)
  // And the claim itself is not repeatable, so the next run stays quiet.
  check('window', 't3: next cron run does not re-chase', dueForAutoReminder(paidAfterClaim, FEES, TODAY, RP), false)
}

H('17. QUOTE EXPIRY — only a live quote expires, and expiry stops the chaser')
{
  const eq = (over: Partial<Quote> & { valid_until?: string | null }) => quote(over) as Quote & { valid_until?: string | null }
  check('expiry', 'sent + past valid_until → expired', displayQuoteStatus(eq({ valid_until: dateNDaysAgo(1) }), TODAY), 'expired')
  check('expiry', 'sent + valid_until today → still valid (last day)', displayQuoteStatus(eq({ valid_until: TODAY }), TODAY), 'sent')
  check('expiry', 'sent + future valid_until → sent', displayQuoteStatus(eq({ valid_until: dateNDaysAgo(-5) }), TODAY), 'sent')
  check('expiry', 'no valid_until → never expires (pre-existing quotes)', displayQuoteStatus(eq({ valid_until: null }), TODAY), 'sent')
  // Only a live quote can expire — an "expired" badge on a won job is nonsense.
  for (const s of ['accepted', 'declined', 'scheduled', 'completed', 'paid', 'draft'] as const) {
    check('expiry', `status='${s}' + past date → NOT expired`, isQuoteExpired(eq({ status: s, valid_until: dateNDaysAgo(30) }), TODAY), false)
  }
  check('expiry', 'daysUntilExpiry: 5 days out', daysUntilExpiry(eq({ valid_until: dateNDaysAgo(-5) }), TODAY), 5)
  check('expiry', 'daysUntilExpiry: expired reads negative', daysUntilExpiry(eq({ valid_until: dateNDaysAgo(3) }), TODAY), -3)
  check('expiry', 'expiring soon at 5 days', isExpiringSoon(eq({ valid_until: dateNDaysAgo(-5) }), TODAY), true)
  check('expiry', 'NOT "soon" at 6 days', isExpiringSoon(eq({ valid_until: dateNDaysAgo(-6) }), TODAY), false)
  check('expiry', 'already expired is not "expiring soon"', isExpiringSoon(eq({ valid_until: dateNDaysAgo(1) }), TODAY), false)
  check('expiry', 'defaultValidUntil is 30 days out', defaultValidUntil(TODAY), dateNDaysAgo(-30))
  // The chaser and the list must agree: expiry is what stops the follow-up.
  const expired = eq({ sent_at: isoNDaysAgo(20), valid_until: dateNDaysAgo(1), follow_up_count: 0 })
  check('expiry', 'engine still calls it stale (staleness != expiry)', dueForAutoFollowUp(expired, P), true)
  check('expiry', '➜ but the cron skips it on isQuoteExpired', isQuoteExpired(expired, TODAY), true)
}

H('14. OPT-OUT — dispatchToCustomer skips (no network: these must not send)')
const sbStub = null as never
async function run() {
  const base = { userId: 'u', channels: ['sms', 'email'], smsText: 's', emailSubject: 'x', emailHtml: 'h', emailText: 't', template: 'payment_reminder' }
  const optedOut = await dispatchToCustomer(sbStub, { ...base, customer: { id: 'c', phone: '+15550100', email: 'a@b.c', sms_opt_in: false, email_opt_in: false } })
  check('dispatch', 'both channels opted out → 2 skips, 0 sent', [optedOut.attempts.map(a => a.status), optedOut.sentChannels], [['skipped', 'skipped'], []])
  check('dispatch', 'skip reason is canonical', optedOut.attempts.map(a => a.detail), ['no opt-in', 'no opt-in'])

  const noContact = await dispatchToCustomer(sbStub, { ...base, customer: { id: 'c', phone: null, email: null, sms_opt_in: true, email_opt_in: true } })
  check('dispatch', 'opted in but no contact → skips w/ reasons', noContact.attempts.map(a => a.detail), ['no phone', 'no email'])

  const catOut = await dispatchToCustomer(sbStub, { ...base, customer: { id: 'c', phone: '+15550100', email: 'a@b.c', sms_opt_in: true, email_opt_in: true, message_prefs: { invoices: false } as never } })
  check('dispatch', 'granular opt-out short-circuits BOTH channels', [catOut.attempts.map(a => a.status), catOut.attempts.map(a => a.detail)], [['skipped', 'skipped'], ['unsubscribed', 'unsubscribed']])
  check('dispatch', 'nothing sent → nothing threaded', catOut.messageId, null)

  // ═══════════════════════════════════════════════════════════════════════════
  H('19. AUTOMATION ENGINE — the gate that decides whether a rule may act')
  // decide() is the most safety-critical function in the engine: it is the only
  // thing standing between a detected condition and a real customer. Test it like it.
  const RULE: AutomationRule = {
    key: 'test', label: 'test', signal: 'sig',
    action: { kind: 'notify', notificationType: 'x' },
    mode: 'auto', holdMinutes: 0,
    constraints: { sendWindowHours: [9, 19], maxPerCustomerPer: { count: 1, days: 14 }, maxPerRun: 25 },
  }
  const D = (over: Partial<Parameters<typeof decide>[0]>) => decide({
    rule: RULE, hour: 12, recentActionsForSubject: 0, actionsThisRun: 0, alreadyDeduped: false, ...over,
  })

  check('decide', 'auto + all clear → fires', D({}), { fire: true })
  check('decide', 'off → suppressed(mode_off)', D({ rule: { ...RULE, mode: 'off' } }), { fire: false, reason: 'mode_off' })
  // The distinction the whole safety model rests on: 'suggest' is NOT 'off'. A run
  // log that conflates "waiting to be trusted" with "switched off" is useless.
  check('decide', 'suggest → suppressed(mode_suggest), NOT mode_off', D({ rule: { ...RULE, mode: 'suggest' } }), { fire: false, reason: 'mode_suggest' })

  check('decide', 'deduped → suppressed(deduped)', D({ alreadyDeduped: true }), { fire: false, reason: 'deduped' })
  // Order matters: a duplicate must not burn the frequency quota on its way out.
  check('decide', 'deduped is checked BEFORE the caps', D({ alreadyDeduped: true, recentActionsForSubject: 99 }), { fire: false, reason: 'deduped' })
  // …and authority outranks everything, so an off rule never reports a lesser reason.
  check('decide', 'off outranks deduped + quiet hours', D({ rule: { ...RULE, mode: 'off' }, alreadyDeduped: true, hour: 3 }), { fire: false, reason: 'mode_off' })

  check('decide', '3am → quiet_hours (a correct message at 3am is a wrong message)', D({ hour: 3 }), { fire: false, reason: 'quiet_hours' })
  check('decide', '9am (window opens) → fires', D({ hour: 9 }), { fire: true })
  check('decide', '18:xx (last hour) → fires', D({ hour: 18 }), { fire: true })
  check('decide', '19:00 (window closes, end-exclusive) → quiet_hours', D({ hour: 19 }), { fire: false, reason: 'quiet_hours' })

  check('decide', 'per-customer cap reached → frequency_cap', D({ recentActionsForSubject: 1 }), { fire: false, reason: 'frequency_cap' })
  check('decide', 'under the per-customer cap → fires', D({ recentActionsForSubject: 0 }), { fire: true })
  check('decide', 'per-run blast radius reached → frequency_cap', D({ actionsThisRun: 25 }), { fire: false, reason: 'frequency_cap' })
  check('decide', 'quiet hours outrank the caps', D({ hour: 3, recentActionsForSubject: 99 }), { fire: false, reason: 'quiet_hours' })

  // An UNCOUNTED history must fail closed. The engine cannot count a subject's
  // recent actions yet, and it used to say `0` — a number that reads as "checked,
  // and they've been left alone", which no query had established. `0 >= 1` is false,
  // so the per-customer cap could never trip: a promoted rule would re-notify the
  // same customer every night the sweep re-emitted their signal, with the safeguard
  // fully written and silently defeated by its caller. 'unknown' makes the lie
  // unrepresentable — the type no longer has a way to spell "I didn't look".
  check('decide', "recentActionsForSubject 'unknown' → frequency_cap (fails CLOSED)",
    D({ recentActionsForSubject: 'unknown' }), { fire: false, reason: 'frequency_cap' })
  check('decide', "'unknown' suppresses even with everything else clear",
    D({ recentActionsForSubject: 'unknown', hour: 12, actionsThisRun: 0, alreadyDeduped: false }), { fire: false, reason: 'frequency_cap' })
  // …but it is a CAP, not an override: the more absolute reasons still outrank it,
  // so the run log keeps reporting the most useful one.
  check('decide', "'unknown' does not mask mode_suggest", D({ rule: { ...RULE, mode: 'suggest' }, recentActionsForSubject: 'unknown' }), { fire: false, reason: 'mode_suggest' })
  check('decide', "'unknown' does not mask quiet_hours", D({ hour: 3, recentActionsForSubject: 'unknown' }), { fire: false, reason: 'quiet_hours' })
  check('decide', "'unknown' does not mask deduped", D({ alreadyDeduped: true, recentActionsForSubject: 'unknown' }), { fire: false, reason: 'deduped' })
  // The only way to fire remains a REAL count. This is the line the engine must
  // cross deliberately, by writing the query — not by picking a hopeful default.
  check('decide', 'a real count of 0 is the only thing that fires', D({ recentActionsForSubject: 0 }), { fire: true })

  H('20. AUTOMATION ENGINE — the registry is an inventory, and nothing is promoted')
  // This is a GUARD RAIL, not a description. Promoting a rule to 'auto' is an owner
  // decision that must be deliberate; if a promotion ever lands by accident, this
  // fails loudly instead of a customer finding out.
  check('registry', 'NO rule is promoted to auto', AUTOMATION_RULES.filter(r => r.mode === 'auto').map(r => r.key), [])
  check('registry', 'every rule declares a signal', AUTOMATION_RULES.every(r => !!r.signal), true)
  check('registry', 'every rule has a send window', AUTOMATION_RULES.every(r => r.constraints.sendWindowHours.length === 2), true)
  check('registry', 'every rule caps its blast radius', AUTOMATION_RULES.every(r => r.constraints.maxPerRun > 0), true)
  check('registry', 'rule keys are unique', new Set(AUTOMATION_RULES.map(r => r.key)).size, AUTOMATION_RULES.length)
  // Every rule in the registry fires on a signal the sweep can actually emit —
  // otherwise it is a rule that can never run, quietly.
  check('registry', 'every rule watches a signal the sweep emits', AUTOMATION_RULES.every(r => EMITTED_SIGNALS.includes(r.signal)), true)

  // …and the check above reads the registry ONCE, at startup. `const` protects only
  // the binding, so `AUTOMATION_RULES[0].mode = 'auto'` used to typecheck — a
  // one-character grant of authority to message real customers, invisible to the
  // compiler AND to the guard rail above, which had already run. The registry is now
  // deeply frozen and deeply readonly, so promotion is what it should always have
  // been: editing `mode:` in rules.ts, in a diff someone reads.
  check('registry', 'the registry is frozen', Object.isFrozen(AUTOMATION_RULES), true)
  check('registry', '➜ deeply — every rule, its constraints, and its caps',
    AUTOMATION_RULES.every(r => Object.isFrozen(r) && Object.isFrozen(r.constraints)
      && Object.isFrozen(r.constraints.maxPerCustomerPer) && Object.isFrozen(r.constraints.sendWindowHours)), true)
  // The behavioural proof, and the one that matters: a rejected write throws in strict
  // mode and no-ops in sloppy mode, so assert what holds in BOTH — the value does not
  // move. A test for the throw would pass or fail on how the runner transpiled.
  check('registry', '➜ a runtime promotion to auto does not take',
    (() => { try { (AUTOMATION_RULES[0] as unknown as { mode: string }).mode = 'auto' } catch { /* strict mode */ } return AUTOMATION_RULES[0].mode })(), 'suggest')

  // ═══════════════════════════════════════════════════════════════════════════
  H('21. RETRYABLE CLASSIFICATION — would this exact message plausibly send later?')
  // The attempt budget is spent on this answer, so it is pinned here per status.
  // These drive the REAL sendSms/sendEmail with fetch stubbed at the network
  // boundary — the classification under test is the production one.
  const realFetch = globalThis.fetch
  const ENV = { ...process.env }
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550000',
    RESEND_API_KEY: 're_test', RESEND_FROM: 'noreply@test.co',
  })
  // Stub the network, run one real send, restore. `body` lets a case carry the
  // provider's own error JSON so the real parse path runs too.
  const httpSms = async (status: number, body = '{}') => {
    globalThis.fetch = (async () => new Response(body, { status })) as never
    try { const r = await sendSms('+15550100', 'x'); return [r.sent, r.reason, r.retryable] }
    finally { globalThis.fetch = realFetch }
  }
  const httpEmail = async (status: number, body = '{}') => {
    globalThis.fetch = (async () => new Response(body, { status })) as never
    try { const r = await sendEmail('a@b.c', 's', 'h', 't'); return [r.sent, r.reason, r.retryable] }
    finally { globalThis.fetch = realFetch }
  }

  // Retryable: the provider is down, hung, or telling us to slow down. None of
  // these is a verdict on the message.
  check('classify', 'sms 429 rate-limited → retryable', await httpSms(429), [false, 'error', true])
  check('classify', 'sms 500 → retryable', await httpSms(500), [false, 'error', true])
  check('classify', 'sms 502 → retryable', await httpSms(502), [false, 'error', true])
  check('classify', 'sms 503 → retryable', await httpSms(503), [false, 'error', true])
  check('classify', 'email 429 → retryable', await httpEmail(429), [false, 'error', true])
  check('classify', 'email 500 → retryable', await httpEmail(500), [false, 'error', true])

  // NOT retryable: the provider is rejecting THIS message. Retrying re-sends
  // identical bytes to an identical rejection — a typo'd number must not chase
  // forever on the owner's dime.
  check('classify', 'sms 400 invalid number → NOT retryable', await httpSms(400, '{"code":21211,"message":"Invalid \'To\' Number"}'), [false, 'error', false])
  check('classify', 'sms 401 bad credentials → NOT retryable', await httpSms(401), [false, 'error', false])
  check('classify', 'sms 403 → NOT retryable', await httpSms(403), [false, 'error', false])
  check('classify', 'sms 404 → NOT retryable', await httpSms(404), [false, 'error', false])
  check('classify', 'email 422 bad address → NOT retryable', await httpEmail(422), [false, 'error', false])
  // 499 is the top of the 4xx band — the boundary httpRetryable must not round up.
  check('classify', 'sms 499 → NOT retryable (4xx boundary)', await httpSms(499), [false, 'error', false])

  // Thrown out of fetch: abort/timeout, DNS, dropped socket. A timeout is the
  // sharpest case — the provider may even have sent it; we simply never heard.
  const thrower = async (e: unknown) => {
    globalThis.fetch = (async () => { throw e }) as never
    try { const r = await sendSms('+15550100', 'x'); return [r.sent, r.reason, r.retryable] }
    finally { globalThis.fetch = realFetch }
  }
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  check('classify', 'network throw → retryable', await thrower(new TypeError('fetch failed')), [false, 'error', true])
  check('classify', 'timeout/abort → retryable (we never learned if it sent)', await thrower(abortErr), [false, 'error', true])

  // A success is never reclassified, and the existing reason/id contract holds.
  globalThis.fetch = (async () => new Response('{"sid":"SM1"}', { status: 200 })) as never
  const okSms = await sendSms('+15550100', 'x')
  globalThis.fetch = realFetch
  check('classify', 'sent → untouched (no retryable claim on a success)', [okSms.sent, okSms.reason, okSms.id, okSms.retryable], [true, 'sent', 'SM1', undefined])

  // No number on file cannot fix itself on a retry — and this must not reach fetch.
  check('classify', 'no recipient → error, NOT retryable', await (async () => { const r = await sendSms('', 'x'); return [r.sent, r.reason, r.retryable] })(), [false, 'error', false])

  // Credentials absent is not a failure at all — it's the off switch.
  const noEnv = { ...process.env }
  delete process.env.TWILIO_ACCOUNT_SID
  check('classify', 'disabled (no credentials) → not an error, not retryable', await (async () => { const r = await sendSms('+15550100', 'x'); return [r.sent, r.reason, r.retryable] })(), [false, 'disabled', undefined])
  Object.assign(process.env, noEnv)

  // ═══════════════════════════════════════════════════════════════════════════
  H('22. PROVIDER OUTAGE — a failed send must not burn a chase attempt (the money leak)')
  // runChaseCron claims (spends) an attempt BEFORE dispatch, and sendSms/sendEmail
  // report an outage by RETURNING { sent:false }, not by throwing. Nothing ever
  // decremented the counter, so with FOLLOW_UP_MAX=2 two Twilio-down runs retired a
  // live quote FOREVER having sent zero messages. These drive the real
  // runChaseCron → dispatchToCustomer → sendSms/sendEmail path.
  {
    // The DB row the CAS statements act on. `item` below is the row as READ at the
    // start of a run — a SNAPSHOT. In production the claim's UPDATE lands in
    // Postgres and never touches the in-memory object, which is exactly why
    // refund's `seen = item.follow_up_count` is still the PRE-claim value. Modelling
    // that split is the point; collapsing it would test a fiction.
    const db = { follow_up_count: 0, last_followed_up_at: null as string | null }

    type OutageItem = ChaseItem & Pick<Quote, 'status' | 'total' | 'sent_at' | 'last_followed_up_at' | 'follow_up_count'>
    const mkItem = (over: Partial<{ sms_opt_in: boolean; email_opt_in: boolean }> = {}): OutageItem => ({
      id: 'q1', user_id: 'u1', customer_id: 'c1',
      status: 'sent', total: 100, sent_at: isoNDaysAgo(10),
      follow_up_count: db.follow_up_count,
      last_followed_up_at: db.last_followed_up_at,
      customers: { phone: '+15550100', email: 'a@b.c', sms_opt_in: true, email_opt_in: true, ...over },
    })

    // Minimal Supabase stand-in: notification_log inserts are fire-and-forget, and
    // the conversation lookup answers "none" so nothing is threaded — correct, since
    // every send below is meant to fail.
    const table = () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'upsert']) b[m] = () => b
      b.insert = async () => ({ error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
      b.single = async () => ({ data: null, error: null })
      return b
    }
    const sbFake = { from: () => table() } as never

    // claim/refund TRANSCRIBE the route's SQL (src/app/api/cron/quote-followup):
    //   claim  → set follow_up_count = seen + 1 ... where follow_up_count = seen
    //   refund → set follow_up_count = seen     ... where follow_up_count = seen + 1
    // The route's SQL is the source of truth; this mirrors it because there is no DB
    // here. `render` throwing models ensurePortalToken dying.
    const oneRun = async (item: OutageItem, opts: { throwOnRender?: boolean } = {}): Promise<ChaseTally> =>
      runChaseCron<OutageItem, { policy: typeof P }>(sbFake, {
        items: [item], template: 'estimate_followup', errorLabel: 'follow-up failed',
        loadContext: async () => ({ policy: P }),
        enabled: () => true,
        due: q => dueForAutoFollowUp(q as unknown as Quote, P),
        claim: async q => {
          const seen = q.follow_up_count ?? 0
          if (db.follow_up_count !== seen) return false
          db.follow_up_count = seen + 1
          db.last_followed_up_at = new Date().toISOString()
          return true
        },
        refund: async q => {
          const seen = q.follow_up_count ?? 0
          if (db.follow_up_count === seen + 1) db.follow_up_count = seen
        },
        render: async () => {
          if (opts.throwOnRender) throw new Error('ensurePortalToken failed')
          return { smsText: 's', emailSubject: 'x', emailHtml: 'h', emailText: 't' }
        },
      })
    const withFetch = async (stub: unknown, fn: () => Promise<ChaseTally>): Promise<ChaseTally> => {
      globalThis.fetch = stub as never
      try { return await fn() } finally { globalThis.fetch = realFetch }
    }
    const reset = () => { db.follow_up_count = 0; db.last_followed_up_at = null }
    const down = async () => new Response('upstream boom', { status: 500 })
    const rejects = async () => new Response('{"code":21211,"message":"Invalid \'To\' Number"}', { status: 400 })

    // ── A retryable failure hands the attempt back ──
    reset()
    const t500 = await withFetch(down, () => oneRun(mkItem()))
    check('outage', 'provider down: nothing sent', t500.sent, 0)
    check('outage', 'provider down: reported FAILED, not skipped (an outage is not a skip)', [t500.chased, t500.failed, t500.skipped], [1, 1, 0])
    check('outage', 'provider down: attempt REFUNDED', db.follow_up_count, 0)
    // The anchor is deliberately NOT refunded: it is the backoff that stops a broken
    // provider being hammered on every run. Only the budget comes back.
    check('outage', 'provider down: anchor NOT refunded (backoff survives)', db.last_followed_up_at !== null, true)
    check('outage', '➜ immediately after, backoff holds it (not due again this run)', dueForAutoFollowUp(mkItem() as unknown as Quote, P), false)

    // ── THE LEAK: three outage days must not retire the quote (max is 2) ──
    reset()
    for (let day = 1; day <= 3; day++) {
      const t = await withFetch(down, () => oneRun(mkItem()))
      check('outage', `outage day ${day}: failed, zero sent`, [t.sent, t.failed], [0, 1])
      db.last_followed_up_at = isoNDaysAgo(3) // a few days pass; the backoff elapses
    }
    check('outage', 'after 3 outages the budget is INTACT', db.follow_up_count, 0)
    check('outage', '➜ NOT exhausted (before the fix: retired at 2)', followUpsExhausted(mkItem() as unknown as Quote, P), false)
    check('outage', '➜ the quote is STILL DUE — the money is not lost', dueForAutoFollowUp(mkItem() as unknown as Quote, P), true)
    // …and once the provider recovers, it actually sends.
    const tOk = await withFetch(async () => new Response('{"sid":"SM1"}', { status: 200 }), () => oneRun(mkItem()))
    check('outage', '➜ provider recovers → it sends, on its FIRST attempt', [tOk.sent, tOk.failed, db.follow_up_count], [1, 0, 1])

    // ── A hard 4xx keeps the attempt spent ──
    reset()
    const t400 = await withFetch(rejects, () => oneRun(mkItem()))
    check('outage', 'hard 4xx: nothing sent', t400.sent, 0)
    check('outage', 'hard 4xx: attempt correctly SPENT (no refund)', db.follow_up_count, 1)
    check('outage', 'hard 4xx: reported as skipped, not failed', [t400.skipped, t400.failed], [1, 0])
    reset()
    for (let i = 0; i < 2; i++) { await withFetch(rejects, () => oneRun(mkItem())); db.last_followed_up_at = isoNDaysAgo(3) }
    check('outage', 'two hard 4xx → EXHAUSTED (a typo must not chase forever)', followUpsExhausted(mkItem() as unknown as Quote, P), true)
    check('outage', '➜ and the chaser stops', dueForAutoFollowUp(mkItem() as unknown as Quote, P), false)

    // ── A genuine skip is not a failure: the consent gate working is not an outage ──
    reset()
    const tSkip = await withFetch(down, () => oneRun(mkItem({ sms_opt_in: false, email_opt_in: false })))
    check('outage', 'opted out: no refund (the attempt is correctly spent)', db.follow_up_count, 1)
    check('outage', 'opted out: reported skipped, not failed', [tSkip.skipped, tSkip.failed], [1, 0])
    check('outage', 'opted out: never reached the provider', tSkip.sent, 0)

    // ── A throw refunds too: a render that dies has definitely sent nothing ──
    reset()
    const tThrow = await withFetch(down, () => oneRun(mkItem(), { throwOnRender: true }))
    check('outage', 'render throws: counted failed', [tThrow.failed, tThrow.sent], [1, 0])
    check('outage', 'render throws: attempt REFUNDED (zero sends must not cost one)', db.follow_up_count, 0)
    // The anchor still moved, deliberately — so it is NOT due again this instant.
    // That is the backoff, not a loss: once it elapses the quote is due again with
    // its budget intact, which is the whole distinction this fix rests on.
    check('outage', '➜ backoff holds it right now', dueForAutoFollowUp(mkItem() as unknown as Quote, P), false)
    db.last_followed_up_at = isoNDaysAgo(3)
    check('outage', '➜ backoff elapses → due again, budget intact', [dueForAutoFollowUp(mkItem() as unknown as Quote, P), db.follow_up_count], [true, 0])

    // ── A throw AFTER a send must NOT refund ──
    // The customer already has the message; handing the attempt back would chase
    // them twice for it. Modelled by the notification_log write blowing up on a run
    // where the provider accepted the SMS.
    {
      // Only the FIRST insert throws — that's logDispatch failing right after the
      // provider accepted the SMS. (The catch's own logSend must still work: an
      // insert that throws there escapes runChaseCron entirely, which is a real
      // pre-existing gap in the batch-isolation guarantee, but not this fix's.)
      let inserts = 0
      const sbBoom = { from: () => ({ ...table(), insert: async () => { if (++inserts === 1) throw new Error('notification_log unreachable'); return { error: null } } }) } as never
      reset()
      const tAfter = await withFetch(async () => new Response('{"sid":"SM1"}', { status: 200 }), () =>
        runChaseCron<OutageItem, { policy: typeof P }>(sbBoom, {
          items: [mkItem()], template: 'estimate_followup', errorLabel: 'follow-up failed',
          loadContext: async () => ({ policy: P }),
          enabled: () => true,
          due: q => dueForAutoFollowUp(q as unknown as Quote, P),
          claim: async q => {
            const seen = q.follow_up_count ?? 0
            if (db.follow_up_count !== seen) return false
            db.follow_up_count = seen + 1; db.last_followed_up_at = new Date().toISOString()
            return true
          },
          refund: async q => {
            const seen = q.follow_up_count ?? 0
            if (db.follow_up_count === seen + 1) db.follow_up_count = seen
          },
          render: async () => ({ smsText: 's', emailSubject: 'x', emailHtml: 'h', emailText: 't' }),
        }))
      check('outage', 'throw AFTER a send: attempt stays SPENT (no double-chase)', db.follow_up_count, 1)
      check('outage', '➜ still reported failed (the log write really did fail)', tAfter.failed, 1)
    }

    // ── The refund CAS cannot clobber a concurrent run ──
    // Another run has since re-claimed the row (count moved past what our claim
    // wrote). Our refund must match nothing rather than hand back an attempt someone
    // else is spending.
    reset()
    const stale = mkItem()          // snapshot at follow_up_count = 0
    db.follow_up_count = 7          // a concurrent writer moved it
    const tRace = await withFetch(down, () => oneRun(stale))
    check('outage', 'refund is a CAS: a lost race leaves the other run alone', db.follow_up_count, 7)
    check('outage', '➜ and the claim itself never landed', tRace.chased, 0)
  }

  // Leave the process exactly as we found it — later sections and any other caller
  // must not inherit fake credentials or a stubbed network.
  globalThis.fetch = realFetch
  for (const k of Object.keys(process.env)) if (!(k in ENV)) delete process.env[k]
  Object.assign(process.env, ENV)

  // ═══════════════════════════════════════════════════════════════════════════
  H('24. CADENCE — a pricing bucket is not a cadence')
  // /api/cron/signals composed cadenceDays(effectiveFreq(...), rec). effectiveFreq is
  // lossy BY DESIGN — it answers "which standard PRICE applies", not "how many days".
  // cadenceDays then matched the bucket on its first branch and never reached the
  // precise `rec` branch. These cases pin the difference so the composition cannot be
  // reintroduced in the sweep without going red.
  {
    // ── The `rec` branch is exact when the freq is raw ──
    const biMonthly: CadenceRecLike = { interval_unit: 'month', interval_count: 2 }
    const every3wk: CadenceRecLike = { interval_unit: 'week', interval_count: 3 }
    check('cadence', 'bi-monthly (every 2 months) → 60 days', cadenceDays(null, biMonthly), 60)
    check('cadence', 'every 3 weeks → 21 days', cadenceDays(null, every3wk), 21)
    check('cadence', 'every 10 days → 10 days', cadenceDays(null, { interval_unit: 'day', interval_count: 10 }), 10)

    // ── ...and the effectiveFreq composition destroys it. This is WHY the sweep
    //    must not use it. If these ever equal the true cadence above, effectiveFreq
    //    changed meaning and the sweep's comment needs revisiting.
    check('cadence', '➜ effectiveFreq buckets 2-monthly to "monthly"', effectiveFreq(null, 'month', 2), 'monthly')
    check('cadence', '➜ composed, 60d collapses to 30 (the bug)',
      cadenceDays(effectiveFreq(null, 'month', 2), biMonthly), 30)
    check('cadence', '➜ effectiveFreq buckets every-3-weeks to "biweekly"', effectiveFreq(null, 'week', 3), 'biweekly')
    check('cadence', '➜ composed, 21d collapses to 14 (the bug)',
      cadenceDays(effectiveFreq(null, 'week', 3), every3wk), 14)

    // ── Legacy standard cadences are UNAFFECTED by passing the raw freq: they hit
    //    the same first branches either way. This is what makes the sweep's fix safe.
    check('cadence', 'legacy freq="weekly" still 7', cadenceDays('weekly', { interval_unit: 'week', interval_count: 1 }), 7)
    check('cadence', 'legacy freq="biweekly" still 14', cadenceDays('biweekly', { interval_unit: 'week', interval_count: 2 }), 14)
    check('cadence', 'legacy freq="monthly" still 30', cadenceDays('monthly', { interval_unit: 'month', interval_count: 1 }), 30)
    check('cadence', 'no recurrence at all → the historical 14 fallback', cadenceDays(null, null), 14)

    // ── The sweep's EXACT expression, pinned ──
    const sweepCadence = (rec: { freq: string | null; interval_unit: string | null; interval_count: number | null } | null) =>
      cadenceDays(rec?.freq ?? null, rec)
    check('cadence', 'the sweep reads a bi-monthly series as 60d',
      sweepCadence({ freq: null, interval_unit: 'month', interval_count: 2 }), 60)
    check('cadence', 'the sweep still reads a legacy weekly series as 7d',
      sweepCadence({ freq: 'weekly', interval_unit: null, interval_count: null }), 7)

    // ── What the wrong cadence actually DID to the signal ──
    // Thresholds: ratio >= 1.25 → watch, >= 1.6 → high.
    const at = (days: number, cadence: number) =>
      churnRisk({ hasActiveRecurring: true, daysSinceLastService: days, cadenceDays: cadence, seasonallyDormant: false })
    // A bi-monthly customer 45 days out is EARLY (0.75 of their cadence).
    check('cadence', 'bi-monthly at 45d, TRUE cadence 60 → not at risk', at(45, 60).level, 'none')
    check('cadence', '➜ with the bucketed cadence 30 → false churn_risk (the bug)', at(45, 30).level, 'watch')
    check('cadence', '➜ and the ratio is double the truth', [at(45, 60).ratio, at(45, 30).ratio], [0.75, 1.5])
    // Every-3-weeks at 25 days is barely late (1.19); bucketed it reads as HIGH.
    check('cadence', 'every-3-weeks at 25d, TRUE cadence 21 → not at risk', at(25, 21).level, 'none')
    check('cadence', '➜ with the bucketed cadence 14 → false "high" (the bug)', at(25, 14).level, 'high')

    // ── ran-out's urgent window is sized by the same cadence, so it inherited it.
    //    max(RANOUT_URGENT_MIN_DAYS=21, cadence * 3).
    const urgentWindow = (cadence: number) => Math.max(21, cadence * 3)
    check('cadence', 'ran-out urgent window follows the TRUE bi-monthly cadence', urgentWindow(60), 180)
    check('cadence', '➜ the bucketed cadence shrank it to 90 (the bug)', urgentWindow(30), 90)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('25. AUDIT LOG — the fallback is for a missing COLUMN, not for any error')
  // The base-row fallback omits provider + provider_message_id, which is exactly what
  // lib/comms/delivery matches webhooks on — so a fallback row can never advance past
  // 'sent' and a bounced email reads "Sent" forever. That trade is only worth making
  // when the column genuinely isn't there. Firing on ANY error made a transient blip a
  // permanent downgrade, and turned a client-side timeout on a server-side SUCCESS into
  // a second, untrackable row for one send.
  // Only the notification_log table is faked here; the real logSend/logDispatch run.
  {
    type PgErr = null | { code?: string; message?: string }
    const realErr = console.error
    // Answers each insert with the next queued error, and records what was written.
    // console.error is captured so "did it complain?" is itself assertable.
    async function run1<T>(errors: PgErr[], fn: (sb: never) => Promise<T>) {
      const inserts: Record<string, unknown>[] = []
      let i = 0
      const sb = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserts.push(row); return { error: errors[i++] ?? null } } }) } as never
      let cries = 0
      console.error = () => { cries++ }
      try { return { r: await fn(sb), inserts, cries } } finally { console.error = realErr }
    }
    const ROW = { userId: 'u', customerId: 'c', channel: 'email', template: 'reminder', status: 'sent', provider: 'resend', providerId: 're_123' }
    const send = (errors: PgErr[]) => run1(errors, sb => logSend(sb, ROW))

    // ── Happy path is untouched: one row, provider id intact ──
    {
      const { r, inserts, cries } = await send([null])
      check('audit-log', 'clean insert → ok, one row, provider id intact',
        [r, inserts.length, inserts[0].provider_message_id, cries], [{ ok: true }, 1, 're_123', 0])
    }

    // ── The ONE case the fallback exists for ──
    for (const code of ['42703', 'PGRST204']) {
      const { r, inserts, cries } = await send([{ code, message: 'column does not exist' }])
      check('audit-log', `${code} (missing column) → fallback still saves the row`,
        [r, inserts.length], [{ ok: true }, 2])
      check('audit-log', `➜ ${code} fallback row is the untrackable base row (the known trade)`,
        ['provider' in inserts[1], 'provider_message_id' in inserts[1], cries], [false, false, 0])
    }

    // ── Every OTHER error must NOT fall back ──
    // A second insert here is the double-row bug: if the first insert succeeded
    // server-side and only the response was lost, the fallback wrote a SECOND row.
    for (const [code, label] of [['23505', 'constraint violation'], ['08006', 'transient connection blip'], ['42501', 'permission denied']]) {
      const { r, inserts, cries } = await send([{ code, message: label }])
      check('audit-log', `${code} (${label}) → NO untrackable fallback row`,
        [r, inserts.length], [{ ok: false }, 1])
      check('audit-log', `➜ ${code} is reported, never swallowed`, cries, 1)
    }
    // An error with no code at all is still not a missing column.
    {
      const { r, inserts } = await send([{ message: 'fetch failed' }])
      check('audit-log', 'code-less error → no fallback, reported as failed', [r, inserts.length], [{ ok: false }, 1])
    }

    // ── A failed audit write is no longer invisible (fix 3) ──
    // The base-only path (no provider/messageId) never had a fallback and never had a
    // return value: a message could send with NO audit row and the tally still read OK.
    {
      const { r, inserts, cries } = await run1([{ code: '08006', message: 'blip' }], sb =>
        logSend(sb, { userId: 'u', customerId: 'c', channel: 'sms', template: 'reminder', status: 'error', detail: 'boom' }))
      check('audit-log', 'base-only row: a lost audit write reports ok:false and says so',
        [r, inserts.length, cries], [{ ok: false }, 1, 1])
    }

    // ── logDispatch surfaces whether EVERY attempt was logged ──
    const att = (channel: string): DispatchAttempt =>
      ({ channel, status: 'sent', sent: true, detail: null, provider: 'x', providerId: 'p1', retryable: false }) as DispatchAttempt
    const res2: DispatchResult = { attempts: [att('sms'), att('email')], messageId: 'm1', sentChannels: ['sms', 'email'] }
    const ctx = { userId: 'u', customerId: 'c', template: 'reminder' }
    {
      const { r, inserts } = await run1([null, null], sb => logDispatch(sb, res2, ctx))
      check('audit-log', 'logDispatch: both attempts logged → ok', [r, inserts.length], [{ ok: true }, 2])
    }
    {
      // Second attempt's row is lost to a non-fallback error → the dispatch is only
      // partly audited, and logDispatch must say so rather than return void.
      const { r, cries } = await run1([null, { code: '23505', message: 'dupe' }], sb => logDispatch(sb, res2, ctx))
      check('audit-log', 'logDispatch: one attempt lost → ok:false, and reported', [r, cries], [{ ok: false }, 1])
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  H('26. THE ENGINE IMPORTS NO SENDER — the property, not the promise')
  // engine/route.ts opens with "IT CANNOT SEND. There is no dispatch import in this
  // file and no send path behind it." That is the engine's whole safety story before
  // the run log has been watched, and it was held up by nothing but a comment and the
  // reviewer's eyes. One `import` in any module behind it makes the comment false
  // while it goes on reading true — and lib/automation/chase.ts, which imports
  // dispatchToCustomer and logSend, is a sibling in the same directory. So walk the
  // real graph and assert the property instead of restating it.
  {
    const SRC = resolve(process.cwd(), 'src')
    const ENTRY = resolve(SRC, 'app/api/cron/engine/route.ts')
    const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }

    // Comments are stripped before anything is read for meaning: this very file's
    // prose names dispatchToCustomer, and route.ts's header says the word "dispatch"
    // in the sentence promising it never dispatches. A check that can't tell code from
    // commentary would fail on the comment that documents the property it's proving.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

    // `import type { X } from '...'` is ERASED at build — it is not a runtime edge and
    // must not count as one. This is not a technicality: types.ts legitimately does
    // `import type { MsgType } from '@/lib/comms/templates'`, so counting type edges
    // would report a sender in the closure today, on correct code, and the only way to
    // get green again would be to break the types. Strip the type-only forms first.
    const runtimeSource = (src: string) =>
      stripComments(src)
        .replace(/^\s*import\s+type\s[\s\S]*?from\s*['"][^'"]+['"]\s*;?/gm, '')
        .replace(/^\s*export\s+type\s[\s\S]*?from\s*['"][^'"]+['"]\s*;?/gm, '')

    // Resolve the way the bundler does: '@/' → src/, relative → sibling, bare → a
    // package, not ours to follow.
    const resolveSpec = (spec: string, fromFile: string): string | null => {
      let base: string
      if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2))
      else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
      else return null
      for (const c of [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
        if (isFile(c)) return c
      }
      return null
    }

    // The regexes are built PER CALL, deliberately. A module-level /g RegExp carries
    // `lastIndex` between .exec() calls, so the second file walked would resume
    // matching from wherever the first left off and silently skip the edges before it.
    // That failure is invisible: it under-reports, so the check goes green while
    // missing the import it exists to find. Exactly the shape of bug this section is
    // here to prevent, so it must not contain one.
    const edgesOf = (src: string): string[] => {
      const out: string[] = []
      for (const re of [
        /(?:^|[\s;])import\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,  // import x from '…'
        /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,                   // side-effect import
        /(?:^|[\s;])export\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g,  // re-export — a barrel
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                  // dynamic import()
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ]) { let m: RegExpExecArray | null; while ((m = re.exec(src))) out.push(m[1]) }
      return out
    }

    const walkFrom = (entry: string) => {
      const seen = new Map<string, string>()
      const visit = (file: string) => {
        if (seen.has(file)) return
        const src = runtimeSource(readFileSync(file, 'utf8'))
        seen.set(file, src)
        for (const spec of edgesOf(src)) { const t = resolveSpec(spec, file); if (t) visit(t) }
      }
      visit(entry)
      return seen
    }

    // A walk rooted at a path that doesn't exist finds nothing, and "nothing" is what
    // every assertion below wants to hear. Fail loudly rather than vacuously.
    check('no-sender', 'the entry point resolves (the walk is not vacuous)', isFile(ENTRY), true)

    const closure = walkFrom(ENTRY)
    const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/')
    const members = [...closure.keys()].map(rel).sort()

    // The closure, pinned exactly. This is the check that gives the rest their teeth:
    // a NEW module appearing here is a decision someone should look at, and a SHRINKING
    // list means the walk stopped seeing files rather than the graph getting smaller —
    // which is precisely how the assertions below would start passing for the wrong
    // reason. (types.ts is absent on purpose: nothing imports it except `import type`.)
    check('no-sender', 'the engine runtime closure is exactly these 5 modules', members, [
      'app/api/cron/engine/route.ts',
      'lib/automation/decide.ts',
      'lib/automation/rules.ts',
      'lib/cron/guard.ts',
      'lib/utils.ts',
    ])

    // No module in the closure IS a send path…
    const SEND_MODULES = ['lib/comms/send', 'lib/comms/dispatch', 'lib/comms/log', 'lib/automation/chase']
    check('no-sender', 'no send module is anywhere in the closure',
      members.filter(m => SEND_MODULES.some(s => m.startsWith(s))), [])

    // …and no module in it so much as names a sender. Catches the import this walk
    // can't follow — a re-export alias, a helper added later — one layer cheaper.
    for (const id of ['dispatchToCustomer', 'sendSms', 'sendEmail', 'logSend', 'logDispatch']) {
      check('no-sender', `no closure module mentions ${id}`,
        [...closure].filter(([, src]) => new RegExp(`\\b${id}\\b`).test(src)).map(([f]) => rel(f)), [])
    }

    // A barrel would hand the engine chase.ts's senders without one line of the engine
    // changing: `@/lib/automation` would import the directory, the directory would
    // import chase.ts, and chase.ts imports dispatchToCustomer. Nothing needs one —
    // every consumer imports its file directly — so the cheapest guard is that it does
    // not exist.
    check('no-sender', 'NO barrel at lib/automation/index.ts (it would import chase.ts senders)',
      isFile(resolve(SRC, 'lib/automation/index.ts')), false)

    // THE NEGATIVE CONTROL. Every assertion above has the form "the bad thing is not in
    // this set", which is also what a walker that resolves nothing reports. So walk
    // chase.ts — known to reach the senders, one directory away from the engine — and
    // require the walk to FIND them. If this goes red the walker is broken and the
    // green above means nothing.
    const chaseMembers = [...walkFrom(resolve(SRC, 'lib/automation/chase.ts')).keys()].map(rel)
    check('no-sender', '➜ control: the same walk DOES reach the send path from chase.ts',
      ['lib/comms/dispatch.ts', 'lib/comms/log.ts', 'lib/comms/send.ts'].filter(m => !chaseMembers.includes(m)), [])
    check('no-sender', '➜ control: and chase.ts really does name a sender',
      /\bdispatchToCustomer\b/.test(runtimeSource(readFileSync(resolve(SRC, 'lib/automation/chase.ts'), 'utf8'))), true)

    // ═══════════════════════════════════════════════════════════════════════════
    H("27. QUIET HOURS — an hour nobody knows is not an hour inside the window")
    // decide() takes `hour: number | 'unknown'` because the engine was passing
    // new Date().getHours() — UTC on Vercel — as if it were the owner's local hour.
    // With a fixed cron time that is the CONSTANT 11 for every owner on every run, and
    // 11 sits inside every rule's send window: the gate was not wrong by an offset, it
    // was incapable of ever suppressing. `quiet_hours` was an unreachable verdict, so
    // no amount of watching the run log could have surfaced it.
    check('decide', "hour 'unknown' → quiet_hours (fails CLOSED)",
      D({ hour: 'unknown' }), { fire: false, reason: 'quiet_hours' })
    // Everything else permissive — an auto rule, a real count of 0, nothing deduped,
    // room in the run. The unknown hour is the only thing standing between this rule
    // and a customer, and it must be enough on its own.
    check('decide', "'unknown' hour suppresses with everything else clear",
      D({ hour: 'unknown', recentActionsForSubject: 0, actionsThisRun: 0, alreadyDeduped: false }),
      { fire: false, reason: 'quiet_hours' })
    // It is a GATE, not an override: the more absolute reasons still outrank it, so the
    // run log keeps reporting the most useful one (same ordering as 'unknown' counts).
    check('decide', "'unknown' hour does not mask mode_off", D({ rule: { ...RULE, mode: 'off' }, hour: 'unknown' }), { fire: false, reason: 'mode_off' })
    check('decide', "'unknown' hour does not mask mode_suggest", D({ rule: { ...RULE, mode: 'suggest' }, hour: 'unknown' }), { fire: false, reason: 'mode_suggest' })
    check('decide', "'unknown' hour does not mask deduped", D({ hour: 'unknown', alreadyDeduped: true }), { fire: false, reason: 'deduped' })
    // …and it outranks the caps, which are checked after it.
    check('decide', "'unknown' hour outranks an unknown count", D({ hour: 'unknown', recentActionsForSubject: 'unknown' }), { fire: false, reason: 'quiet_hours' })
    // The numeric contract is untouched by the new value — a real hour still decides.
    check('decide', 'a real in-window hour is still the only thing that fires', D({ hour: 12 }), { fire: true })
    check('decide', '➜ and a real out-of-window hour still suppresses', D({ hour: 3 }), { fire: false, reason: 'quiet_hours' })

    // THE GAP THAT LET THIS BUG LIVE THROUGH REVIEW: every hour case in this harness —
    // old and new — hand-feeds decide() an hour and proves decide() handles it. Nothing
    // asserted what the CALLER passes, and the caller was the bug. decide() had no way
    // to distrust a well-formed 11. A gate is only as good as its input, so pin the
    // input: the engine must not synthesize an hour it cannot know. It can't — there is
    // no timezone column on business_settings — so `'unknown'` is the only honest thing
    // it can say, and saying it is what makes the gate above reachable at all.
    {
      const routeSrc = stripComments(readFileSync(ENTRY, 'utf8'))
      check('quiet-hours', 'the engine does not invent an hour (no getHours/getUTCHours)',
        /\bget(?:UTC)?Hours\s*\(/.test(routeSrc), false)
      check('quiet-hours', "➜ it passes hour: 'unknown' — the only hour it can honestly claim",
        /hour:\s*'unknown'/.test(routeSrc), true)
    }
  }

  // ── 29b. CHASEABILITY — "gone quiet" and "can be chased" are different ───────
  // The follow-up queue offered 9 quotes to chase; 6 of them ($445 on the live
  // book) belonged to customers with no phone and no email. Staleness is a time
  // rule and knows nothing about channels — so reachability is asked separately,
  // of the engine that already owns it, and must predict exactly what the sender
  // would do.
  H('29b. Chaseability — a quiet quote you cannot reach is not a to-do')
  {
    const reachable = { phone: '4035551234', email: null, sms_opt_in: true, email_opt_in: false }
    const noContact = { phone: null, email: null, sms_opt_in: true, email_opt_in: true }
    const optedOut = { phone: '4035551234', email: null, sms_opt_in: false, email_opt_in: false }
    const emailOnly = { phone: null, email: 'a@b.co', sms_opt_in: true, email_opt_in: true }

    // No contact at all, with the opt-in flags in BOTH states. reachCheck is
    // per-channel and would answer "no phone" for the first and "no opt-in" for the
    // second — the second is the dangerous one: it reads as "they refused" when the
    // record is merely empty. Both must report the one actionable truth.
    const noContactNoOptIn = { phone: null, email: null, sms_opt_in: false, email_opt_in: false }
    check('chase', 'a customer with a phone + SMS opt-in can be chased', canChaseCustomer(reachable), true)
    check('chase', '➜ no phone and no email cannot', canChaseCustomer(noContact), false)
    check('chase', '➜ ➜ and the reason is "no contact", not the first blocked channel', chaseBlockedReason(noContact), SKIP_REASON.NO_CONTACT)
    check('chase', '➜ ➜ same when the opt-ins are off — never "no opt-in" for someone nobody asked',
      chaseBlockedReason(noContactNoOptIn), SKIP_REASON.NO_CONTACT)
    // Opting out is a real answer and must NOT be relabelled as missing data.
    check('chase', '➜ a number they told us not to text cannot', canChaseCustomer(optedOut), false)
    check('chase', '➜ ➜ and that still reports "no opt-in" — they did refuse', chaseBlockedReason(optedOut), SKIP_REASON.NO_OPT_IN)
    check('chase', '➜ email alone is enough (the chaser tries both channels)', canChaseCustomer(emailOnly), true)
    check('chase', '➜ a reachable customer reports no blocking reason', chaseBlockedReason(reachable), null)
    // A missing customer row is not permission to assume a channel — the queue must
    // not promise a chase it has no evidence it can make.
    check('chase', '➜ a missing customer is not reachable', canChaseCustomer(null), false)
    check('chase', '➜ ➜ and reports "no contact" rather than nothing', chaseBlockedReason(undefined), SKIP_REASON.NO_CONTACT)
    // The block must read the same here as it does in the message thread and the
    // campaign audience — one vocabulary, not a fourth hand-written copy.
    check('chase', 'the block is labelled by THE shared describeSkip', describeSkip(chaseBlockedReason(noContact)).label, 'no phone or email on file')
    // The worst case used to be the only one with no way out.
    check('chase', '➜ and it offers the fix (it never used to)', describeSkip(chaseBlockedReason(noContact)).action, 'add_phone')
  }

  // ── 30. Timeline engine ─────────────────────────────────────────────────────
  // The customer history used to be ~60 lines inline in customers/[id], where it
  // could not be tested at all. It's now lib/timeline.ts — pure, so its decisions
  // are checkable without a database. These pin the ones that carry meaning.
  H('30. Timeline engine')
  {
    const base = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
    const at = (k: string, evs: TimelineEvent[]) => evs.find(e => e.kind === k)?.at
    const titleOf = (k: string, evs: TimelineEvent[]) => evs.find(e => e.kind === k)?.title

    // A job finished in March. Its notes get edited in July. updated_at moves;
    // completed_at doesn't. Reading updated_at claimed the job was done in July
    // and reordered the whole history around a typo fix.
    {
      const evs = buildTimeline({ jobs: [{ ...base, id: 'j1', title: 'Spring cleanup', scheduled_date: '2026-03-02', status: 'completed', completed_at: '2026-03-02T18:00:00Z', updated_at: '2026-07-14T09:00:00Z' }] })
      check('timeline', 'job completion reads completed_at, not updated_at', at('job_completed', evs), '2026-03-02T18:00:00Z')
      check('timeline', '➜ falls back to updated_at when completed_at is null (older rows)',
        at('job_completed', buildTimeline({ jobs: [{ ...base, id: 'j2', title: 'X', scheduled_date: '2026-03-02', status: 'completed', completed_at: null, updated_at: '2026-03-03T00:00:00Z' }] })), '2026-03-03T00:00:00Z')
      check('timeline', '➜ an unfinished job produces no completion event',
        buildTimeline({ jobs: [{ ...base, id: 'j3', title: 'X', scheduled_date: '2026-03-02', status: 'scheduled' }] }).some(e => e.kind === 'job_completed'), false)
    }
    // Same trap on the money side: editing a paid invoice's notes moved "paid" to today.
    {
      const evs = buildTimeline({ invoices: [{ ...base, id: 'i1', invoice_number: 'INV-1', amount: 100, status: 'paid', paid_at: '2026-02-10T12:00:00Z', updated_at: '2026-07-14T09:00:00Z' }] })
      check('timeline', 'invoice payment reads paid_at, not updated_at', at('invoice_paid', evs), '2026-02-10T12:00:00Z')
    }
    // The timeline must agree with the Invoices page and the portal, which are
    // GST-inclusive. amount is net; the multiplier is the ledger's.
    {
      const evs = buildTimeline({ gstPercent: 5, invoices: [{ ...base, id: 'i2', invoice_number: 'INV-2', amount: 100, status: 'paid', paid_at: base.created_at }] })
      check('timeline', 'invoice amounts are GST-inclusive', titleOf('invoice_created', evs) && evs.find(e => e.kind === 'invoice_created')?.sub, '$105.00')
      check('timeline', '➜ and 0% GST leaves the net amount alone',
        buildTimeline({ gstPercent: 0, invoices: [{ ...base, id: 'i3', invoice_number: 'INV-3', amount: 100, status: 'draft' }] }).find(e => e.kind === 'invoice_created')?.sub, '$100.00')
      check('timeline', '➜ a customer opening their invoice is an event', at('invoice_viewed', buildTimeline({ invoices: [{ ...base, id: 'i4', invoice_number: 'INV-4', amount: 10, status: 'sent', viewed_at: '2026-02-01T00:00:00Z' }] })), '2026-02-01T00:00:00Z')
    }
    // The ledger stores payments, credits and reversals in ONE table. They are not
    // all "Payment received" — that label on a refund is a lie to the owner.
    {
      const pay = (over: Partial<TlPayment>): TlPayment => ({ amount: 50, status: 'paid', kind: 'payment', method: 'stripe', notes: null, created_at: base.created_at, ...over })
      check('timeline', 'a payment is a payment', titleOf('payment', buildTimeline({ payments: [pay({})] })), 'Payment received')
      check('timeline', '➜ a negative payment is a refund', titleOf('refund', buildTimeline({ payments: [pay({ amount: -50 })] })), 'Refund · $50.00')
      check('timeline', '➜ a positive credit row is credit added', titleOf('credit', buildTimeline({ payments: [pay({ kind: 'credit' })] })), 'Credit added · $50.00')
      check('timeline', '➜ a negative credit row is credit applied', titleOf('credit', buildTimeline({ payments: [pay({ kind: 'credit', amount: -50 })] })), 'Credit applied · $50.00')
      check('timeline', '➜ an unpaid payment row is not history yet', buildTimeline({ payments: [pay({ status: 'pending' })] }).length, 0)
      check('timeline', '➜ refund/credit/payment are distinct kinds, not one icon',
        new Set(buildTimeline({ payments: [pay({}), pay({ amount: -1 }), pay({ kind: 'credit' })] }).map(e => e.kind)).size, 3)
    }
    // Internal notes were skipped entirely — the one place an owner writes down what
    // happened never appeared in what happened.
    {
      const msg = (direction: string): TlMessage => ({ direction, channel: 'sms', body: 'Gate code is 4432', created_at: base.created_at })
      check('timeline', 'an internal note is history', titleOf('note', buildTimeline({ messages: [msg('internal')] })), 'Internal note')
      check('timeline', '➜ inbound and outbound stay distinct', buildTimeline({ messages: [msg('inbound'), msg('outbound')] }).map(e => e.kind).sort(), ['message_in', 'message_out'])
    }
    // A lost sale left no trace: a declined quote simply stopped appearing.
    {
      const q = (status: string) => ({ ...base, id: 'q1', quote_number: 'Q-1', total: 200, status })
      check('timeline', 'a declined quote is recorded, not erased', titleOf('quote_declined', buildTimeline({ quotes: [q('declined')] })), 'Quote Q-1 declined')
      check('timeline', '➜ an accepted quote still reads as accepted', titleOf('quote_accepted', buildTimeline({ quotes: [q('accepted')] })), 'Quote Q-1 accepted')
      check('timeline', '➜ a draft quote is created but neither accepted nor declined',
        buildTimeline({ quotes: [q('draft')] }).map(e => e.kind), ['quote_created'])
    }
    // spent_at is when the money was spent; created_at is when it was typed in.
    check('timeline', 'an expense is dated when it was spent, not when it was entered',
      at('expense', buildTimeline({ expenses: [{ id: 'e1', amount: 40, description: 'Blades', spent_at: '2026-04-01', created_at: '2026-06-30T00:00:00Z' }] })), '2026-04-01')
    // A photo's taken_at is when the work looked like that.
    check('timeline', 'a photo is dated when it was taken, not uploaded',
      at('photo', buildTimeline({ photos: [{ id: 'p1', url: 'u', kind: 'before', taken_at: '2026-05-01T00:00:00Z', created_at: '2026-05-09T00:00:00Z' }] })), '2026-05-01T00:00:00Z')
    check('timeline', '➜ before/after photos are labelled by their kind',
      buildTimeline({ photos: [{ id: 'p2', url: 'u', kind: 'after', created_at: base.created_at }] })[0].title, 'After photo')
    check('timeline', '➜ a photo carries its image, so the row can show it',
      buildTimeline({ photos: [{ id: 'p3', url: 'https://x/y.jpg', created_at: base.created_at }] })[0].thumb, 'https://x/y.jpg')

    // Ordering is the whole point of a timeline.
    {
      const evs = buildTimeline({
        payments: [{ amount: 1, status: 'paid', kind: 'payment', method: null, notes: null, created_at: '2026-01-01T00:00:00Z' }],
        photos: [{ id: 'p4', url: 'u', created_at: '2026-06-01T00:00:00Z' }],
      })
      check('timeline', 'newest first, across sources', evs.map(e => e.kind), ['photo', 'payment'])
      // A row with a broken date must not claim to be the oldest thing that ever
      // happened — 1970 would pin it to the bottom of a newest-first list forever.
      const withBad = buildTimeline({ photos: [{ id: 'p5', url: 'u', created_at: 'not-a-date' }, { id: 'p6', url: 'u', created_at: '2026-06-01T00:00:00Z' }] })
      check('timeline', '➜ an unparseable date sinks instead of faking 1970', withBad[withBad.length - 1].at, 'not-a-date')
    }

    // Filters must never silently hide history.
    {
      const evs = buildTimeline({
        quotes: [{ ...base, id: 'q2', quote_number: 'Q-2', total: 10, status: 'draft' }],
        payments: [{ amount: 5, status: 'paid', kind: 'payment', method: null, notes: null, created_at: base.created_at }],
      })
      check('timeline', 'no filter set shows everything', filterTimeline(evs, new Set()).length, evs.length)
      check('timeline', '➜ a null filter shows everything', filterTimeline(evs, null).length, evs.length)
      check('timeline', '➜ a set filter narrows to that group', filterTimeline(evs, new Set(['money' as const])).map(e => e.kind), ['payment'])
      check('timeline', '➜ counts add up to the whole timeline',
        Object.values(timelineGroupCounts(evs)).reduce((a, b) => a + b, 0), evs.length)
      check('timeline', 'search matches the title', searchTimeline(evs, 'Q-2').map(e => e.kind), ['quote_created'])
      check('timeline', '➜ search matches the detail line too', searchTimeline(evs, '$5.00').map(e => e.kind), ['payment'])
      check('timeline', '➜ an empty search hides nothing', searchTimeline(evs, '   ').length, evs.length)
    }
    // The property view is the same engine, filtered — not a second query.
    {
      const evs = buildTimeline({
        jobs: [{ ...base, id: 'j4', title: 'Mow', scheduled_date: '2026-03-01', status: 'scheduled', property_id: 'prop-A' }],
        payments: [{ amount: 5, status: 'paid', kind: 'payment', method: null, notes: null, created_at: base.created_at }],
      })
      check('timeline', 'a property timeline keeps that property’s events', timelineForProperty(evs, 'prop-A').map(e => e.kind), ['job_scheduled'])
      // A payment isn't "at" an address — repeating it under every property the
      // customer owns would invent money that never happened there.
      check('timeline', '➜ customer-level events do not repeat under each property', timelineForProperty(evs, 'prop-B').length, 0)
    }
    // Expenses and price changes carry only a job_id, and a photo may carry one
    // instead of a property_id. The job knows the address, so these must reach the
    // property timeline — money spent at a property plainly happened there.
    {
      const jobAtA = { ...base, id: 'j5', title: 'Mow', scheduled_date: '2026-03-01', status: 'scheduled', property_id: 'prop-A' }
      const evs = buildTimeline({
        jobs: [jobAtA],
        expenses: [{ id: 'e1', description: 'Blades', amount: 40, spent_at: '2026-03-02', created_at: base.created_at, job_id: 'j5' }],
        priceChanges: [{ id: 'pc1', old_amount: 50, new_amount: 60, reason: 'bigger lawn', created_at: base.created_at, job_id: 'j5' }],
        photos: [{ id: 'ph1', url: 'u', created_at: base.created_at, job_id: 'j5' }],
      })
      const atA = timelineForProperty(evs, 'prop-A').map(e => e.kind).sort()
      check('timeline', 'a job-scoped expense reaches its job’s property', atA.includes('expense'), true)
      check('timeline', '➜ so does a price change', atA.includes('price_change'), true)
      check('timeline', '➜ and a photo with only a job_id', atA.includes('photo'), true)
      check('timeline', '➜ none of them leak to a different property', timelineForProperty(evs, 'prop-B').length, 0)
      // An expense whose job wasn't loaded (or has no address) must stay
      // customer-level rather than being pinned to an arbitrary property.
      const orphan = buildTimeline({
        expenses: [{ id: 'e2', description: 'Fuel', amount: 20, spent_at: '2026-03-02', created_at: base.created_at, job_id: 'j-unknown' }],
      })
      check('timeline', '➜ an expense with no known job stays customer-level', orphan[0].propertyId ?? null, null)
      // A job with no property_id must not hand its expenses a bogus address.
      const noProp = buildTimeline({
        jobs: [{ ...base, id: 'j6', title: 'Mow', scheduled_date: '2026-03-01', status: 'scheduled' }],
        expenses: [{ id: 'e3', description: 'Fuel', amount: 20, spent_at: '2026-03-02', created_at: base.created_at, job_id: 'j6' }],
      })
      check('timeline', '➜ a job without an address gives its expense none either',
        noProp.find(e => e.kind === 'expense')?.propertyId ?? null, null)
    }
    // ONE OPERATOR ACTION IS ONE EVENT. Booking a recurring plan writes the whole
    // series at once; a row-per-job timeline rendered that as 25 identical rows and
    // buried everything else the customer ever did.
    {
      // Weekly from 2026-07-11 — the exact shape of the real series that exposed this
      // (Peter Dunham: 25 jobs, one created_at, Jul 11 → Dec 26).
      const weeklyFrom = (i: number) => {
        const d = new Date('2026-07-11T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i * 7)
        return d.toISOString().slice(0, 10)
      }
      const series = (n: number) => Array.from({ length: n }, (_, i) => ({
        ...base, id: `s${i}`, title: 'Weekly Mowing', status: 'scheduled',
        scheduled_date: weeklyFrom(i),
        created_at: '2026-07-08T20:18:01.580Z', recurrence_id: 'rec-1', property_id: 'prop-A',
      }))
      const evs = buildTimeline({ jobs: series(25) })
      const sched = evs.filter(e => e.kind === 'job_scheduled')
      check('timeline', 'a booked series is ONE event, not one per visit', sched.length, 1)
      check('timeline', '➜ it says how many visits', sched[0].title, '25 visits scheduled — Weekly Mowing')
      check('timeline', '➜ and the span they cover', sched[0].sub, 'Jul 11, 2026 → Dec 26, 2026')
      check('timeline', '➜ dated when it was booked, not when the last visit lands', sched[0].at, '2026-07-08T20:18:01.580Z')
      check('timeline', '➜ and it opens the series', sched[0].href, '/dashboard/schedule?focus=rec-1')

      // A one-off job has no recurrence and must read exactly as it always did.
      const oneOff = buildTimeline({ jobs: [{ ...base, id: 'j9', title: 'Cleanup', scheduled_date: '2026-03-02', status: 'scheduled' }] })
      check('timeline', '➜ a one-off job is untouched', oneOff.find(e => e.kind === 'job_scheduled')?.title, 'Job scheduled — Cleanup')
      check('timeline', '➜ ➜ and keeps its "for <date>" line', oneOff.find(e => e.kind === 'job_scheduled')?.sub, 'for Mar 2, 2026')

      // A LATER top-up of the same series is a separate act — collapsing it into the
      // first booking would hide that the owner extended the plan.
      const topUp = buildTimeline({ jobs: [
        ...series(3),
        { ...base, id: 't1', title: 'Weekly Mowing', status: 'scheduled', scheduled_date: '2026-09-01', created_at: '2026-08-20T10:00:00.000Z', recurrence_id: 'rec-1', property_id: 'prop-A' },
      ] })
      check('timeline', '➜ a later top-up of the same series is its own event',
        topUp.filter(e => e.kind === 'job_scheduled').length, 2)

      // Completions are real, separate days — only the BOOKING is one act.
      const done = buildTimeline({ jobs: series(4).map((j, i) => i < 2
        ? { ...j, status: 'completed', completed_at: `2026-07-1${i + 1}T12:00:00.000Z` } : j) })
      check('timeline', '➜ completions are never collapsed', done.filter(e => e.kind === 'job_completed').length, 2)

      // A series split across two addresses must not collapse into one, or a
      // property timeline would claim visits at the wrong house.
      const split = buildTimeline({ jobs: [
        { ...base, id: 'a1', title: 'Mow', status: 'scheduled', scheduled_date: '2026-07-11', created_at: '2026-07-08T20:18:01.580Z', recurrence_id: 'rec-1', property_id: 'prop-A' },
        { ...base, id: 'b1', title: 'Mow', status: 'scheduled', scheduled_date: '2026-07-12', created_at: '2026-07-08T20:18:01.580Z', recurrence_id: 'rec-1', property_id: 'prop-B' },
      ] })
      check('timeline', '➜ a series across two properties stays two events', split.filter(e => e.kind === 'job_scheduled').length, 2)
      check('timeline', '➜ ➜ each scoped to its own address', timelineForProperty(split, 'prop-A').filter(e => e.kind === 'job_scheduled').length, 1)
    }
    // Every kind must belong to exactly one filter group, or a chip's count lies
    // and a filtered view drops events with no chip to bring them back.
    check('timeline', 'every event kind maps to a filter group',
      Object.keys(KIND_GROUP).every(k => TIMELINE_GROUPS.includes(KIND_GROUP[k as TimelineKind])), true)
  }

  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
  process.exit(fail ? 1 : 0)
}
run()
