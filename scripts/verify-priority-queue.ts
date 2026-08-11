// ── Verify: the priority queue names ONE record and opens THAT record ────────
//   npm run verify:priority-queue
//
// WHY THIS SCRIPT EXISTS
// The dashboard queue answers "what needs me right now?". It used to answer it
// one abstraction too high: every row named a CATEGORY and linked to an
// unfiltered list — "Collect unpaid invoices · 4 outstanding" → /dashboard/
// invoices, all 66 of them. The engine had already worked out exactly which four
// and then discarded that, so the owner re-derived the set by hand at the far
// end. The row named the job but not the work.
//
// Now each row leads with its most urgent MEMBER and its href is that member's
// own focused surface. That creates a NEW way to be wrong, and it is the worst
// kind for this product: a row can now make a specific claim about a specific
// customer. "Collect from Sarah Chen" pointing at Mike's invoice, or at an
// invoice she already paid, is worse than the vague row it replaced.
//
// So this guard drives the REAL engine over fixtures and pins:
//   1. the named record and the linked record are the SAME record,
//   2. records that must never surface (cancelled, paid, fully-covered) don't,
//   3. one obligation produces one row — never two,
//   4. a row degrades to the old count-and-list form rather than render a
//      half-known record,
//   5. the tier ORDER the file documents is still the order you get,
//   6. and a failed read still throws instead of painting an empty queue.
//
// Every figure comes from the canonical engines (ledger balance + overdue
// overlay, compareFollowUp, the leads engine's own sort); this script asserts the
// queue CONSUMES them, and owns no money maths of its own.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computePriorities, isMissed, type PriorityInvoice, type Priority } from '../src/lib/dashboard/priorities'
import { invoiceBalance } from '../src/lib/payments/ledger'
import { settingsToSeasons } from '../src/lib/seasons'
import { computeLeadsNeedingResponse, type LeadResponseReport } from '../src/lib/leadResponse'
import type { Quote } from '../src/types'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const TODAY = '2026-08-11'
const NO_LEADS: LeadResponseReport = { items: [], total: 0, bySource: { website: 0, reply: 0, booking: 0 }, oldestHours: null }

// A quote with only the fields the queue reads; the rest of the 45-column type is
// irrelevant here and casting keeps the fixtures legible.
const quote = (q: Partial<Quote>): Quote => ({
  id: 'q1', customer_id: 'c1', customer_name: 'Somebody', status: 'accepted',
  total: 100, service_type: 'Mowing', created_at: '2026-07-01T00:00:00Z',
  ...q,
} as Quote)

const inv = (i: Partial<PriorityInvoice>): PriorityInvoice => ({
  amount: 100, status: 'unpaid', amount_paid: 0,
  invoice_number: 'INV-0001', customer_name: 'Somebody', due_date: null,
  ...i,
})

// The queue with everything switched off except what a test hands it.
function run(over: Partial<Parameters<typeof computePriorities>[0]>): Priority[] {
  return computePriorities({
    quotes: [], invoices: [], jobs: [], recById: {}, customers: [],
    conversations: [], leads: NO_LEADS, seasons: settingsToSeasons(null),
    feeSettings: null, today: TODAY, limit: 12,
    ...over,
  })
}
const row = (rows: Priority[], kind: string) => rows.find(r => r.kind === kind)

// ── 1. The named record IS the linked record ────────────────────────────────
console.log('\nA row names one record and opens that same record:')
{
  const rows = run({
    invoices: [
      inv({ invoice_number: 'INV-0042', customer_name: 'Sarah Chen', amount: 340, due_date: '2026-07-30' }),
      inv({ invoice_number: 'INV-0043', customer_name: 'Mike Reyes', amount: 900, due_date: '2026-08-30' }),
    ],
  })
  const r = row(rows, 'unpaid')!
  check('the label names the customer, not the category',
    r.label === 'Collect from Sarah Chen',
    `got "${r.label}" — a row that says "Collect unpaid invoices" sends the owner to find them again`)
  check('the href opens the invoice the label named',
    r.href === '/dashboard/invoices?invoice=INV-0042',
    `got "${r.href}" — naming Sarah and opening someone else is a lie the old vague row could not tell`)
  check('the detail says WHY this one',
    /INV-0042 · 12 days overdue/.test(r.detail), `got "${r.detail}"`)
  eq('the others are counted, not hidden', r.more, 1)
  check('the figure is the NAMED invoice, not the pile',
    r.value === 340,
    `got ${r.value} — 1240 would be the set total sitting beside one customer's name`)
}

