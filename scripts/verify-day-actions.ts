// ── Verify: day-board customer actions open the right doors, and completion
//            says what it will send ───────────────────────────────────────────
//   npm run verify:day-actions
//
// WHY THIS SCRIPT EXISTS
// Session 80 gave the day board a customer-action system (Call / Message /
// Open customer / Request review) and split "the visit is complete" from "the
// customer was told the work is done". Three boundaries here are load-bearing
// and none of them fails tsc:
//
//   1. ⭐ An ESTIMATE-kind record must NEVER carry the Complete door. Completing
//      drafts an invoice and can text "your work is done" — firing that against
//      a sales appointment is the exact wrong-domain-model bug the estimate
//      lane exists to prevent. The rule lives in lib/dayActions and is asserted
//      here for every status, so whoever first renders estimates inherits a
//      closed door.
//   2. The completion dialog must appear exactly when a message WOULD go out —
//      predicted by THE reach predicate + the tenant grants, never a hand copy.
//      A plan that over-promises texts nobody but trains the owner to ignore
//      the dialog; one that under-promises reintroduces the silent text.
//   3. A review is asked ONCE — reviewed/declined hide the ask, a prior request
//      is named with its date, and a missing review link refuses rather than
//      sending a message with a hole in it.
//
// Mutations proven caught (scripts/mutate-day-actions.mjs, run by hand on a
// clean tree): estimate kind granted Complete → §1 red; DayOpsPanel Complete
// button ungated from doors → §3 red; completeJob no longer consults the plan
// → §3 red; clientMessageId dropped from a one-tap send → §3 red; 'reply'
// unregistered → §2 red.

import { dayDoors, completionMessagePlan, reviewAsk, type DayActionRecord } from '../src/lib/dayActions'
import { MSG_LABELS, msgCategory, DEFAULT_TEMPLATES } from '../src/lib/comms/templates'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

const CUSTOMER = {
  id: 'c1', phone: '403-555-0100', email: 'c@example.invalid',
  sms_opt_in: true, email_opt_in: true,
  reviewed_at: null, review_requested_at: null, review_declined_at: null,
}
const rec = (over: Partial<DayActionRecord> & { status: DayActionRecord['status'] }): DayActionRecord => ({
  kind: 'visit', customer: CUSTOMER, ...over,
})
const URL = 'https://g.page/x/review'

// ── 1. The doors, per record kind and status ─────────────────────────────────
console.log('\n═══ dayDoors — which actions make sense here ═══')

check('a scheduled visit can Complete, promise arrival, message and call',
  (() => {
    const d = dayDoors(rec({ status: 'scheduled' }), URL)
    return d.canComplete && d.canOnMyWay && d.canMessage && d.canCall && d.canOpenCustomer
  })())

check('an in-progress visit can Complete but no longer promises "on my way"',
  (() => {
    const d = dayDoors(rec({ status: 'in_progress' }), URL)
    return d.canComplete && !d.canOnMyWay
  })())

check('a completed visit closes Complete and On-my-way; the person doors stay open',
  (() => {
    const d = dayDoors(rec({ status: 'completed' }), URL)
    return !d.canComplete && !d.canOnMyWay && d.canMessage && d.canCall && d.canOpenCustomer
  })())

check('a cancelled visit closes Complete and On-my-way (nothing to finish, nothing to promise)',
  (() => {
    const d = dayDoors(rec({ status: 'cancelled' }), URL)
    return !d.canComplete && !d.canOnMyWay && d.canMessage
  })())

// ⭐ The Session-79/80 boundary. Every status, not just the plausible ones:
// whoever renders estimate appointments must inherit a Complete door that is
// closed BY KIND, not by which statuses they happen to use.
for (const status of ['scheduled', 'in_progress', 'completed', 'cancelled'] as const) {
  check(`an ESTIMATE record never carries Complete (status=${status})`,
    !dayDoors(rec({ kind: 'estimate', status }), URL).canComplete)
}
check('an estimate can still message/call — the person is real, the JOB is not. No on-my-way either: that door stamps jobs.on_my_way_at',
  (() => {
    const d = dayDoors(rec({ kind: 'estimate', status: 'scheduled' }), URL)
    return d.canMessage && d.canCall && !d.canOnMyWay
  })())

check('no customer → no Message, no Call, no customer door, no arrival promise',
  (() => {
    const d = dayDoors(rec({ status: 'scheduled', customer: null }), URL)
    return !d.canMessage && !d.canCall && !d.canOpenCustomer && !d.canOnMyWay && d.canComplete
  })())

check('no phone → Call closes, Message stays (email may still reach them)',
  (() => {
    const d = dayDoors(rec({ status: 'scheduled', customer: { ...CUSTOMER, phone: '  ' } }), URL)
    return !d.canCall && d.canMessage
  })())

// ── 1b. The review ladder ────────────────────────────────────────────────────
console.log('\n═══ reviewAsk — one neutral ask, once ═══')

