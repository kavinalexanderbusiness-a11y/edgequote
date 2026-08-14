// ── Customer communication preferences — npm run verify:comm-prefs ───────────
//
// The whole feature rests on ONE claim: a preference orders the channels consent
// already allowed, and can never grant, revoke or reorder its way past consent,
// a STOP, or a platform capability. That claim is only worth what it can be
// shown to survive, so every way of breaking it is attempted here.
//
// resolveReach is pure, so the rules are pinned without a database (the
// verify-comms-governor / verify-automations pattern). The last section reads
// the real source files, because a pure harness can pin every rule and still
// miss the only failure that matters: nobody calling them.

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  resolveReach, reachSummary, orderByPreference, capabilityBlocks, reachCheck,
  isReachable, blockedReason, SENDABLE_CHANNELS, ANY_MESSAGE,
  type ReachCustomer, type PreferredChannel, type ReachCapabilities,
} from '../src/lib/comms/reach'
import { SKIP_REASON } from '../src/lib/comms/skipReasons'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// A fully reachable customer: both channels on file, both consents given.
const OPEN: ReachCustomer = {
  phone: '+15875550100', email: 'a@example.com',
  sms_opt_in: true, email_opt_in: true, message_prefs: null, preferred_channel: null,
}
const who = (over: Partial<ReachCustomer>): ReachCustomer => ({ ...OPEN, ...over })
const ALL_CAPS: ReachCapabilities = { outboundSms: true, outboundEmail: true }

// ═══════════════════════════════════════════════════════════════════════════
H('1. MISSING PREFERENCE STILL WORKS — the state all 108 live customers are in')
check('no preference → state "none"', resolveReach(OPEN, { caps: ALL_CAPS }).state, 'none')
check('no preference → still reachable on the natural first channel',
  resolveReach(OPEN, { caps: ALL_CAPS }).best, 'sms')
check('undefined preferred_channel behaves exactly like null',
  resolveReach(who({ preferred_channel: undefined }), { caps: ALL_CAPS }),
  resolveReach(who({ preferred_channel: null }), { caps: ALL_CAPS }))
check('a customer object with NO preferred_channel key at all resolves',
  resolveReach({ phone: '+1', email: 'a@b.c', sms_opt_in: true, email_opt_in: true }, { caps: ALL_CAPS }).best, 'sms')
check('summary reads honestly with no preference',
  reachSummary(resolveReach(OPEN, { caps: ALL_CAPS })), 'No preference recorded — messages go by text.')
// The legacy predicates must be untouched for a customer with no preference —
// this is the whole book today, and a regression here breaks every send path.
check('reachCheck unchanged for a preference-less customer',
  reachCheck(OPEN, ['sms', 'email'], 'reminder'),
  [{ channel: 'sms', blocked: null }, { channel: 'email', blocked: null }])

// ═══════════════════════════════════════════════════════════════════════════
H('2. ⭐ PREFERENCE NEVER FABRICATES CONSENT — the headline claim')
// Preferred = SMS, SMS consent = false. EdgeQuote must NOT text.
const wantsSmsNoConsent = who({ preferred_channel: 'sms', sms_opt_in: false })
const v2 = resolveReach(wantsSmsNoConsent, { caps: ALL_CAPS })
check('preferred SMS + sms_opt_in false → SMS is BLOCKED',
  v2.channels.find(c => c.channel === 'sms')!.blocked, SKIP_REASON.NO_OPT_IN)
check('preferred SMS + sms_opt_in false → best channel is NOT sms', v2.best, 'email')
check('…and the state says so out loud', v2.state, 'overruled')
check('…naming the consent rule that overruled it', v2.preferredBlockedBy, SKIP_REASON.NO_OPT_IN)
check('…in one honest owner sentence', reachSummary(v2),
  'Prefers text, but no opt-in — messages go by email instead.')
// The exact example from the brief, with the OTHER channel also unavailable:
// there is then no reachable channel, and it must say that rather than fall back
// to the preferred one.
const noChannelAtAll = who({ preferred_channel: 'sms', sms_opt_in: false, email_opt_in: false })
check('preferred SMS, no SMS consent, no email consent → nothing sends',
  resolveReach(noChannelAtAll, { caps: ALL_CAPS }).best, null)
check('…and explains rather than pretends',
  reachSummary(resolveReach(noChannelAtAll, { caps: ALL_CAPS })),
  'No way to reach this customer — no opt-in.')
