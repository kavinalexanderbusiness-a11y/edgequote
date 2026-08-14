// ── Verify: the pipeline derives its stages, and never invents a second one ──
//   npm run verify:pipeline
//
// WHY THIS SCRIPT EXISTS
// A sales pipeline is the single easiest feature in a CRM to get quietly wrong,
// because every one of its failure modes still renders. The four this guard
// exists to catch, all of which were live in this codebase when it was written:
//
//   • SEVEN COPIES OF "WON". `accepted/scheduled/completed/paid` was hand-rolled
//     as a local Set or inline array in customers/[id], properties, timeline,
//     businessIntelligence, ai/assist, quotes/[id] and winLoss. Six of them could
//     drift from the seventh and nothing would fail — the customer profile would
//     simply disagree with the conversion rate, silently, forever.
//
//   • A THIRD OPINION ABOUT WHAT'S NEXT. The customer profile's "Open items"
//     block asked `status === 'accepted'` with no check for an existing job, so
//     once the work was booked it kept saying "Schedule: Q-1042" — permanently,
//     on the customer's own page, while the dashboard (which DID check) showed
//     nothing. Two surfaces, two answers, one of them wrong.
//
//   • A STORED STAGE. The moment a `stage` column exists it is an eighth thing
//     that can disagree with quotes.status, and nothing re-derives it: the
//     customer accepts in the portal, a trigger completes the job, an invoice is
//     paid, and the stage stays where a human last dragged it.
//
//   • A CONFIDENT EMPTY BOARD. supabase-js resolves with {data:null,error} on a
//     dead connection, so a tolerant `|| []` renders "nothing to do" — the most
//     reassuring screen in the app — on a book with forty live deals.
//
// Pure-function tests run THE REAL ENGINE on fixtures; structural checks pin the
// single-engine contracts and the honest-failure surfaces.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computePipeline, quoteNextAction,
  type PipelineInput, type PQuote, type PJob, type PInvoice, type PCustomer,
} from '../src/lib/pipeline'
import { STAGE_ORDER, STAGE_LABELS, STAGE_MEANING, isWon, isLost, stageOfQuote } from '../src/lib/salesStage'
import { isWon as isWonFromWinLoss, LOSS_REASONS } from '../src/lib/winLoss'
import { DEFAULT_SEASONS } from '../src/lib/seasons'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A fixed clock, so "quiet for 5 days" is a fact and not a function of when CI runs.
const TODAY = '2026-08-13'
const NOW = new Date('2026-08-13T18:00:00Z').getTime()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

function quote(p: Partial<PQuote> & { id: string }): PQuote {
  return {
    customer_id: 'c1', customer_name: 'Dana Reyes', status: 'draft', total: 800,
    service_type: 'Lawn Mowing', created_at: daysAgo(10), sent_at: null,
    last_followed_up_at: null, valid_until: null, lead_meta: null, ...p,
  }
}
function job(p: Partial<PJob> & { id: string }): PJob {
  return {
    customer_id: 'c1', quote_id: null, status: 'scheduled', scheduled_date: TODAY,
    recurrence_id: null, price: 800, service_type: 'Lawn Mowing', ...p,
  }
}
function invoice(p: Partial<PInvoice> & { id: string }): PInvoice {
  return {
    invoice_number: 'INV-0001', quote_id: null, customer_id: 'c1', status: 'unpaid',
    amount: 800, amount_paid: 0, discount_type: null, discount_value: null,
    deposit_amount: null, deposit_requested_at: null, ...p,
  }
}
function customer(p: Partial<PCustomer> & { id: string }): PCustomer {
  return {
    name: 'Dana Reyes', created_at: daysAgo(90), last_contacted_at: null,
    phone: '5875551234', email: 'dana@example.com',
    sms_opt_in: true, email_opt_in: true, message_prefs: null, ...p,
  } as PCustomer
}

function input(p: Partial<PipelineInput> = {}): PipelineInput {
  return {
    quotes: [], jobs: [], invoices: [], customers: [customer({ id: 'c1' })],
    conversations: [], outcomes: [], recById: {},
    seasons: DEFAULT_SEASONS, feeSettings: { gst_percent: 5 },
    today: TODAY, nowMs: NOW, ...p,
  }
}
const only = (p: Partial<PipelineInput>) => computePipeline(input(p)).items
const firstAction = (p: Partial<PipelineInput>) => only(p)[0]?.action.kind

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ One won/lost rule, not seven ═══')