check('completed + link + never asked → ready',
  reviewAsk(rec({ status: 'completed' }), URL).state === 'ready')
check('completed + NO link → no-url (never a message with a hole in it)',
  reviewAsk(rec({ status: 'completed' }), '').state === 'no-url')
check('already requested → already-requested, WITH the date',
  (() => {
    const a = reviewAsk(rec({ status: 'completed', customer: { ...CUSTOMER, review_requested_at: '2026-08-10T14:00:00Z' } }), URL)
    return a.state === 'already-requested' && a.requestedAt === '2026-08-10T14:00:00Z'
  })())
check('reviewed → reviewed (asking again is noise)',
  reviewAsk(rec({ status: 'completed', customer: { ...CUSTOMER, reviewed_at: '2026-08-01T00:00:00Z' } }), URL).state === 'reviewed')
check('declined → declined (an explicit no outranks a pending ask)',
  reviewAsk(rec({ status: 'completed', customer: { ...CUSTOMER, review_declined_at: '2026-08-01T00:00:00Z', review_requested_at: '2026-07-01T00:00:00Z' } }), URL).state === 'declined')
check('reviewed outranks requested (precedence mirrors lib/crm/reviews)',
  reviewAsk(rec({ status: 'completed', customer: { ...CUSTOMER, reviewed_at: '2026-08-02T00:00:00Z', review_requested_at: '2026-08-01T00:00:00Z' } }), URL).state === 'reviewed')
check('an unfinished visit is not-done — the day board asks after the work',
  reviewAsk(rec({ status: 'scheduled' }), URL).state === 'not-done')
check('a cancelled visit never asks', reviewAsk(rec({ status: 'cancelled' }), URL).state === 'not-done')

// ── 2. The completion-message plan ───────────────────────────────────────────
console.log('\n═══ completionMessagePlan — say it BEFORE sending it ═══')

const CAPS = { outboundSms: true, outboundEmail: true }
const done = (customer: DayActionRecord['customer']) => rec({ status: 'in_progress', customer })

check('automation off → nothing configured, no dialog',
  !completionMessagePlan(done(CUSTOMER), { automationOn: false, caps: CAPS }).wouldSend)
check('no customer → nothing configured',
  !completionMessagePlan(done(null), { automationOn: true, caps: CAPS }).configured)
check('opted in both ways → would send on sms + email',
  JSON.stringify(completionMessagePlan(done(CUSTOMER), { automationOn: true, caps: CAPS }).channels) === '["sms","email"]')
check('STOP state (sms opt-out) → email only; the dialog never promises a text',
  JSON.stringify(completionMessagePlan(done({ ...CUSTOMER, sms_opt_in: false }), { automationOn: true, caps: CAPS }).channels) === '["email"]')
check('email-only customer (no phone) → email only',
  JSON.stringify(completionMessagePlan(done({ ...CUSTOMER, phone: null }), { automationOn: true, caps: CAPS }).channels) === '["email"]')
check('no opt-in anywhere → configured but silent, with the consent reason',
  (() => {
    const p = completionMessagePlan(done({ ...CUSTOMER, sms_opt_in: false, email_opt_in: false }), { automationOn: true, caps: CAPS })
    return p.configured && !p.wouldSend && p.reason === 'no opt-in'
  })())
check('category opt-out (message_prefs.reminders=false) blocks the plan too',
  (() => {
    const p = completionMessagePlan(done({ ...CUSTOMER, message_prefs: { reminders: false } }), { automationOn: true, caps: CAPS })
    return !p.wouldSend && p.reason === 'customer unsubscribed'
  })())
check('a missing tenant grant closes that channel (the S58 over-promise bug, not repeated)',
  JSON.stringify(completionMessagePlan(done(CUSTOMER), { automationOn: true, caps: { outboundSms: false, outboundEmail: true } }).channels) === '["email"]')
check('no grants at all → silent, honestly worded',
  (() => {
    const p = completionMessagePlan(done(CUSTOMER), { automationOn: true, caps: { outboundSms: false, outboundEmail: false } })
    return !p.wouldSend && p.reason === 'messaging is not enabled for this business'
  })())
check('caps unknown (null) → predict the attempt; dispatch decides authoritatively',
  completionMessagePlan(done(CUSTOMER), { automationOn: true, caps: null }).wouldSend)
check('consent facts absent (stale cached row) → dialog still shows, hedged',
  (() => {
    const p = completionMessagePlan(done({ id: 'c1', phone: '403', email: null } as never), { automationOn: true, caps: CAPS })
    return p.wouldSend && !p.contactKnown
  })())

// ── 2b. 'reply' is a registered conversation, not an unknown commercial ──────
console.log('\n═══ the reply template — an owner answer is never "marketing" ═══')

