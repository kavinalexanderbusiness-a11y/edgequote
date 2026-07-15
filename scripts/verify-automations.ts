/* eslint-disable no-console */
// End-to-end verification of the two automatic chasers' DECISION logic.
// Imports the real production functions — nothing is reimplemented here.
import { dueForAutoFollowUp, needsFollowUp, quoteIsQuiet, resolveFollowUpPolicy, followUpsExhausted, FOLLOW_UP_DAYS, FOLLOW_UP_MAX } from '@/lib/followup'
import { dueForAutoReminder, resolveReminderPolicy, remindersExhausted, reminderAnchor, REMINDER_DELAY_DAYS, REMINDER_MAX } from '@/lib/payments/dunning'
import { displayInvoiceStatus, invoiceBalance } from '@/lib/payments/ledger'
import { resolveAutomations } from '@/lib/comms/automations'
import { displayQuoteStatus, isQuoteExpired, isExpiringSoon, daysUntilExpiry, defaultValidUntil } from '@/lib/quoteStatus'
import { prefAllows, msgCategory } from '@/lib/comms/templates'
import { dispatchToCustomer, sendResultsFromAttempts, type DispatchAttempt } from '@/lib/comms/dispatch'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import type { Quote } from '@/types'
import type { FeeSettings } from '@/lib/invoiceTotals'

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
    ({ channel: 'sms', status: 'skipped', detail: null, sent: false, provider: null, providerId: null, ...o })

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

  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fails.length) { console.log('\n  FAILURES:'); fails.forEach(f => console.log('   • ' + f)) }
  process.exit(fail ? 1 : 0)
}
run()