// Preference must not resurrect a channel with no contact on file either.
check('preferred email with no email address → not chosen',
  resolveReach(who({ preferred_channel: 'email', email: null }), { caps: ALL_CAPS }).best, 'sms')
check('…reported as the contact gap, not as a consent problem',
  resolveReach(who({ preferred_channel: 'email', email: null }), { caps: ALL_CAPS }).preferredBlockedBy,
  SKIP_REASON.NO_EMAIL)

// ═══════════════════════════════════════════════════════════════════════════
H('3. ⭐ STOP ALWAYS WINS — an inbound STOP sets sms_opt_in false')
// /api/sms/inbound flips customers.sms_opt_in to false on STOP. Whatever the
// preference says, that flag is what the pipeline reads — proven for every
// preference value, so no preference can be the one that slips past.
for (const p of ['sms', 'email', 'phone', null] as (PreferredChannel | null)[]) {
  const stopped = who({ preferred_channel: p, sms_opt_in: false })
  const v = resolveReach(stopped, { caps: ALL_CAPS })
  check(`after STOP, preference=${p ?? 'none'} → SMS blocked`,
    v.channels.find(c => c.channel === 'sms')!.blocked, SKIP_REASON.NO_OPT_IN)
  check(`after STOP, preference=${p ?? 'none'} → best is never sms`, v.best === 'sms', false)
}
// STOP on a customer who ONLY has a phone: no fallback exists, and preference
// must not invent one.
const stopPhoneOnly = who({ preferred_channel: 'sms', sms_opt_in: false, email: null, email_opt_in: false })
check('STOP + phone-only customer → unreachable, no fallback invented',
  resolveReach(stopPhoneOnly, { caps: ALL_CAPS }).best, null)
check('isReachable agrees (the predicate every send path shares)',
  isReachable(stopPhoneOnly, ['sms', 'email'], 'reminder'), false)

// ═══════════════════════════════════════════════════════════════════════════
H('4. ⭐ CAPABILITY DISABLED ALWAYS WINS — a platform grant, not a customer choice')
const NO_SMS: ReachCapabilities = { outboundSms: false, outboundEmail: true }
const NO_EMAIL: ReachCapabilities = { outboundSms: true, outboundEmail: false }
const NOTHING: ReachCapabilities = { outboundSms: false, outboundEmail: false }
check('capabilityBlocks: sms blocked when the tenant has no outbound SMS grant',
  capabilityBlocks('sms', NO_SMS), true)
check('capabilityBlocks: email unaffected by the SMS grant', capabilityBlocks('email', NO_SMS), false)
check('capabilityBlocks: unknown caps leave the channel alone (dispatch reads it authoritatively)',
  capabilityBlocks('sms', undefined), false)
check('capabilityBlocks: a channel this pipeline never sends is never capability-blocked',
  capabilityBlocks('push', NOTHING), false)

const wantsSmsNoGrant = who({ preferred_channel: 'sms' })
const v4 = resolveReach(wantsSmsNoGrant, { caps: NO_SMS })
check('preferred SMS + tenant has no SMS grant → SMS blocked as NOT_ENABLED',
  v4.channels.find(c => c.channel === 'sms')!.blocked, SKIP_REASON.NOT_ENABLED)
check('…falls back to the granted channel', v4.best, 'email')
check('…and says which one it used', reachSummary(v4),
  'Prefers text, but channel not enabled — messages go by email instead.')
check('no grants at all → nothing sends, whatever the preference',
  resolveReach(who({ preferred_channel: 'email' }), { caps: NOTHING }).best, null)
check('no grants at all → a fully-consented customer is still unreachable',
  resolveReach(OPEN, { caps: NOTHING }).best, null)
check('preferred email + no email grant → falls back to sms',
  resolveReach(who({ preferred_channel: 'email' }), { caps: NO_EMAIL }).best, 'sms')

// Consent is reported BEFORE capability when both apply — the owner-actionable
// truth. This is also the exact order dispatchToCustomer reaches, where the
// capability pass only touches channels consent left unblocked.
check('consent outranks capability in the REASON reported',
  resolveReach(who({ sms_opt_in: false }), { caps: NOTHING }).channels.find(c => c.channel === 'sms')!.blocked,
  SKIP_REASON.NO_OPT_IN)