// The predicate moved to lib/salesStage; winLoss re-exports it. If someone ever
// re-declares a local copy in winLoss, these stop being the same function.
check('lib/winLoss re-exports THE predicate rather than owning a copy',
  isWon === isWonFromWinLoss,
  'winLoss.isWon is no longer the same function object as salesStage.isWon — a second copy has appeared')

for (const s of ['accepted', 'scheduled', 'completed', 'paid']) {
  check(`${s} counts as won`, isWon(s))
}
check('sent is neither won nor lost', !isWon('sent') && !isLost('sent'),
  'an unanswered quote counted as decided INFLATES acceptance and the price learner reads it')
check('declined is lost', isLost('declined') && !isWon('declined'))

// ⭐ THE structural half: no surface may hand-roll the set again. This is the
// check that would have caught all six copies on the day each was written.
const SRC_FILES = [
  'src/lib/timeline.ts',
  'src/lib/ai/assist.ts',
  'src/lib/businessIntelligence.ts',
  'src/app/dashboard/properties/page.tsx',
  'src/app/dashboard/customers/[id]/page.tsx',
  'src/app/dashboard/quotes/[id]/page.tsx',
  'src/lib/winLoss.ts',
  'src/lib/pipeline.ts',
]
// Matches the four statuses listed together in any order of quoting, which is
// what every one of the six copies looked like. \s covers CRLF — `.` does not.
const HANDROLLED = /['"]accepted['"]\s*,\s*['"]scheduled['"]\s*,\s*['"]completed['"]\s*,\s*['"]paid['"]/
for (const f of SRC_FILES) {
  const text = read(f)
  check(`${f} does not re-declare the won set`, !HANDROLLED.test(text),
    'import isWon from @/lib/salesStage instead — six copies of this list is how a customer profile ends up disagreeing with the conversion rate')
}
// …and the canonical file is allowed to state it exactly once.
check('lib/salesStage states the rule exactly once',
  (read('src/lib/salesStage.ts').match(/=== 'accepted'/g) || []).length === 1)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ Stages are DERIVED — there is no stage to store ═══')

eq('a draft quote is on the drafted rung', stageOfQuote('draft'), 'quote_draft')
eq('a sent quote is on the sent rung', stageOfQuote('sent'), 'quote_sent')
eq('an accepted quote is won', stageOfQuote('accepted'), 'won')
eq('a paid quote is still won (not a seventh rung)', stageOfQuote('paid'), 'won')
eq('a declined quote is lost', stageOfQuote('declined'), 'lost')
// Total, not partial: a status this app has never heard of must land SOMEWHERE.
eq('an unknown status lands on a real rung', stageOfQuote('zzz_unknown'), 'quote_draft')

check('every rung has a label and a meaning',
  STAGE_ORDER.every(s => !!STAGE_LABELS[s] && !!STAGE_MEANING[s]),
  'an unlabelled rung renders as a blank filter pill')
eq('the ladder is six rungs', STAGE_ORDER.length, 6)

// ⭐ NO STORED STAGE. The whole feature rests on this: the engine may never read
// or write a stage column, and the loader may never select one.
for (const f of ['src/lib/pipeline.ts', 'src/lib/pipelineData.ts', 'src/lib/salesStage.ts']) {
  const text = read(f)
  check(`${f} never reads or writes a stored stage`,
    !/\bpipeline_stage\b|\bsales_stage\b|['"]stage['"]\s*:/.test(text) && !/\.update\(|\.insert\(|\.upsert\(/.test(text),
    'a stored stage is an eighth thing that can disagree with quotes.status, and nothing re-derives it')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ One deal, one next action ═══')

// A draft that CAN go out asks to be sent.
eq('a finished draft asks to be sent', firstAction({ quotes: [quote({ id: 'q1' })] }), 'send_quote')

// …and one that cannot names the real blocker, through THE shared send gate —
// never "Send quote" about a document the Send button would refuse.
eq('a priceless draft asks for a price',
  firstAction({ quotes: [quote({ id: 'q1', total: null })] }), 'price_quote')
eq('a $0 draft asks for a price too',
  firstAction({ quotes: [quote({ id: 'q1', total: 0 })] }), 'price_quote')
eq('a customerless draft asks for a customer',
  firstAction({ quotes: [quote({ id: 'q1', customer_id: null })] }), 'link_customer')

// A sent quote that is not yet quiet asks for NOTHING. Inventing a nudge here is
// how a queue teaches the owner to ignore it.
eq('a quote sent yesterday says wait',
  firstAction({ quotes: [quote({ id: 'q1', status: 'sent', sent_at: daysAgo(1) })] }), 'wait')
eq('a quote quiet past the cadence asks for a follow-up',
  firstAction({ quotes: [quote({ id: 'q1', status: 'sent', sent_at: daysAgo(5) })] }), 'follow_up')

// ⭐ Gone quiet is NOT the same question as can-be-chased. The verb changes with
// the answer: find a number, versus send a message.
eq('a quiet quote for an unreachable customer asks for a phone number',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'sent', sent_at: daysAgo(5) })],
    customers: [customer({ id: 'c1', phone: null, email: null })],
  }),
  'add_contact')