// ── 1b. …and the same is true of every other kind that can name one ─────────
console.log('\nEvery kind that can name a record opens that record:')
{
  // Accepted-but-unscheduled → the schedule's own `?quote=` door, which opens the
  // job form already filled from that quote. Biggest first: the money most at
  // risk of slipping.
  const rows = run({ quotes: [
    quote({ id: 'qSmall', status: 'accepted', customer_name: 'Small Fry', total: 90 }),
    quote({ id: 'qBig', status: 'accepted', customer_name: 'Sarah Chen', total: 1375, service_type: 'Mulch Installation' }),
  ] })
  const u = row(rows, 'unscheduled')!
  eq('the label names whose job it is', u.label, 'Schedule Sarah Chen’s job')
  eq('the href opens THAT quote on the schedule', u.href, '/dashboard/schedule?quote=qBig')
  check('the detail says what the job is and why it is here',
    u.detail === 'Mulch Installation · accepted, no date yet', `got "${u.detail}"`)
  eq('the value is that quote, not both', u.value, 1375)
  eq('and the other is counted', u.more, 1)

  // Quotes gone quiet → the quote's own detail route, chosen by compareFollowUp
  // (oldest first) — the SAME order the Quotes follow-up queue uses.
  const quiet = (id: string, name: string, sentDaysAgo: number, total: number) => quote({
    id, status: 'sent', customer_name: name, total,
    sent_at: new Date(Date.now() - sentDaysAgo * 86_400_000).toISOString(),
  })
  const f = row(run({
    quotes: [quiet('qNew', 'Recent', 5, 8000), quiet('qOld', 'Ada Lovelace', 30, 200)],
    customers: [{ id: 'c1', phone: '5875551234', email: null, sms_opt_in: true, email_opt_in: false, message_prefs: null }] as never,
  }), 'followups')!
  eq('the oldest quiet quote is the one named', f.label, 'Follow up with Ada Lovelace')
  eq('…and the one opened', f.href, '/dashboard/quotes/qOld')
  check('the detail says how long it has been quiet', /quiet 30 days/.test(f.detail), `got "${f.detail}"`)

  // Drafts → the invoice detail, same `?invoice=` door.
  const d = row(run({ invoices: [
    inv({ status: 'draft', invoice_number: 'INV-D1', customer_name: 'Bo Diddley', amount: 300 }),
    inv({ status: 'draft', invoice_number: 'INV-D2', customer_name: 'Small', amount: 10 }),
  ] }), 'drafts')!
  eq('the largest draft is named', d.label, 'Send Bo Diddley’s invoice')
  eq('…and opened', d.href, '/dashboard/invoices?invoice=INV-D1')
  check('a name already ending in s takes a bare apostrophe',
    row(run({ invoices: [inv({ status: 'draft', invoice_number: 'INV-D3', customer_name: 'Chris', amount: 5 })] }), 'drafts')!.label === 'Send Chris’ invoice')

  // An invoice number with URL-hostile characters must survive the round trip.
  const enc = row(run({ invoices: [inv({ invoice_number: 'INV/2026 #7', customer_name: 'Zed', amount: 90 })] }), 'unpaid')!
  eq('the invoice number is url-encoded', enc.href, '/dashboard/invoices?invoice=INV%2F2026%20%237')
}