// ═══════════════════════════════════════════════════════════════════════════
H('5. PREFERENCE ORDERS, IT NEVER ADDS OR REMOVES')
// The structural invariant: ordering is a PERMUTATION. If this holds, a
// preference cannot delete a channel (a hidden opt-out) or conjure one.
const CASES: (PreferredChannel | null)[] = ['sms', 'email', 'phone', null]
for (const p of CASES) {
  const ordered = orderByPreference(['sms', 'email'], p)
  check(`order by ${p ?? 'none'} is a permutation (same members)`,
    [...ordered].sort(), ['email', 'sms'])
  check(`order by ${p ?? 'none'} keeps the length`, ordered.length, 2)
}
check('preferred sms comes first', orderByPreference(['sms', 'email'], 'sms'), ['sms', 'email'])
check('preferred email comes first', orderByPreference(['sms', 'email'], 'email'), ['email', 'sms'])
check('preferring a phone CALL reorders nothing — we place no calls',
  orderByPreference(['sms', 'email'], 'phone'), ['sms', 'email'])
check('a preference for a channel not on offer changes nothing',
  orderByPreference(['email'], 'sms'), ['email'])
// The verdict set must match regardless of preference — same channels, same
// blocked reasons; only the ORDER and the narration differ.
const sortByCh = (v: ReturnType<typeof resolveReach>) =>
  [...v.channels].sort((a, b) => a.channel.localeCompare(b.channel))