// Won: money first, then booking, then billing.
eq('an approved quote with no job asks to be scheduled',
  firstAction({ quotes: [quote({ id: 'q1', status: 'accepted' })] }), 'schedule_work')

// ⭐ THE regression the customer profile shipped: a booked quote must stop asking.
eq('an approved quote WITH a job stops asking to be scheduled',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'accepted' })],
    jobs: [job({ id: 'j1', quote_id: 'q1' })],
  }),
  undefined)
// …and a CANCELLED job is not booked work.
eq('a cancelled job does not count as scheduled',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'accepted' })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'cancelled' })],
  }),
  'schedule_work')

eq('an unpaid deposit outranks everything else on a won deal',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'accepted' })],
    jobs: [job({ id: 'j1', quote_id: 'q1' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1', deposit_amount: 300, deposit_requested_at: daysAgo(2) })],
  }),
  'collect_deposit')

eq('a worked, invoiced deal with a balance asks for payment',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'completed' })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'completed' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1' })],
  }),
  'collect_payment')

eq('a draft invoice asks to be sent, not chased',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'completed' })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'completed' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1', status: 'draft' })],
  }),
  'send_invoice')

// ⚠️ A CANCELLED invoice keeps its FULL balance in the ledger. Every money door
// has to check the status, not just the number.
eq('a cancelled invoice never asks for payment',
  firstAction({
    quotes: [quote({ id: 'q1', status: 'completed' })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'completed' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1', status: 'cancelled' })],
  }),
  undefined)

// ⭐ A finished deal LEAVES the board. This is what keeps the pipeline a queue.
eq('a booked, invoiced, fully paid deal is off the board',
  only({
    quotes: [quote({ id: 'q1', status: 'paid' })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'completed' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1', status: 'paid', amount_paid: 840 })],
  }).length,
  0)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ Leads: answered or not, and never counted twice ═══')

const websiteConv = {
  id: 'v1', customer_id: 'c1', lead_status: 'new', last_direction: 'inbound',
  last_message_at: daysAgo(1), created_at: daysAgo(1), snoozed_until: null,
  customers: { name: 'Dana Reyes' },
}

eq('an unanswered lead asks for a call',
  firstAction({ conversations: [websiteConv] }), 'call_lead')
eq('…and sits on the first rung', only({ conversations: [websiteConv] })[0]?.stage, 'new_lead')

// "Have we reached out" is customers.last_contacted_at — the trigger-maintained
// fact, the same one lib/crm/radar asks. Not a guess from message direction.
const contactedRun = only({
  conversations: [websiteConv],
  customers: [customer({ id: 'c1', last_contacted_at: daysAgo(1) })],
})
eq('a lead we have replied to moves to Contacted', contactedRun[0]?.stage, 'contacted')
eq('…and asks for a quote to be prepared', contactedRun[0]?.action.kind, 'prepare_quote')

// ⭐ ONE ROW PER DEAL. The quote IS the response to the lead — exactly what
// closeOpenLeads encodes. Two rows would be the queue telling the owner to do one
// job twice, which is the defect the dashboard's messages/leads split already fixed.
const both = only({ conversations: [websiteConv], quotes: [quote({ id: 'q1' })] })
eq('a lead whose customer already has a quote is ONE deal, not two', both.length, 1)
eq('…and it is the quote that represents it', both[0]?.source, 'quote')

// A lead nobody has priced is worth an UNKNOWN amount, never $0 — a $0 deal
// renders as a real, worthless one and drags the board's open value down.
eq('an unpriced lead has a null value, not zero',
  only({ conversations: [websiteConv] })[0]?.value, null)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ Lost reasons: asked once, optional, never duplicated ═══')

const lostOnly = only({ quotes: [quote({ id: 'q1', status: 'declined' })] })
eq('an untagged loss offers the optional reason', lostOnly[0]?.action.kind, 'log_loss')
check('…and it is marked optional', lostOnly[0]?.action.optional === true,
  'a reason the owner must give produces a tidy field full of noise, and the price advisor believes what it reads')
eq('a tagged loss stops asking',
  only({
    quotes: [quote({ id: 'q1', status: 'declined' })],
    outcomes: [{ quote_id: 'q1', reason: 'price' }],
  }).length,
  0)

// The vocabulary is the EXISTING one — no second list of reasons.
check('the reasons come from lib/winLoss, and cover the six the owner asked for',
  ['price', 'timing', 'no_response', 'competitor', 'scope', 'other'].every(k => LOSS_REASONS.some(r => r.key === k)),
  'a second reason vocabulary would split quote_outcomes into two incompatible halves')
const host = read('src/components/quotes/LostReasonHost.tsx')
check('the capture writes through THE recorder',
  host.includes('recordQuoteOutcome') && !/from\('quote_outcomes'\)/.test(host),
  'a direct insert here would bypass the idempotent upsert and duplicate reasons')
check('the capture has a real skip', /Skip/.test(host),
  'the brief says optional — a dialog with no way out is not optional')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ Ranking: money, then perishable, then the rest ═══')

const mixed = only({
  quotes: [
    quote({ id: 'q1', status: 'sent', sent_at: daysAgo(9), total: 200 }),   // follow_up
    quote({ id: 'q2', status: 'completed', total: 5000, customer_id: 'c2' }), // collect_payment
    quote({ id: 'q3', status: 'draft', total: 900, customer_id: 'c3' }),      // send_quote
  ],
  jobs: [job({ id: 'j2', quote_id: 'q2', status: 'completed', customer_id: 'c2' })],
  invoices: [invoice({ id: 'i2', quote_id: 'q2', customer_id: 'c2', amount: 5000 })],
  customers: [customer({ id: 'c1' }), customer({ id: 'c2' }), customer({ id: 'c3' })],
})
eq('money already owed leads', mixed[0]?.action.kind, 'collect_payment')
eq('an undelivered quote outranks a chase', mixed[1]?.action.kind, 'send_quote')
eq('the chase is last of the three', mixed[2]?.action.kind, 'follow_up')

// ⭐ The clamp: a huge dollar figure must not let a row jump its tier. This is
// the invariant the Owner Action queue documents, and the pipeline imports the
// SAME clamp rather than copying it.
const jumped = only({
  quotes: [
    quote({ id: 'q1', status: 'draft', total: 999_999 }),                    // send_quote, tier 9
    quote({ id: 'q2', status: 'completed', total: 1, customer_id: 'c2' }),   // collect_payment, tier 11
  ],
  jobs: [job({ id: 'j2', quote_id: 'q2', status: 'completed', customer_id: 'c2' })],
  invoices: [invoice({ id: 'i2', quote_id: 'q2', customer_id: 'c2', amount: 1 })],
  customers: [customer({ id: 'c1' }), customer({ id: 'c2' })],
})
eq('a million-dollar draft still cannot outrank a $1 unpaid invoice',
  jumped[0]?.action.kind, 'collect_payment')

// `wait` sorts below everything that actually asks for something.
const waits = only({
  quotes: [
    quote({ id: 'q1', status: 'sent', sent_at: daysAgo(1), total: 9000 }),  // wait
    quote({ id: 'q2', status: 'declined', total: 10, customer_id: 'c2' }),   // log_loss
  ],
  customers: [customer({ id: 'c1' }), customer({ id: 'c2' })],
})
eq('even an optional ask outranks "nothing to do"', waits[0]?.action.kind, 'log_loss')
eq('…and the counts only ever describe rows on the board',
  computePipeline(input({ quotes: [quote({ id: 'q1', status: 'sent', sent_at: daysAgo(1) })] })).actionable, 0)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ One engine behind every surface ═══')

// The per-quote answer the customer profile uses must BE the engine's answer.
const single = quoteNextAction(quote({ id: 'q1', status: 'accepted' }), {
  booked: new Set<string>(), feeSettings: { gst_percent: 5 }, today: TODAY, nowMs: NOW,
})
eq('quoteNextAction agrees with the board on the same quote', single?.kind, 'schedule_work')
eq('…and stops when the work is booked',
  quoteNextAction(quote({ id: 'q1', status: 'accepted' }), {
    booked: new Set(['q1']), feeSettings: { gst_percent: 5 }, today: TODAY, nowMs: NOW,
  }),
  null)

const profile = read('src/app/dashboard/customers/[id]/page.tsx')
check('the customer profile derives its open items from THE engine',
  profile.includes('quoteNextAction') && profile.includes('scheduledQuoteIds'),
  'this page used to hand-roll the rules, and its Schedule rule never checked for an existing job')
check('…and no longer asks its own "accepted means schedule it" question',
  !/status === 'accepted'\)\)\s*\{[\s\S]{0,200}Schedule:/.test(profile),
  'that rule told the owner to book work that was already on the calendar, forever')

const priorities = read('src/lib/dashboard/priorities.ts')
check('the Owner Action queue and the pipeline share ONE booked-work predicate',
  priorities.includes('export function scheduledQuoteIds') && priorities.includes('scheduledQuoteIds(jobs)'),
  'two copies is how the dashboard says "schedule 3" while the pipeline shows 4')
check('…and ONE tier clamp',
  priorities.includes('export const tierAdder') && read('src/lib/pipeline.ts').includes('tierAdder'),
  'two clamps is two ways for the ordering to silently invert')

const engine = read('src/lib/pipeline.ts')
for (const [what, marker] of [
  ['staleness (lib/followup)', 'quoteIsQuiet'],
  ['reachability (lib/comms/reach)', 'canChaseCustomer'],
  ['expiry (lib/quoteStatus)', 'isQuoteExpired'],
  ['the send gate (lib/quoteStatus)', 'sendBlockedReason'],
  ['the balance (lib/payments/ledger)', 'invoiceBalance'],
  ['the deposit (lib/payments/deposit)', 'depositState'],
  ['the lead union (lib/leadResponse)', 'computeLeadsNeedingResponse'],
  ['lapses (lib/reactivation)', 'computeReactivation'],
] as const) {
  check(`the engine borrows ${what} rather than re-deriving it`, engine.includes(marker),
    'a second implementation of this rule is a second answer the owner cannot reconcile')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ A failed read is never an empty pipeline ═══')

const loader = read('src/lib/pipelineData.ts')
check('the loader throws on a failed read instead of rendering "nothing to do"',
  /if \(failure\) throw new Error/.test(loader),
  'supabase-js RESOLVES on failure — a tolerant `|| []` paints an all-caught-up board over a book with forty live deals')
for (const table of ['quotes', 'jobs', 'invoices', 'customers', 'conversations', 'quote_outcomes']) {
  const key = table === 'quote_outcomes' ? 'outRes' : `${table.slice(0, 4)}`
  check(`a failed ${table} read is reported`, loader.includes(`${key}`) && loader.includes('.error'),
    'a silently truncated or failed read understates the board')
}
check('the full-history reads are paged',
  (loader.match(/pageAll</g) || []).length >= 3,
  'an unbounded select stops at 1000 rows — a short jobs read tells the owner to schedule work already booked')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ It works on a phone ═══')

const board = read('src/components/pipeline/PipelineBoard.tsx')
check('the board is a list, not a drag-and-drop kanban',
  !/draggable|onDragStart|DndContext/.test(board),
  'five columns at 375px is five horizontal scrolls — and the stages are DERIVED, so there is nothing to drop a card into')
check('the primary action clears the 44px touch floor',
  /min-h-\[44px\]/.test(board) && /min-h-\[44px\]/.test(host),
  'a tap target under 44px is a miss on a phone in a driveway')
check('the stage pills scroll rather than wrap into a wall on a phone',
  /overflow-x-auto/.test(board),
  'six pills plus counts do not fit across 375px')
check('one tap opens the deal itself',
  board.includes('href={o.href}'),
  'the brief: one tap should open the customer/opportunity and its next action')
check('a row with nothing to do renders no button',
  board.includes("!isWait") || board.includes("kind !== 'wait'"),
  'a button that does nothing is worse than silence')

// The board must not have grown its own opinion about stages or verbs.
check('the board maps kinds to icons and nothing more',
  !board.includes("=== 'accepted'") && !board.includes("status ===") && !board.includes('needsFollowUp'),
  'presentation deciding what is next is how a fourth opinion starts')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ The page has a door, and says what it is ═══')

const modules = read('src/lib/modules.ts')
check('Pipeline is in the module registry (so it is in the nav and ⌘K)',
  modules.includes("key: 'pipeline'") && modules.includes("href: '/dashboard/pipeline'"),
  'a page with no registry entry and no link is reachable only by typing the URL')

const page = read('src/app/dashboard/pipeline/page.tsx')
check('the page says a finished deal LEAVES the board',
  /leaves this list/.test(page),
  'without this, a short Won column reads as a bad month rather than a clean one')
check('…and points at the history rather than duplicating it',
  page.includes('/dashboard/quotes') && page.includes('/dashboard/grow'),
  'the win-rate report already exists in Grow — a second copy on this page would drift from it')

// ═════════════════════════════════════════════════════════════════════════════
// A brand-new tenant sees an empty board, not a crash
// ─────────────────────────────────────────────────────────────────────────────
// The fixture tenant on production has zero of everything, and so does every
// business on its first day. That path renders a DIFFERENT branch of the board
// (no rows, no pills, an EmptyState) which no other test in this file reaches —
// and "first run" is where this codebase has been bitten before. Rendered for
// real, the technique verify:mobile-shell uses, not grepped.
console.log('\n═══ A brand-new tenant sees an empty board, not a crash ═══')
{
  const React = require('react') as typeof import('react')
  ;(globalThis as Record<string, unknown>).React = React
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
  const { PipelineBoard } = require('../src/components/pipeline/PipelineBoard') as typeof import('../src/components/pipeline/PipelineBoard')

  const empty = computePipeline(input())
  eq('a tenant with no records has an empty board', empty.items.length, 0)
  eq('…and claims no open money', empty.openValue, 0)

  let html = ''
  try { html = renderToStaticMarkup(React.createElement(PipelineBoard, { report: empty })) }
  catch (e) { fail('the empty board renders', String((e as Error).message)) }
  check('the empty board renders', html.length > 0)
  check('…and says so in plain words rather than showing a bare frame',
    /Nothing in the pipeline/.test(html),
    'a blank card on day one reads as broken')

  // …and the populated branch renders too, with the row's verb visible.
  const busy = computePipeline(input({ quotes: [quote({ id: 'q1', status: 'accepted' })] }))
  const busyHtml = renderToStaticMarkup(React.createElement(PipelineBoard, { report: busy }))
  check('a populated board renders its rows', /Schedule work/.test(busyHtml),
    'the verb the engine chose must reach the screen')
  check('…and every stage pill is present', /aria-pressed/.test(busyHtml))
}


// ═════════════════════════════════════════════════════════════════════════════
// The deposit gate, and the two definitions that must stay two
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══ A gated booking is not urged onto the schedule ═══')
{
  type Row = { amount: number; kind?: string | null; provider?: string | null; status?: string | null }
  const gated = (rows: Row[] | undefined) =>
    computePipeline(input({
      quotes: [quote({ id: 'q1', status: 'accepted', total: 1000, accepted_price: 1000, deposit_type: 'percent', deposit_value: 50 })],
      ...(rows === undefined ? {} : { quoteDepositRows: { q1: rows } }),
    })).items[0]?.action

  // ⭐ THE divergence this block exists to stop: the Owner Action queue splits
  // accepted-unscheduled into ready vs waiting-on-deposit. If the pipeline still
  // said "Schedule work" here, one screen would urge exactly what the other withholds.
  eq('an unpaid deposit blocks the schedule prompt', gated([])?.kind, 'collect_deposit')
  eq('a partly-paid deposit still blocks it',
    gated([{ amount: 200, kind: 'payment', provider: 'manual', status: 'paid' }])?.kind, 'collect_deposit')
  eq('a satisfied deposit releases it',
    gated([{ amount: 500, kind: 'payment', provider: 'manual', status: 'paid' }])?.kind, 'schedule_work')
  eq('a quote with NO deposit rule is unaffected',
    computePipeline(input({ quotes: [quote({ id: 'q1', status: 'accepted' })], quoteDepositRows: {} })).items[0]?.action.kind,
    'schedule_work')

  // ⚠️⚠️ UNREAD ≠ UNPAID. A caller that never loaded payments must not announce
  // that a paid booking is unsecured — the inverse of the failure depositGate's
  // own loader guards against, and just as false.
  eq('an UNREAD deposit ledger skips the gate rather than claiming unpaid',
    gated(undefined)?.kind, 'schedule_work')
  check('…and the engine says so where someone will look',
    /UNDEFINED means "not read"/.test(read('src/lib/pipeline.ts')),
    'the two meanings of absent are load-bearing and must be written down')

  // Both surfaces ask THE gate; neither re-derives it.
  for (const f of ['src/lib/pipeline.ts', 'src/lib/dashboard/priorities.ts']) {
    check(`${f} asks THE scheduling gate`, read(f).includes('gateBlocksScheduling'),
      'a second readiness rule is a second answer about whether money arrived')
  }
  check('a failed deposit read throws rather than un-securing every booking',
    /depRes\.error \? /.test(read('src/lib/pipelineData.ts')),
    'reporting "no deposit" on a failed read gates work the customer already paid for')
}

console.log('\n═══ Change Orders do not become a second won definition ═══')
{
  // ⭐⭐ Two engines, two QUESTIONS, two UNITS. isWon answers "did this DEAL
  // close?" over quotes.status. authorizedValue answers "what is this VISIT
  // worth now?" over jobs + change_orders. Change Orders never writes `quotes`,
  // so there is exactly one won definition — and this pins it, in both directions.
  const co = read('src/lib/changeOrders.ts')
  check('the change-order engine never classifies won/lost',
    !/isWon|isLost|salesStage/.test(co),
    'the moment it answers "did the deal close?" there are two won definitions')
  check('…and never rewrites the quote the customer agreed to',
    !/from\('quotes'\)[\s\S]{0,120}\.update\(/.test(co),
    'rewriting quotes.total / accepted_price would destroy the original agreed value')

  const engine = read('src/lib/pipeline.ts')
  check('the pipeline never re-derives authorized value',
    !engine.includes('authorizedValue') && !engine.includes('changeOrders'),
    'the deal ladder and the visit value are different questions — importing one into the other collapses them')

  // ⚖️ OWNER RULING 2026-08-14: original accepted deal value, current authorized
  // job value, amount invoiced and amount still collectible are FOUR figures.
  // The pipeline's headline is the DEAL value and must never silently become the
  // balance just because a change order grew the invoice.
  const wonRow = computePipeline(input({
    quotes: [quote({ id: 'q1', status: 'completed', total: 1000 })],
    jobs: [job({ id: 'j1', quote_id: 'q1', status: 'completed' })],
    invoices: [invoice({ id: 'i1', quote_id: 'q1', amount: 1600, amount_paid: 0 })],
  })).items[0]
  eq('the headline stays the agreed DEAL value…', wonRow?.value, 1000)
  check('…while the action quotes what is still COLLECTIBLE, separately',
    /1,680|1,600/.test(wonRow?.action.detail || ''),
    `the two figures must both be visible and distinct — got ${wonRow?.action.detail}`)
  eq('…and the verb is about the money, not the deal', wonRow?.action.kind, 'collect_payment')
}


console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:pipeline — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:pipeline — stages derived, one action per deal, one engine behind every surface\n')

