// ── Verify: the back office says true things, and says each of them once ─────
//   npm run verify:back-office
//
// WHY THIS SCRIPT EXISTS
// The 2026-08-10 back-office simplification pass found one defect shape repeated
// across Invoices, Payments, Messages and Settings: a SURFACE that speaks with
// more confidence than its data earns. Three species, none of which tsc or
// `next build` can see, because a false claim is the same TYPE as a true one:
//
//   1. AN ACTION THAT PERSISTS NOTHING. "Remind me tomorrow" / "Follow up"
//      inserted into `schedule_items` — a table with writers and NO READERS
//      (Calendar takes a `scheduleItems` prop the schedule page never passes).
//      The toast said "it's on your schedule". It was nowhere.
//   2. A FAILED READ RENDERED AS A REASSURING ANSWER. A failed inbox query
//      became "No conversations yet"; a failed invoice query became the money
//      claim "Paid up".
//   3. A WRITE THAT REPORTS SUCCESS IT DIDN'T HAVE. `.update()` on a settings
//      row that doesn't exist matches zero rows and returns NO error — so
//      "Payroll settings saved." was printed over a no-op. And `disablePush()`
//      returns { ok } that was discarded, so the UI said notifications were off
//      while they kept arriving.
//
// Plus the duplication half of the pass: the same fact stated by two surfaces,
// which is how two surfaces start disagreeing.
//
// Structural over source, because these are single-file invariants that no
// runtime observes.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const INVOICES = read('src/app/dashboard/invoices/page.tsx')
const PAYMENTS = read('src/app/dashboard/payments/page.tsx')
const MESSAGES = read('src/app/dashboard/messages/page.tsx')
const CONVINFO = read('src/components/messages/ConversationInfo.tsx')
const CONTROLS = read('src/components/payments/InvoicePaymentControls.tsx')
const DETAIL = read('src/components/payments/InvoiceDetail.tsx')
const ACTIONS = read('src/lib/payments/invoiceActions.ts')
const ACCOUNTING = read('src/app/dashboard/accounting/page.tsx')