for (const p of CASES) {
  check(`verdicts identical under preference=${p ?? 'none'}`,
    sortByCh(resolveReach(who({ preferred_channel: p, sms_opt_in: false }), { caps: ALL_CAPS })),
    sortByCh(resolveReach(who({ preferred_channel: null, sms_opt_in: false }), { caps: ALL_CAPS })))
  check(`reachability identical under preference=${p ?? 'none'}`,
    isReachable(who({ preferred_channel: p, sms_opt_in: false }), ['sms', 'email'], 'reminder'),
    isReachable(who({ preferred_channel: null, sms_opt_in: false }), ['sms', 'email'], 'reminder'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('6. "CALL ME" IS AN INSTRUCTION TO THE OWNER, NOT A CHANNEL')
const caller = who({ preferred_channel: 'phone' })
check('prefers a call → state "manual"', resolveReach(caller, { caps: ALL_CAPS }).state, 'manual')
check('…automatic messages still follow consent as normal',
  resolveReach(caller, { caps: ALL_CAPS }).best, 'sms')
check('…and the owner is told to ring them', reachSummary(resolveReach(caller, { caps: ALL_CAPS })),
  'Prefers a phone call — give them a ring. Messages still go by text.')
check('prefers a call but nothing can send → says both truths',
  reachSummary(resolveReach(who({ preferred_channel: 'phone', sms_opt_in: false, email_opt_in: false }), { caps: ALL_CAPS })),
  'Prefers a phone call — and no message channel is available (no opt-in).')
check('"phone" is never treated as a sendable channel', SENDABLE_CHANNELS.includes('phone'), false)

// ═══════════════════════════════════════════════════════════════════════════
H('7. THE CATEGORY OPT-OUT STILL OUTRANKS EVERYTHING')
// message_prefs is the customer declining a KIND of message. Preference must not
// reopen it — the highest gate in the stack.
const noMarketing = who({ preferred_channel: 'sms', message_prefs: { marketing: false } })
check('declined marketing + prefers SMS → marketing still blocked',
  resolveReach(noMarketing, { channels: ['sms', 'email'], template: 'marketing', caps: ALL_CAPS }).best, null)
check('…reported as unsubscribed',
  resolveReach(noMarketing, { channels: ['sms', 'email'], template: 'marketing', caps: ALL_CAPS }).blocked,
  SKIP_REASON.UNSUBSCRIBED)
check('…while a service message to the same customer still goes',
  resolveReach(noMarketing, { channels: ['sms', 'email'], template: 'reminder', caps: ALL_CAPS }).best, 'sms')
check('ANY_MESSAGE asks the channel-level question only (no category applied)',
  resolveReach(noMarketing, { template: ANY_MESSAGE, caps: ALL_CAPS }).best, 'sms')

// ═══════════════════════════════════════════════════════════════════════════
H('8. BLOCKED-REASON REPORTING FOLLOWS THE PREFERENCE, THE VERDICT NEVER DOES')
const bothBlocked = who({ sms_opt_in: false, email: null })
check('no preference → reports the first natural channel\'s reason',
  blockedReason(bothBlocked, ['sms', 'email'], 'reminder'), SKIP_REASON.NO_OPT_IN)
check('prefers email → reports the EMAIL reason instead (the one they\'d fix)',
  blockedReason(who({ ...bothBlocked, preferred_channel: 'email' }), ['sms', 'email'], 'reminder'),
  SKIP_REASON.NO_EMAIL)
check('a reachable customer reports NO reason whatever the preference',
  blockedReason(who({ preferred_channel: 'email' }), ['sms', 'email'], 'reminder'), null)

// ═══════════════════════════════════════════════════════════════════════════
H('9. THE SEAM IS WIRED — one primitive, and the send path is capability-gated')
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8')

const dispatchSrc = read('lib', 'comms', 'dispatch.ts')
check('dispatch consults the ONE reach predicate', /reachCheck\s*\(/.test(dispatchSrc), true)
check('dispatch consults the ONE capability rule', /capabilityBlocks\s*\(/.test(dispatchSrc), true)
check('dispatch still reads capabilities from the platform table itself',
  /tenantCapabilities\s*\(/.test(dispatchSrc), true)
// The rule must not be re-implemented inline anywhere — that is how the two
// answers drift apart, and it is precisely what this session removed.
check('no hand-rolled outboundSms check survives in dispatch',
  /!\s*caps\.outboundSms/.test(dispatchSrc), false)

const reachSrc = read('lib', 'comms', 'reach.ts')
check('preference cannot write a blocked verdict (no SKIP_REASON in the ordering fn)',
  /export function orderByPreference[\s\S]*?\n}/.exec(reachSrc)![0].includes('SKIP_REASON'), false)

// The owner UI must consume the primitive, never re-derive the answer.
const cardSrc = read('components', 'customers', 'PreferredChannel.tsx')
check('the customer card uses resolveReach', /resolveReach\s*\(/.test(cardSrc), true)
check('the customer card uses the shared sentence', /reachSummary\s*\(/.test(cardSrc), true)
check('the customer card reads tenant capabilities', /tenantCapabilities\s*\(/.test(cardSrc), true)
// Reading them is not using them. A card that fetched capabilities and then
// asked resolveReach without them would silently promise a channel this
// business may not send on — green on the check above, wrong on screen. Assert
// the value reaches the VERDICT, which is the only thing the owner sees.
const rrCall = /resolveReach\(([\s\S]{0,600}?)\n\s*\)/.exec(cardSrc)
check('the customer card FEEDS those capabilities into the verdict',
  !!rrCall && /\bcaps\b/.test(rrCall[1]), true)
check('the customer card never writes a consent column',
  /sms_opt_in\s*:|email_opt_in\s*:\s*(true|false)/.test(cardSrc.replace(/sms_opt_in: !!customer\.sms_opt_in, email_opt_in: !!customer\.email_opt_in,/, '')), false)
check('the customer card writes ONLY preferred_channel',
  [...cardSrc.matchAll(/\.update\(\{([^}]*)\}\)/g)].map(m => m[1].trim()),
  ['preferred_channel: value'])
// A preference is not consent, so it must not be written to the consent audit —
// a consent_changes row for a preference would assert a permission change that
// never happened. Matched as a WRITE (`from('consent_changes')` / applyConsent),
// not as the bare word: the card explains in a comment why it doesn't write one,
// and a guard that fails on its own rationale teaches people to delete the
// rationale.
check('the customer card writes NO consent audit row',
  /from\(\s*['"]consent_changes['"]\s*\)|applyConsent\s*\(/.test(cardSrc), false)

const pageSrc = read('app', 'dashboard', 'customers', '[id]', 'page.tsx')
check('the customer record renders the card', /<PreferredChannelCard/.test(pageSrc), true)

// STOP handling is untouched and still the thing that flips the consent column.
const inboundSrc = read('app', 'api', 'sms', 'inbound', 'route.ts')
check('inbound STOP still writes sms_opt_in false',
  /STOP_WORDS\.includes\(kw\)[\s\S]{0,200}sms_opt_in:\s*false/.test(inboundSrc), true)
check('inbound STOP still audits to consent_changes', /consent_changes/.test(inboundSrc), true)
check('inbound STOP does NOT consult the preference', /preferred_channel/.test(inboundSrc), false)

// The DB, not just TypeScript, owns the allowed set. Located by pattern rather
// than by a hard-coded filename: the file is named for the version production
// RECORDED for it (supabase_migrations.schema_migrations), so pinning the name
// here would break the guard the moment that alignment is corrected — which is
// exactly what happened once already.
const migName = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .find(f => /_customer_preferred_channel\.sql$/.test(f))
check('the migration is present in the apply path', !!migName, true)
const mig = readFileSync(join(ROOT, 'supabase', 'migrations', migName!), 'utf8')
// It must sort AFTER the baseline: verify:rebuild applies the baseline and every
// migration after it in FILENAME order, so a name that sorted earlier would add
// a column to a table that does not exist yet.
check('…and sorts after the generated baseline',
  migName! > readdirSync(join(ROOT, 'supabase', 'migrations')).find(f => /_baseline\.sql$/.test(f))!, true)
check('the migration constrains the value set in the database',
  /check\s*\(preferred_channel is null or preferred_channel in \('sms', 'email', 'phone'\)\)/.test(mig), true)
check('the column is nullable (no preference is a real state)', /not null/i.test(mig), false)

// ═══════════════════════════════════════════════════════════════════════════
H('9b. BOTH SEND PATHS GO THROUGH THE ONE PRIMITIVE — manual AND automated')
// "Manual respects it" and "automated respects it" are the same claim in this
// codebase, and that is the point: every sender — the owner's reply, the nine
// crons, the campaign sweep, the chaser, receipts — funnels through
// dispatchToCustomer, which gates on reachCheck. So the way to prove both is to
// prove there is no second door, not to test two doors.
// Each sender is named WITH the door it goes through, rather than matched
// against a loose "any of these calls" pattern. Two of the crons reach dispatch
// via the shared chase engine (runChaseCron), and a check permissive enough to
// accept that would also have accepted a sender that gated on nothing.
const SENDERS = [
  ['app/api/messages/send/route.ts', "the owner's manual reply", /dispatchToCustomer\s*\(/],
  // The composer owns its send deliberately (bulk needs per-recipient results),
  // so its door is the shared PREDICATE rather than the shared dispatcher.
  ['app/api/comms/send/route.ts', 'the composer (single + bulk)', /reachCheck\s*\(/],
  ['app/api/cron/campaigns/route.ts', 'the automated campaign sweep', /dispatchToCustomer\s*\(/],
  ['app/api/cron/notifications/route.ts', 'automated visit reminders', /dispatchToCustomer\s*\(/],
  ['app/api/cron/scheduled-messages/route.ts', 'send-later messages', /dispatchToCustomer\s*\(/],
  ['app/api/booking/notify/route.ts', 'booking confirmations', /dispatchToCustomer\s*\(/],
  ['lib/comms/receipt.ts', 'payment receipts', /dispatchToCustomer\s*\(/],
  ['lib/automation/chase.ts', 'the automated chaser', /dispatchToCustomer\s*\(/],
  // These two own no send of their own — they hand rows to the chase engine.
  ['app/api/cron/invoice-reminders/route.ts', 'automated invoice reminders', /runChaseCron[<(]/],
  ['app/api/cron/quote-followup/route.ts', 'automated quote follow-up', /runChaseCron[<(]/],
] as const
for (const [rel, what, door] of SENDERS) {
  check(`${what} sends through the ONE gated pipeline`, door.test(read(...rel.split('/'))), true)
}
// api/comms/send owns its send deliberately, so it must gate itself.
check('the composer route gates on reachCheck itself (it does not call dispatch for the gate)',
  /reachCheck\s*\(/.test(read('app', 'api', 'comms', 'send', 'route.ts')), true)
// And nothing may reach the raw senders around that gate — verify:capabilities
// owns the full allowlist; this pins the two that matter for preference.
check('dispatch is still the chokepoint that imports the raw senders',
  /import\s*\{[^}]*\bsend(Sms|Email)\b[^}]*\}\s*from\s*'\.\/send'/.test(dispatchSrc), true)

// ═══════════════════════════════════════════════════════════════════════════
H('9c. CREW SEES CONTACT, NEVER CONSENT COMPLEXITY')
// A crew session has ZERO table access — the crew_day RPC is a column-limited
// projection, which is why a worker gets a name and a phone number and not the
// consent flags, the marketing categories or the lifetime value.
//
// The preference is deliberately NOT added to it. Handing a worker "prefers SMS"
// WITHOUT the consent that governs it is worse than saying nothing: it reads as
// an instruction to text, and the one thing this whole feature exists to prevent
// is a preference being mistaken for permission. A worker's legitimate contact
// is the phone number for today's visit, which they already have.
const crewSrc = read('lib', 'crewAccess.ts')
const crewCustomer = /customer:\s*\{[^}]*\}/.exec(crewSrc)
check('the crew stop carries a customer projection', !!crewCustomer, true)
check('…limited to name + phone', crewCustomer![0].replace(/\s+/g, ' '),
  'customer: { name: string; phone: string | null }')
for (const leak of ['sms_opt_in', 'email_opt_in', 'message_prefs', 'preferred_channel']) {
  check(`…and never carries ${leak}`, crewSrc.includes(leak), false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('10. THE SCREEN, RENDERED — what an owner actually reads, on a phone')
// Asserting the FUNCTION is honest is not the same as asserting the SCREEN is.
// The card is rendered for real (renderToStaticMarkup — the technique
// verify:mobile-shell and verify:team use for UI a script cannot see), so the
// sentence and the tap targets are checked as shipped rather than as intended.
//
// Offline and deterministic: useEffect does not run during SSR, so the
// capability read never fires; createClient only needs the env vars to exist to
// construct, and makes no request.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://verify.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'verify-anon-key'
const React = require('react') as typeof import('react')
;(globalThis as Record<string, unknown>).React = React
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const { PreferredChannelCard } =
  require('../src/components/customers/PreferredChannel') as typeof import('../src/components/customers/PreferredChannel')

const render = (over: Record<string, unknown>) => renderToStaticMarkup(
  React.createElement(PreferredChannelCard, {
    customer: {
      id: 'c1', name: 'Sam', phone: '+15875550100', email: 's@example.com',
      sms_opt_in: true, email_opt_in: true, preferred_channel: null, ...over,
    } as never,
  }),
)
const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()

// ⭐ The brief's example, on screen: preferred = SMS, SMS consent = false.
// The card must NOT read as permission to text.
const overruledHtml = render({ preferred_channel: 'sms', sms_opt_in: false })
check('the card SHOWS the overruled truth, not the preference',
  strip(overruledHtml).includes('Prefers text, but no opt-in — messages go by email instead.'), true)
check('…and it never tells the owner a text will be sent',
  /messages use|go by text/.test(strip(overruledHtml)), false)
const deadHtml = render({ preferred_channel: 'sms', sms_opt_in: false, email_opt_in: false })
check('no reachable channel is stated plainly on screen',
  strip(deadHtml).includes('No way to reach this customer'), true)
check('the unreachable card is toned as a problem', /border-red-500\/30/.test(deadHtml), true)
check('a call preference tells the owner to ring them',
  strip(render({ preferred_channel: 'phone' })).includes('give them a ring'), true)

// The consent boundary, stated on the surface itself — the sentence a future
// reader needs before they "improve" this card into a consent editor.
check('the card says a preference is not a permission',
  strip(render({})).includes('A preference, not a permission'), true)

// Per-channel status, the shape the brief asked for: the preference AND what
// each channel can actually do, so the owner never has to infer one from the
// other. Reasons use describeSkip's wording, not a second vocabulary.
check('both channels report a status',
  strip(render({})).includes('SMS: Allowed') && strip(render({})).includes('Email: Allowed'), true)
check('a blocked channel names its reason instead of saying Allowed',
  strip(render({ sms_opt_in: false })).includes('SMS: no opt-in'), true)
check('…and a missing contact reads as the contact gap',
  strip(render({ email: null })).includes('Email: no email on file'), true)

// Mobile: four options must WRAP on a 375px handset rather than overflow, and
// every one must be a real tap target. A row that overflows is unreachable in
// exactly the place this CRM is used — standing in a driveway.
const chipRow = /<div class="([^"]*flex flex-wrap[^"]*)" role="group"/.exec(overruledHtml)
check('the option row wraps instead of overflowing', !!chipRow, true)
const buttons = [...overruledHtml.matchAll(/<button[^>]*class="([^"]*)"/g)].map(m => m[1])
check('all four options render', buttons.length, 4)
check('every option is a 40px+ tap target', buttons.every(c => /min-h-\[40px\]/.test(c)), true)
check('every option is a type="button" (never a stray form submit)',
  [...overruledHtml.matchAll(/<button[^>]*>/g)].every(m => m[0].includes('type="button"')), true)
// Nothing fixed-width: a hard px width is what pushes a card past a 375px screen.
check('the card sets no fixed pixel width', /\bw-\[\d+px\]|\bmin-w-\[\d{3,}px\]/.test(overruledHtml), false)
// The selected option must be announced, not merely coloured — colour alone is
// not an answer for a screen reader or in bright sun.
check('the chosen option is announced via aria-pressed',
  /aria-pressed="true"/.test(render({ preferred_channel: 'email' })), true)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