// ── 1c. …and the kinds with NO focused door stay honest count rows ──────────
console.log('\nA row never names a record its destination cannot open:')
{
  // /dashboard/reactivation takes no focus parameter. A row reading "Re-book
  // Sarah" that lands on an undifferentiated list promises a specificity the
  // page cannot honour — worse than the vague row, because the owner arrives
  // looking for a name that isn't highlighted anywhere.
  const jobs = [
    { id: 'j1', customer_id: 'cLapsed', status: 'completed', scheduled_date: '2026-04-01', recurrence_id: 'r1', price: 50, quote_id: null },
  ]
  const rows = run({
    customers: [{ id: 'cLapsed', phone: '5875550000', email: null, sms_opt_in: true, email_opt_in: false, message_prefs: null }] as never,
    jobs: jobs as never,
    recById: { r1: { id: 'r1', freq: 'weekly', interval_unit: 'week', interval_count: 1 } } as never,
  })
  for (const kind of ['reactivation', 'lapsed'] as const) {
    const r = row(rows, kind)
    if (!r) continue
    check(`${kind} keeps a list destination`,
      r.href === '/dashboard/reactivation', `got "${r.href}"`)
    check(`${kind} does not name a customer it cannot open`,
      !/’s|Collect from|Respond to|Follow up with|Schedule /.test(r.label), `got "${r.label}"`)
  }

  // The structural half: these pages take no ?focus, so the engine must not have
  // learned to build a deep link into them.
  // NB: `/dashboard/messages?c=` is deliberately NOT in this list. It looks like
  // an invented parameter and an earlier revision of this guard banned it as one
  // — but the messages page really does read `?c=<customerId>` and open that
  // conversation (it is where the bell and push notifications land). Banning it
  // here pinned the defect: reply leads were forced onto the bare inbox.
  const ENGINE = readFileSync(join(process.cwd(), 'src/lib/dashboard/priorities.ts'), 'utf8')
  for (const dead of ['/dashboard/reactivation?', '/dashboard/schedule?job=']) {
    check(`no invented deep link into ${dead}`,
      !ENGINE.includes(dead),
      'the target page takes no such parameter — the link would silently land on the plain list')
  }
}

// ── 2. Overdue outranks bigger, and the ledger decides which is overdue ─────
console.log('\nThe pick uses the ledger overlay, not a second opinion:')
{
  const overdue = inv({ invoice_number: 'INV-OLD', customer_name: 'Ada', amount: 50, due_date: '2026-06-01' })
  const bigger = inv({ invoice_number: 'INV-BIG', customer_name: 'Bo', amount: 5000, due_date: '2026-12-01' })
  const r = row(run({ invoices: [bigger, overdue] }), 'unpaid')!
  check('a small overdue invoice is opened before a large one that is not yet due',
    r.href.endsWith('INV-OLD'), `got "${r.href}" — past the due date is a trust problem, not just an unpaid one`)
  check('the overdue day count matches the due date',
    /71 days overdue/.test(r.detail), `got "${r.detail}"`)

  // Same rows, but the ledger says nothing is overdue (no due dates) → falls
  // through to the largest balance.
  const r2 = row(run({ invoices: [inv({ invoice_number: 'INV-S', customer_name: 'Ada', amount: 50 }), inv({ invoice_number: 'INV-L', customer_name: 'Bo', amount: 5000 })] }), 'unpaid')!
  check('with nothing overdue it opens the largest balance',
    r2.href.endsWith('INV-L'), `got "${r2.href}"`)
  check('and says so without claiming a due date it does not have',
    /awaiting payment/.test(r2.detail) && !/overdue/.test(r2.detail), `got "${r2.detail}"`)

  // THE reason the overlay is called rather than comparing due_date to today:
  // a DRAFT has a due date but nobody has been asked to pay yet, so it is not
  // late. Only the ledger knows that. This is the check that fails if someone
  // "simplifies" the overlay call into `due_date < today`.
  const draftRow = row(run({ invoices: [inv({ invoice_number: 'INV-D', customer_name: 'Eve', amount: 400, status: 'draft', due_date: '2026-01-01' })] }), 'drafts')!
  check('a draft with a long-past due date is NOT called overdue',
    !/overdue/.test(draftRow.detail) && /drafted, not sent/.test(draftRow.detail),
    `got "${draftRow.detail}" — an invoice the customer has never seen cannot be late`)

  // An invoice with no due date must never be chased ahead of one that is late.
  const mixed = row(run({ invoices: [
    inv({ invoice_number: 'INV-NODATE', customer_name: 'Undated', amount: 9000 }),
    inv({ invoice_number: 'INV-LATE', customer_name: 'Late', amount: 20, due_date: '2026-08-01' }),
  ] }), 'unpaid')!
  check('an undated invoice sorts behind an overdue one, however large',
    mixed.href.endsWith('INV-LATE'), `got "${mixed.href}" — undated is never overdue, so it is never the one to chase first`)

  // "Is this invoice overdue?" already has an owner. A local date comparison here
  // would be a SECOND answer to it — the exact shape of drift this codebase keeps
  // paying for — and for a draft (past due date, never sent) it would be a wrong
  // one. Behaviour alone cannot catch the swap while the two agree, so the
  // structure is pinned instead.
  const ENGINE = readFileSync(join(process.cwd(), 'src/lib/dashboard/priorities.ts'), 'utf8')
  // Comments stripped first: this file EXPLAINS the rule it must not implement,
  // and a scan that reads its own prose flags the documentation as the defect.
  const CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('overdue is asked of the ledger overlay',
    /displayInvoiceStatus\(forLedger\(best\), settings, today\) === 'overdue'/.test(CODE))
  check('and the queue never hand-rolls its own due-date comparison',
    !/due_date\s*[<>]=?\s*today|today\s*[<>]=?\s*\w*\.?due_date/.test(CODE),
    'a local `due_date < today` is a second overdue rule that will drift from the pill on the Invoices page')
  check('the comment-stripping really did leave code behind',
    CODE.includes('export function computePriorities'),
    'if the strip ate the file the check above would pass for the wrong reason')
}