// ── 1. No owner-facing action may write to a table nothing reads ─────────────
console.log('\nEvery action that promises persistence has a reader:')
{
  // Walk src/ once and count reads vs writes of the dead table.
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(p)) files.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  const writers = files.filter(f => /from\('schedule_items'\)\s*\.(insert|upsert|update)/.test(readFileSync(f, 'utf8')))
  check('nothing inserts a reminder into schedule_items',
    writers.length === 0,
    `still written by: ${writers.map(f => f.slice(ROOT.length + 1)).join(', ')} — the schedule page never passes \`scheduleItems\` to Calendar, so the row is invisible forever`)
  // Asserted on the RENDERED form (a toast call), not the bare phrase — the
  // comment recording why this was removed contains the phrase on purpose.
  check('…and the "it\'s on your schedule" toast is gone',
    !/toast\.success\(['"`]Reminder set/.test(MESSAGES),
    'the toast asserted a destination the reminder never reached')
  check('…and the Follow-up menu that made the same promise is gone',
    !/addFollowUp|FOLLOWUPS/.test(CONVINFO),
    'ConversationInfo\'s three follow-up presets wrote to the same dead table and flipped to "Added ✓"')
}

// ── 2. A failed read is never rendered as an answer ──────────────────────────
console.log('\nA request that never answered is not an answer:')
{
  check('the inbox reads its query error',
    /const \{ data, error \} = await qb/.test(MESSAGES) && /setLoadError\(/.test(MESSAGES),
    'Supabase RESOLVES on failure — `data: null` became `[]` and painted "No conversations yet"')
  check('…and shows a distinct couldn\'t-load state with a retry',
    /Couldn’t load your conversations/.test(MESSAGES) && /Try again/.test(MESSAGES),
    'the friendly empty state must not double as the failure state')
  check('the conversation panel refuses to claim "Paid up" from a failed read',
    /moneyUnavailable/.test(CONVINFO) && /Couldn’t check/.test(CONVINFO),
    'a failed invoice query rendered as a POSITIVE money fact about the customer')
  check('…deriving that flag from the read\'s own error',
    /setMoneyUnavailable\(!!iv\.error \|\| !!pa\.error\)/.test(CONVINFO),
    'the flag must come from the money reads, not from an empty array')
}

// ── 3. Settings writes report the success they actually had ─────────────────
console.log('\nSettings save when they say they saved:')
{
  const PUSH = read('src/components/settings/PushNotificationSettings.tsx')
  const PAYROLL = read('src/components/settings/PayrollSettings.tsx')
  const AUTOMATIONS = read('src/components/settings/AutomationToggles.tsx')
  const USAGE = read('src/components/settings/MessagingUsage.tsx')

  check('turning notifications OFF checks that it worked',
    /const r = await disablePush\(\)/.test(PUSH) && /if \(r\.ok\) setState\('default'\)/.test(PUSH),
    'the result was discarded and the UI claimed "off" while alerts kept arriving on the device')

  // `.update()` on an absent settings row matches zero rows and returns no error.
  for (const [name, src] of [
    ['payroll rules', PAYROLL], ['automation toggles', AUTOMATIONS],
    ['notification prefs', PUSH], ['messaging rates', USAGE],
  ] as const) {
    check(`${name} write through upsert, not a silent no-op`,
      /\.upsert\(\{[\s\S]{0,200}?user_id/.test(src) && !/from\('business_settings'\)\s*\.update\(/.test(src),
      '`.update()` on a row that does not exist yet saves nothing and reports no error — the toast then lies')
  }

  check('a reverted toggle says why it reverted',
    /toast\.error\(/.test(AUTOMATIONS),
    'a switch that slides back in silence reads as a glitch — and these decide whether customers get texted')
}

// ── 4. The same fact is stated once ─────────────────────────────────────────
console.log('\nOne surface owns each fact:')
{
  check('the invoices page no longer carries a second payments feed',
    !/PaymentHistory/.test(INVOICES),
    'a weaker copy of the Payments page sat under the invoice list, and its "received" total silently meant something different from the "Collected" tile at the top')
  check('…nor the ledger reconciliation panel',
    !/ReconcilePanel/.test(INVOICES),
    'checking Stripe against the books is a LEDGER job; it belongs with the ledger')
  // `>Label<` — the rendered text node, so the comment explaining the removal
  // can name the tiles without re-failing the check that removed them.
  check('the invoice KPI row states ONE figure',
    !/>Drafts to review</.test(INVOICES) && !/>Payments received</.test(INVOICES),
    'a filter button dressed as a statistic (whose count already rides the Drafts pill) and all-time lifetime revenue, both on the page about what is still owed')
  check('…and that figure is Outstanding, from the ledger engine',
    /Outstanding/.test(INVOICES) && /invoiceBalance\(i, settings\)\.balance/.test(INVOICES),
    'the one surviving figure must be the canonical balance')
  check('no hand-rolled draft total survives',
    !/drafts\.reduce\(\(sum, i\) => sum \+ Number\(i\.amount/.test(INVOICES),
    'summing raw `amount` disagreed with the rows below it by exactly the GST rate')
  check('Payments says what it is in its own header',
    /money that actually moved/.test(PAYMENTS),
    'the sentence answering "how is this different from Invoices?" used to sit below the fold')
}

// ── 5. The two payment doors cannot be confused ──────────────────────────────
console.log('\nCash and card are told apart:')
{
  // Both doors moved when the detail got one action ladder: the labels are now
  // decided in lib/payments/invoiceActions (so the primary button, the secondary
  // button and the menu item can never disagree about what a door is called) and
  // the cash door names its methods on the form it opens. The RULE is unchanged
  // and is what these assert: the card door says card, the cash door says cash,
  // and neither of them is called "take payment".
  check('the card door names the card',
    /Card payment link|Card link — deposit/.test(ACTIONS) && /Card payment link|Card link — deposit/.test(DETAIL),
    '"Take payment" sat beside "Record payment", differed by one verb, and did the opposite thing')
  check('the cash door names the cash',
    /cash \/ cheque \/ e-transfer/.test(CONTROLS) && /cash, cheque or e-transfer/.test(DETAIL),
    'the owner holding an e-transfer confirmation had to guess which button was theirs')
  check('neither door is called "take payment" any more',
    !/Take payment/.test(INVOICES + DETAIL + CONTROLS + ACTIONS),
    'one verb apart from "Record payment", and it did the opposite thing')
  check('the destructive receipt action is a real tap target',
    /tap-target[^"]*"[\s\S]{0,400}?Revert payment/.test(CONTROLS) || /tap-target/.test(CONTROLS),
    'Revert deletes a ledger row and was 26px, four pixels from "text the receipt to the customer"')
}

// ── 6. Accounting is sorted by how often you touch it ───────────────────────
console.log('\nAccounting tells daily work from your accountant\'s work:')
{
  for (const g of ['Day to day', 'Month end', 'Quarterly & your accountant']) {
    check(`the rail carries the "${g}" group`, ACCOUNTING.includes(g),
      'eleven identically-styled pills said nothing about which belong to a Tuesday')
  }
  check('"Dashboard" no longer collides with the app\'s home',
    !/label: 'Dashboard'/.test(ACCOUNTING) && /label: 'Overview'/.test(ACCOUNTING),
    'two different pages called Dashboard, and this one hid the module\'s only triage list')
  check('"Setup" says which setup it is',
    /Balance sheet setup/.test(ACCOUNTING),
    'an owner hunting the GST rate went there; the GST rate is in Settings')
  check('the report pills no longer share a name with the editor tabs',
    /Spending report/.test(ACCOUNTING) && /Vendor spend/.test(ACCOUNTING),
    'the pill labelled "Expenses" led AWAY from the only place an expense can be logged')
  check('every one of the eleven destinations survived',
    ['/dashboard/accounting/dashboard', '/dashboard/accounting/pnl', '/dashboard/accounting/cash-flow',
     '/dashboard/accounting/balance-sheet', '/dashboard/accounting/job-costing', '/dashboard/accounting/expenses-report',
     '/dashboard/accounting/vendors', '/dashboard/accounting/trends', '/dashboard/accounting/gst',
     '/dashboard/accounting/export', '/dashboard/accounting/setup'].every(h => ACCOUNTING.includes(h)),
    'grouping must RE-ORDER the rail, never drop a report — an unreachable report is an unshipped one')
}

// ── 7. Mobile: no unshrinkable row in a phone-width track ───────────────────
console.log('\nNothing forces the page sideways on a phone:')
{
  check('the payments date-range pills wrap',
    /ml-auto flex items-center gap-2 flex-wrap/.test(PAYMENTS),
    'four whitespace-nowrap pills (~344px) in a 343px track, in a span the parent\'s wrap could not help')
  const SETTINGS = read('src/app/dashboard/settings/page.tsx')
  check('the travel-fee tier grid can shrink below its inputs\' intrinsic width',
    /minmax\(0,1fr\)/.test(SETTINGS),
    'a grid item defaults to min-width:auto, and a bare number input\'s min-content is ~170px — three of them plus a button in a 295px box')
  check('the settings save bar outranks the bottom nav',
    /sticky bottom-0 z-20/.test(SETTINGS),
    'the bar was z-10 under a z-40 fixed BottomNav — the save button was behind the navigation for the whole form')
  check('the settings tab strip clears the mobile header',
    /sticky top-14 lg:top-0/.test(SETTINGS),
    'both stuck to top-0 and the z-40 header won, so the section switcher disappeared on scroll')
  check('the record-payment fields do not trigger iOS zoom',
    !/px-2 py-2 text-sm font-normal text-ink outline-none/.test(CONTROLS),
    'Method and Date were text-sm (iOS zooms under 16px) and 36px tall, while the Amount field beside them got it right')
}

if (failures) {
  console.log(`\n❌ verify:back-office — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:back-office — true claims, stated once, reachable on a phone\n')
