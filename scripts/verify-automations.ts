/* eslint-disable no-console */
// End-to-end verification of the two automatic chasers' DECISION logic.
// Imports the real production functions — nothing is reimplemented here.
import { dueForAutoFollowUp, needsFollowUp, quoteIsQuiet, resolveFollowUpPolicy, followUpsExhausted, FOLLOW_UP_DAYS, FOLLOW_UP_MAX } from '@/lib/followup'
import { dueForAutoReminder, resolveReminderPolicy, remindersExhausted, reminderAnchor, REMINDER_DELAY_DAYS, REMINDER_MAX } from '@/lib/payments/dunning'
import { displayInvoiceStatus, invoiceBalance } from '@/lib/payments/ledger'
import { resolveAutomations } from '@/lib/comms/automations'
import { displayQuoteStatus, isQuoteExpired, isExpiringSoon, daysUntilExpiry, defaultValidUntil } from '@/lib/quoteStatus'
import { prefAllows, msgCategory } from '@/lib/comms/templates'
import { dispatchToCustomer, sendResultsFromAttempts, type DispatchAttempt, type DispatchResult } from '@/lib/comms/dispatch'
import { logSend, logDispatch } from '@/lib/comms/log'
import { sendSms, sendEmail } from '@/lib/comms/send'
import { runChaseCron, type ChaseItem, type ChaseTally } from '@/lib/automation/chase'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import { cadenceDays, churnRisk, type CadenceRecLike } from '@/lib/signals'
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
  H('18. LEGACY RESULTS MAP — /api/comms/send speaks SendResult, dispatch speaks attempts')
  // The route shares the dispatch gate but must keep answering in its OWN
  // vocabulary — nine callers read `results`. These pin the translation, including
  // the absent keys: a skip has never carried `error`/`id`, and JSON.stringify
  // would leak `"error":null` to every caller if it did.
  const asAttempt = (o: Partial<DispatchAttempt>): DispatchAttempt =>
    // `retryable: false` mirrors dispatch's own skip default — a skip is a decision,
    // not a failure, so there is nothing to retry.
    ({ channel: 'sms', status: 'skipped', detail: null, sent: false, provider: null, providerId: null, retryable: false, ...o })

  check('results-map', 'opted-out sms → no-optin', sendResultsFromAttempts([asAttempt({ detail: SKIP_REASON.NO_OPT_IN })]), { sms: { sent: false, reason: 'no-optin' } })
  check('results-map', 'missing phone → no-phone', sendResultsFromAttempts([asAttempt({ detail: SKIP_REASON.NO_PHONE })]), { sms: { sent: false, reason: 'no-phone' } })
  check('results-map', 'opted-out email → no-optin', sendResultsFromAttempts([asAttempt({ channel: 'email', detail: SKIP_REASON.NO_OPT_IN })]), { email: { sent: false, reason: 'no-optin' } })
  check('results-map', 'missing email → no-email', sendResultsFromAttempts([asAttempt({ channel: 'email', detail: SKIP_REASON.NO_EMAIL })]), { email: { sent: false, reason: 'no-email' } })
  // A declined CATEGORY has always read as 'no-optin' to callers, not 'unsubscribed'.
  check('results-map', 'unsubscribed category → no-optin (not a new word)', sendResultsFromAttempts([asAttempt({ detail: SKIP_REASON.UNSUBSCRIBED })]), { sms: { sent: false, reason: 'no-optin' } })

  // A real send returns the provider's raw SendResult: reason 'sent' + its id, no `error` key.
  check('results-map', 'sent → raw SendResult w/ provider id', sendResultsFromAttempts([asAttempt({ status: 'sent', sent: true, provider: 'twilio', providerId: 'SM123' })]), { sms: { sent: true, reason: 'sent', id: 'SM123' } })
  // A provider error keeps reason:'error' and its detail, and gains no `id` key.
  check('results-map', 'provider error → reason=error + error detail', sendResultsFromAttempts([asAttempt({ channel: 'email', status: 'error', detail: 'Resend 422: bad address' })]), { email: { sent: false, reason: 'error', error: 'Resend 422: bad address' } })
  // Credentials absent — the send layer's no-op result must survive the round trip.
  check('results-map', 'disabled provider → reason=disabled', sendResultsFromAttempts([asAttempt({ status: 'disabled' })]), { sms: { sent: false, reason: 'disabled' } })
  // Multi-channel: sms-before-email order is preserved into the map.
  check('results-map', 'both channels keep sms-first key order', Object.keys(sendResultsFromAttempts([asAttempt({ status: 'sent', sent: true, providerId: 'SM1' }), asAttempt({ channel: 'email', detail: SKIP_REASON.NO_EMAIL })])), ['sms', 'email'])

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
  H('23. LEGACY MAP — `retryable` is internal and must not leak to the nine callers')
  // sendResultsFromAttempts is a published contract. The new field lives on the
  // attempt for the chase loop only; if it ever appears in this map it changes the
  // response bytes for every caller of /api/comms/send.
  check('results-map', 'retryable does not leak (provider error)',
    sendResultsFromAttempts([asAttempt({ status: 'error', detail: 'Twilio 500', retryable: true })]),
    { sms: { sent: false, reason: 'error', error: 'Twilio 500' } })
  check('results-map', 'retryable does not leak (sent)',
    sendResultsFromAttempts([asAttempt({ status: 'sent', sent: true, provider: 'twilio', providerId: 'SM1', retryable: false })]),
    { sms: { sent: true, reason: 'sent', id: 'SM1' } })
  check('results-map', 'retryable does not leak (skip)',
    sendResultsFromAttempts([asAttempt({ detail: SKIP_REASON.NO_OPT_IN, retryable: false })]),
    { sms: { sent: false, reason: 'no-optin' } })
  // Belt and braces: no legacy value carries the key at all, whatever the attempt said.
  check('results-map', 'no `retryable` key on ANY legacy value',
    Object.values(sendResultsFromAttempts([
      asAttempt({ status: 'error', detail: 'Twilio 500', retryable: true }),
      asAttempt({ channel: 'email', detail: SKIP_REASON.NO_EMAIL }),
    ])).some(v => 'retryable' in v), false)
  // The exact case from section 18, re-asserted with retryable set: byte-identical.
  check('results-map', 'section-18 output is UNCHANGED by the new field',
    sendResultsFromAttempts([asAttempt({ channel: 'email', status: 'error', detail: 'Resend 422: bad address', retryable: false })]),
    { email: { sent: false, reason: 'error', error: 'Resend 422: bad address' } })

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

  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
  process.exit(fail ? 1 : 0)
}
run()