// ── 3. Records that must NEVER surface ──────────────────────────────────────
console.log('\nSettled and withdrawn money stays out of the queue:')
{
  // A cancelled invoice keeps its FULL balance — cancelling requires nothing
  // paid — so `balance > 0` is TRUE on it. This has already put a live Stripe
  // link on a withdrawn bill once; the queue must exclude by STATUS.
  const cancelled = inv({ invoice_number: 'INV-X', customer_name: 'Gone', amount: 800, status: 'cancelled' })
  check('a cancelled invoice does not become an unpaid row',
    row(run({ invoices: [cancelled] }), 'unpaid') === undefined,
    'cancelled keeps its whole balance — status is the only guard that works here')
  check('…and the fixture really does have money outstanding (so the check means something)',
    invoiceBalance(cancelled, null).balance > 0.01,
    'if the fixture had a zero balance this test would pass for the wrong reason')

  check('a paid invoice does not become an unpaid row',
    row(run({ invoices: [inv({ amount: 500, amount_paid: 500, status: 'paid' })] }), 'unpaid') === undefined,
    'paid invoices surfacing as unpaid is the queue crying wolf about money already in the bank')

  check('a part-paid invoice DOES surface, for the remainder',
    row(run({ invoices: [inv({ invoice_number: 'INV-P', customer_name: 'Pat', amount: 500, amount_paid: 200, status: 'partial' })] }), 'unpaid')?.value === 300,
    'the row must chase what is left, not the historical total')

  check('a draft invoice is a "send", never an "unpaid"',
    row(run({ invoices: [inv({ status: 'draft', amount: 200 }) ] }), 'unpaid') === undefined
    && row(run({ invoices: [inv({ status: 'draft', amount: 200 })] }), 'drafts') !== undefined,
    'an invoice the customer has never seen is not late')

  // An accepted quote whose job was CANCELLED is unscheduled again; a live job
  // means it is handled.
  const q = quote({ id: 'qA', status: 'accepted', customer_name: 'Rae', total: 700 })
  check('an accepted quote with a live job is not "needs scheduling"',
    row(run({ quotes: [q], jobs: [{ id: 'j1', quote_id: 'qA', status: 'scheduled', scheduled_date: '2026-08-20' }] as never }), 'unscheduled') === undefined)
  check('an accepted quote whose only job was cancelled IS',
    row(run({ quotes: [q], jobs: [{ id: 'j1', quote_id: 'qA', status: 'cancelled', scheduled_date: '2026-08-20' }] as never }), 'unscheduled') !== undefined,
    'a cancelled job must not read as scheduled — the work still has no date')
}