check("'reply' is registered (an unknown template is governed as commercial)", 'reply' in MSG_LABELS)
check("msgCategory('reply') is null — a conversation, exactly like 'custom'", msgCategory('reply') === null)
check("'reply' has no rendered copy — its body is always the owner's typed text", DEFAULT_TEMPLATES.reply === '')

// ── 3. The wiring — the UI consults the module, not a private copy ───────────
console.log('\n═══ static pins — the doors are load-bearing, not decorative ═══')

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const panel = read('src/components/schedule/DayOpsPanel.tsx')
const page = read('src/app/dashboard/schedule/page.tsx')
const jm = read('src/components/schedule/JobMessages.tsx')

check('DayOpsPanel derives its doors from lib/dayActions',
  /dayDoors\(\{ kind: 'visit'/.test(panel), 'no dayDoors() call found')
check('both Complete buttons are gated by doors.canComplete',
  (panel.match(/doors\.canComplete/g) || []).length >= 2, 'fewer than 2 doors.canComplete gates')
check('the On-my-way doors ride doors.canOnMyWay',
  (panel.match(/doors\.canOnMyWay/g) || []).length >= 2)
check('Message affordances ride doors.canMessage',
  (panel.match(/doors\.canMessage/g) || []).length >= 3, 'button + menu twins should all consult the door')
check('the Call door dials the phone on file, gated by doors.canCall',
  /doors\.canCall \?/.test(panel) && /tel:\$\{job\.customers\?\.phone/.test(panel))
check('the Open-customer door exists and is gated',
  /doors\.canOpenCustomer \?/.test(panel) && /\/dashboard\/customers\/\$\{job\.customer_id\}/.test(panel))
check('the Review door opens THE message composer preselected — no second review pipeline',
  /openReviewAsk/.test(panel) && /setMessageInitial\('review_request'\)/.test(panel))
check('an already-asked review renders the fact, with its date',
  /already-requested/.test(panel) && /doors\.review\.requestedAt/.test(panel))

check('completeJob consults the plan BEFORE any state change',
  /completionMessagePlan\(\r?\n?\s*\{ kind: 'visit'/.test(page), 'completeJob no longer predicts the message')
check('the dialog decision (not a re-derivation) is what performComplete sends',
  /performComplete\(completeAsk\.job, send/.test(page))
check('the job_complete fetch lives only in performComplete and carries the idempotency id',
  (page.match(/template: 'job_complete'/g) || []).length === 1
  && /template: 'job_complete', jobId: job\.id, dedupe: true,\r?\n\s*clientMessageId: newClientMessageId\(\)/.test(page),
  'expected exactly one job_complete send site, with clientMessageId')
check('cancelling the dialog completes nothing (no performComplete on cancel path)',
  /onCancel=\{\(\) => \{ if \(!completeBusy\) setCompleteAsk\(null\) \}\}/.test(page))
check('the day query joins consent + review columns for the plan and the Review door',
  /customers\(id, name, phone, email,[^)]*sms_opt_in, email_opt_in, message_prefs, reviewed_at, review_requested_at, review_declined_at\)/.test(page))
check('the jobs read stays tenant-scoped beside its select (per-read, not file-wide)',
  /customers\(id, name, phone, email,[\s\S]{0,400}?\.eq\('user_id', userId\)/.test(page))

check('JobMessages one-tap send carries a clientMessageId',
  /clientMessageId: newClientMessageId\(\)/.test(jm))
check('DayOpsPanel one-tap On-my-way carries a clientMessageId',
  /template: 'on_my_way', jobId: job\.id,\r?\n\s*channels: \['sms', 'email'\],[\s\S]{0,200}?clientMessageId: newClientMessageId\(\)/.test(panel))
check('a reviewed OR declined customer hides the review ask in the composer',
  /review\.reviewedAt \|\| review\.declinedAt/.test(jm))
check('a prior request is named in the composer before a re-ask',
  /review\.requestedAt/.test(jm) && /already went out/.test(jm))

// No second sender: the day-board surfaces must reach customers only through
// /api/comms/send (the governed door), never the provider transport directly.
for (const [name, src] of [['DayOpsPanel', panel], ['JobMessages', jm], ['schedule page', page]] as const) {
  check(`${name} never imports the provider transport (lib/comms/send)`,
    !/from '[^']*\/comms\/send'/.test(src))
}

const dlg = read('src/components/schedule/CompleteConfirm.tsx')
check('the completion dialog is the shared Modal (bottom sheet on phones), shows the text, and offers both completions',
  /from '@\/components\/ui\/Modal'/.test(dlg) && /Complete without sending/.test(dlg) && /Complete &amp; send/.test(dlg) && /textarea/.test(dlg))
check('the dialog names the configured automation instead of surprising the owner',
  /Settings → Automations/.test(dlg))

// ── summary ──────────────────────────────────────────────────────────────────
console.log(failures ? `\n✗ verify:day-actions — ${failures} failure(s)` : '\n✓ verify:day-actions — all checks passed')
process.exit(failures ? 1 : 0)