// ── 4. One obligation, one row ──────────────────────────────────────────────
console.log('\nThe same obligation never appears twice:')
{
  // A customer awaiting a reply is a LEAD (the higher tier). The messages row
  // must not bill the owner for the same inbox a second time.
  const leads: LeadResponseReport = {
    items: [{ key: 'r-1', source: 'reply', name: 'Dana', at: '2026-08-10T09:00:00Z', customerId: 'cDana', href: '/dashboard/messages?c=cDana' }],
    total: 1, bySource: { website: 0, reply: 1, booking: 0 }, oldestHours: 5,
  }
  const rows = run({ leads, conversations: [{ unread: 2, customer_id: 'cDana' }] })
  check('a customer counted as a lead is not counted again as unread messages',
    row(rows, 'messages') === undefined,
    'two rows, one inbox, one person — the queue telling the owner to do one thing twice')
  check('a DIFFERENT unread conversation still gets its row',
    row(run({ leads, conversations: [{ unread: 2, customer_id: 'cDana' }, { unread: 1, customer_id: 'cOther' }] }), 'messages') !== undefined)

  check('the lead row leads with the person, not the tally',
    row(rows, 'leads')?.label === 'Respond to Dana', `got "${row(rows, 'leads')?.label}"`)
  check('and opens the door the leads engine chose for that lead',
    row(rows, 'leads')?.href === '/dashboard/messages?c=cDana')
}

// ── 4b. Every lead SOURCE has a door that opens the person it names ─────────
// Driving the real leads engine, because the queue passes its href straight
// through: whatever this returns is what the owner's tap actually opens.
console.log('\nEach lead source opens the lead, not a list to search:')
{
  const conv = (c: Record<string, unknown>) => ({
    id: 'k1', customer_id: 'cX', lead_status: null, last_direction: 'inbound',
    last_message_at: '2026-08-10T09:00:00Z', created_at: '2026-08-10T09:00:00Z',
    snoozed_until: null, customers: { name: 'Lori' }, ...c,
  })
  const only = (pre: Parameters<typeof computeLeadsNeedingResponse>[0]) =>
    computeLeadsNeedingResponse(pre, new Date(`${TODAY}T12:00:00Z`)).items[0]

  eq('an awaiting-reply lead opens that conversation',
    only({ conversations: [conv({})] as never, quotes: [] })?.href,
    '/dashboard/messages?c=cX')
  eq('a website lead opens the website-lead filter',
    only({ conversations: [conv({ lead_status: 'new' })] as never, quotes: [] })?.href,
    '/dashboard/messages?f=website_lead')
  eq('a booking opens the draft quote that answers it',
    only({ conversations: [], quotes: [{ id: 'qB', status: 'draft', lead_meta: {}, customer_id: 'cB', customer_name: 'Bo', created_at: '2026-08-10T09:00:00Z' }] as never })?.href,
    '/dashboard/quotes/qB')

  // An anonymous inbound has no customer to focus on. It must fall back rather
  // than build `?c=null` — a link that silently opens nothing.
  const anon = only({ conversations: [conv({ customer_id: null })] as never, quotes: [] })
  eq('an inbound with no customer falls back to the plain inbox',
    anon?.href, '/dashboard/messages')
}

// ── 5. Half-known records degrade, they do not guess ────────────────────────
console.log('\nA record it cannot name falls back to the count row:')
{
  for (const [what, bad] of [
    ['no invoice_number', inv({ invoice_number: null, customer_name: 'Sarah', amount: 400 })],
    ['no customer_name', inv({ invoice_number: 'INV-9', customer_name: null, amount: 400 })],
    ['a blank customer_name', inv({ invoice_number: 'INV-9', customer_name: '   ', amount: 400 })],
  ] as [string, PriorityInvoice][]) {
    const r = row(run({ invoices: [bad] }), 'unpaid')!
    check(`${what} → the old count row, and a list href`,
      r.label === 'Collect unpaid invoices' && r.href === '/dashboard/invoices',
      `got "${r.label}" → "${r.href}"`)
    check(`${what} → nothing renders as "null"/"undefined"`,
      !/null|undefined|’s invoice/.test(`${r.label}${r.detail}${r.href}`),
      `got "${r.label}" / "${r.detail}" / "${r.href}"`)
  }
  check('a quote with no customer name still yields a schedulable row',
    row(run({ quotes: [quote({ id: 'qN', status: 'accepted', customer_name: '' })] }), 'unscheduled')?.href === '/dashboard/schedule')
}

// ── 6. The tier order the engine documents is the order you get ─────────────
console.log('\nRanking is unchanged — opening on a record did not re-rank anything:')
{
  const rows = run({
    invoices: [inv({ amount: 5, invoice_number: 'INV-1', customer_name: 'A' })],
    quotes: [quote({ id: 'qB', status: 'accepted', customer_name: 'B', total: 17_000 })],
    leads: { items: [{ key: 'w-1', source: 'website', name: 'C', at: '2026-08-08T00:00:00Z', customerId: 'c', href: '/dashboard/messages?f=website_lead' }], total: 1, bySource: { website: 1, reply: 0, booking: 0 }, oldestHours: 72 },
  })
  eq('a $5 unpaid invoice still outranks everything', rows[0]?.kind, 'unpaid')
  eq('a 3-day-old lead still outranks $17k of unscheduled work', rows[1]?.kind, 'leads')
  eq('…and that unscheduled work is third', rows[2]?.kind, 'unscheduled')
  check('the value adder is still clamped inside the tier gap',
    (rows[2]?.score ?? 0) < (rows[1]?.score ?? 0),
    'an unclamped adder silently inverts the documented order')
}

// ── 7. Nothing to do is an EMPTY queue, never an invented row ───────────────
console.log('\nAn empty book produces an empty queue:')
{
  eq('no data → no rows', run({}).length, 0)
  check('a fully-paid book produces no money rows',
    run({ invoices: [inv({ amount: 100, amount_paid: 100, status: 'paid' })] }).length === 0)
}

// ── 8. Missed visits: the shared predicate, and the boundary ────────────────
console.log('\nisMissed stays one predicate shared with the schedule board:')
{
  check('yesterday, still open → missed', isMissed({ scheduled_date: '2026-08-10', status: 'scheduled' }, TODAY))
  check('TODAY is not missed', !isMissed({ scheduled_date: TODAY, status: 'scheduled' }, TODAY),
    'a job scheduled for today has not been missed yet — an off-by-one here nags every morning')
  check('a completed past job is not missed', !isMissed({ scheduled_date: '2026-08-01', status: 'completed' }, TODAY))
  check('a cancelled past job is not missed', !isMissed({ scheduled_date: '2026-08-01', status: 'cancelled' }, TODAY))
}

// ── 9. A failed read must not paint an empty queue ──────────────────────────
console.log('\nThe loader still refuses to render a morning it did not read:')
{
  const DATA = readFileSync(join(process.cwd(), 'src/lib/dashboard/data.ts'), 'utf8')
  const throwIdx = DATA.indexOf('if (failure) throw new Error')
  check('every read is checked and one failure throws',
    throwIdx > 0, 'the all-or-throw gate is the only thing between an outage and "You’re all caught up"')
  check('the gate sits BEFORE the queue is computed',
    throwIdx > 0 && throwIdx < DATA.indexOf('computePriorities({'),
    'a gate after the derivation would let a failed read build the rows first')
  check('the invoice read still selects the identity columns the rows name',
    /select\('id, amount, status, amount_paid, discount_type, discount_value, due_date, invoice_number, customer_name, viewed_at'\)/.test(DATA),
    'drop these and every money row silently reverts to the vague count form')
}

// ── 10. The component renders "+N more" as text, not a second action ────────
console.log('\nThe row keeps exactly one destination:')
{
  const C = readFileSync(join(process.cwd(), 'src/components/dashboard/TodaysPriorities.tsx'), 'utf8')
  check('more is rendered', /\+\{p\.more\} more/.test(C))
  check('the row has ONE <Link> and the "+N more" is not another one',
    (C.match(/<Link/g) || []).length === 1,
    'a second link per row is the card-wall failure mode creeping back')
  check('only rendered when there ARE others',
    /p\.more != null && p\.more > 0/.test(C),
    '"+0 more" on a single-record row is noise')
}

if (failures) {
  console.log(`\n❌ verify:priority-queue — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:priority-queue — every row names one record and opens that record\n')
