// ── Mobile field mode guard — `npm run verify:field-mode` ────────────────────
//
// Session 54's contract, pinned. Everything here was MEASURED first, on the
// deployed build at 375 × 844 with a real 11-visit day:
//
//   the first card's Start        y = 1735  → 939px of scrolling
//   its Route to (directions)     y = 1781  → 985px
//   its Crew chat                 y = 1873  → 1077px
//   the whole day board           6.6 screens · 171 controls · 12 per card
//   a Customer lookup from the shell        → 0 one-tap doors
//   the + sheet                   4 rows, 2 of them navigation, 0 context
//
// Two halves, both offline and deterministic:
//
//   1. THE ENGINE, executed. lib/quickAdd is pure, so the context rules are
//      asserted by RUNNING them — not by grepping the sheet that renders them.
//   2. THE SURFACES, read. The reach decisions live in markup, and each one is
//      a single edit away from being undone by someone who does not know what it
//      cost to find. Each check says what breaks if it fails.
//
// ⛔ This guard does NOT re-measure pixels. Pixel truth needs a browser and lives
// in scripts/fieldmode-cdp.mjs; a guard that pretends to know a y-coordinate
// from source would be the most confident wrong answer in the suite.

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')
// ⚠️ CRLF: `.` does not match `\r`, so a `//.*$` stripper leaves the carriage
// return behind and every later anchored regex silently misses. Normalise first.
const stripComments = (s: string) =>
  s.replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

// ═══ 1. The Quick Add engine, actually run ═══════════════════════════════════
console.log('\n═══ ONE Quick Add, and it knows where it is ═══')
{
  const { quickAddActions, readJobPanel, jobPanelAnchorId } =
    require('../src/lib/quickAdd') as typeof import('../src/lib/quickAdd')
  const ALL = new Set(['schedule', 'customers', 'quotes', 'accounting', 'invoices', 'payments'])

  // — Global: the three doors that are always true, and nothing else.
  const global = quickAddActions({ kind: 'none' }, ALL)
  check('with no context it offers exactly Quote · Visit · Customer',
    global.map(a => a.key).join(',') === 'quote,visit,customer',
    global.map(a => a.key).join(',') || '(nothing)')
  check('…and every one of them CREATES something',
    global.every(a => /\/new|\?new=1|\/dashboard\/schedule$/.test(a.href)),
    `${global.map(a => a.href).join(' · ')} — a create sheet that navigates teaches nobody what + means`)
  check('…and none of them claims a context it does not have',
    global.every(a => !a.contextual && !/customer=/.test(a.href)))

  // — Customer: the brief's own example. A quote started from a profile must
  //   arrive knowing whose profile it was.
  const cust = quickAddActions(
    { kind: 'customer', customerId: 'c-1', customerName: 'Sarah Kevol', propertyId: 'p-9' }, ALL)
  const q = cust.find(a => a.key === 'quote')
  check('from a customer, Quote carries that customer',
    !!q && q.href.includes('customer=c-1'), q?.href ?? '(no quote action)')
  check('…and the property, when the profile knows one',
    !!q && q.href.includes('property=p-9'), q?.href ?? '')
  check('…and it SAYS whose it is', q?.sub === 'for Sarah Kevol', q?.sub ?? '')
  const v = cust.find(a => a.key === 'visit')
  check('from a customer, Visit carries them too',
    !!v && v.href.includes('customer=c-1'), v?.href ?? '')
  check('…and "Customer" stays the blank door it has to be',
    cust.find(a => a.key === 'customer')?.href === '/dashboard/customers?new=1',
    'adding someone new can never be prefilled with someone who already exists')

  // — Job: an action that cannot work is not offered. This is the honesty rule
  //   the whole module exists for; a disabled row explained by a toast is worse.
  const scheduled = quickAddActions({ kind: 'job', jobId: 'j-1', status: 'scheduled', customerId: 'c-1', customerName: 'Sarah' }, ALL)
  check('a SCHEDULED visit offers no work-time door (nothing has been worked)',
    !scheduled.some(a => a.key === 'work-time'), scheduled.map(a => a.key).join(','))
  check('…and no cost door (JobCostPanel does not mount until it is completed)',
    !scheduled.some(a => a.key === 'job-cost'), scheduled.map(a => a.key).join(','))
  const running = quickAddActions({ kind: 'job', jobId: 'j-1', status: 'in_progress' }, ALL)
  check('an UNDERWAY visit offers Work time, pointed at itself',
    running.find(a => a.key === 'work-time')?.href === '/dashboard/schedule?job=j-1&panel=time',
    running.find(a => a.key === 'work-time')?.href ?? '(absent)')
  check('…but still no cost door', !running.some(a => a.key === 'job-cost'))
  const doneJob = quickAddActions({ kind: 'job', jobId: 'j-1', status: 'completed' }, ALL)
  check('a COMPLETED visit offers both, each pointed at itself',
    doneJob.find(a => a.key === 'work-time')?.href === '/dashboard/schedule?job=j-1&panel=time'
    && doneJob.find(a => a.key === 'job-cost')?.href === '/dashboard/schedule?job=j-1&panel=cost',
    doneJob.map(a => `${a.key}→${a.href}`).join(' · '))
  check('visit-scoped doors come FIRST — they are why the sheet was opened here',
    doneJob[0].key === 'work-time' && doneJob[1].key === 'job-cost',
    doneJob.map(a => a.key).join(','))

  // — The module gate. Turning a module off must remove its create door too, or
  //   the + starts offering things Settings says this business does not have.
  const noQuotes = quickAddActions({ kind: 'none' }, new Set(['schedule', 'customers']))
  check('a hidden module takes its create door with it',
    !noQuotes.some(a => a.key === 'quote'), noQuotes.map(a => a.key).join(','))
  check('…and with everything off there is nothing to offer',
    quickAddActions({ kind: 'none' }, new Set()).length === 0)
  const noAccounting = quickAddActions({ kind: 'job', jobId: 'j', status: 'completed' }, new Set(['schedule', 'quotes', 'customers']))
  check('…including the cost door when Accounting is off',
    !noAccounting.some(a => a.key === 'job-cost'), noAccounting.map(a => a.key).join(','))

  // — An empty param is a lie: it says "this door knows a customer" and it does
  //   not. A blank ?customer= also reaches pages that branch on its presence.
  const blank = quickAddActions({ kind: 'job', jobId: 'j', status: 'scheduled', customerId: '', customerName: '' }, ALL)
  check('an unknown customer produces NO customer param, not an empty one',
    blank.every(a => !/customer=(&|$)/.test(a.href)),
    blank.map(a => a.href).join(' · '))

  // — The panel vocabulary, shared by the door and the page that lands.
  check('only the two real panels are honoured',
    readJobPanel('time') === 'time' && readJobPanel('cost') === 'cost'
    && readJobPanel('nonsense') === null && readJobPanel(null) === null,
    'an unknown panel must open the form normally, never fail')
  check('the anchors the deep link scrolls to are named once',
    jobPanelAnchorId('time') === 'job-work-sessions' && jobPanelAnchorId('cost') === 'job-cost')
}

// ═══ 2. The + is wired to that engine, and only to it ════════════════════════
console.log('\n═══ The + renders the engine, and the page tells it where it is ═══')
{
  const nav = stripComments(read('src/components/layout/BottomNav.tsx'))
  const sheet = stripComments(read('src/components/layout/QuickAdd.tsx'))
  check('the sheet asks lib/quickAdd what to offer', /quickAddActions\(ctx, enabled\)/.test(sheet),
    'a second list of actions here is how the + and the guard start disagreeing')
  check('the nav no longer keeps a hand-written action list',
    !/QUICK_ACTIONS/.test(nav),
    'that list was four links with no context — the whole defect this replaced')
  check('there is exactly ONE + in the shell',
    (nav.match(/aria-label="Create"/g) || []).length === 1,
    'six floating buttons is the outcome the brief ruled out')
  check('the sheet reads the published context', /useQuickAddContext\(\)/.test(sheet))
  for (const [surface, file] of [
    ['the customer profile', 'src/app/dashboard/customers/[id]/page.tsx'],
    ['the day board', 'src/app/dashboard/schedule/page.tsx'],
  ] as const) {
    check(`${surface} publishes what it is showing`,
      /usePublishQuickAddContext\(/.test(stripComments(read(file))),
      'without this the + on this surface is blank — the customer/visit is dropped')
  }
  const provider = stripComments(read('src/components/layout/QuickAddProvider.tsx'))
  check('an unmounted surface stops publishing',
    /return \(\) => publish\(null\)/.test(provider),
    'navigating away would leave the + prefilled with the record you just left')
  const layout = stripComments(read('src/app/dashboard/layout.tsx'))
  check('the provider wraps BOTH the page and the nav',
    /<QuickAddProvider>[\s\S]*<main[\s\S]*<BottomNav \/>[\s\S]*<\/QuickAddProvider>/.test(layout),
    'they must share one provider or the nav can never see what a page published')
}

// ═══ 3. Reach: the four field destinations, and Home's new door ══════════════
console.log('\n═══ What a thumb can reach ═══')
{
  const nav = stripComments(read('src/components/layout/BottomNav.tsx'))
  const bar = stripComments(read('src/components/layout/Sidebar.tsx'))
  check('Customers has a bottom-nav tab',
    /moduleKey: 'customers', href: '\/dashboard\/customers'/.test(nav),
    'MEASURED: a customer lookup had ZERO one-tap doors — only the top-right hamburger')
  for (const key of ['schedule', 'quotes', 'messages']) {
    check(`…and ${key} kept its tab`, new RegExp(`moduleKey: '${key}'`).test(nav),
      'reach was added, not traded')
  }
  check('Home moved to the logo rather than disappearing',
    /<Link href="\/dashboard" aria-label="Home"[\s\S]{0,240}\{logo\}/.test(bar),
    'Home gave up a tab; if the logo is not a link it is now only in the drawer')
  check('the top bar no longer duplicates Messages',
    !/href="\/dashboard\/messages"/.test(bar.split('Desktop sidebar')[0].split('Mobile drawer')[0]),
    'two doors to one place, one of them out of thumb reach, is not redundancy worth a slot')
  check('the nav still marks itself as bottom chrome',
    /data-eq-bottom-chrome/.test(nav),
    'lib/dropdownPlacement reads this to keep a combobox off the bar — see verify:mobile-save')
}

// ═══ 4. The field bar answers the field's five questions ════════════════════
console.log('\n═══ The next stop, and what it takes to do it ═══')
{
  const bar = stripComments(read('src/components/schedule/FieldStopBar.tsx'))
  const page = stripComments(read('src/app/dashboard/schedule/page.tsx'))
  check('the page uses the shared bar', /<FieldStopBar/.test(page))
  // ⚠️ These three were mutation-tested and MISSED their first time. Asserting
  // that `directionsUrl` and `job.notes` merely APPEAR in the file passes
  // happily while the control that used them is deleted — the identifier
  // survives in the href builder and in `const note = job.notes…`. What matters
  // is that each is RENDERED, so that is what is asserted now.
  check('WHERE: directions, from the same engine the card uses',
    /href=\{directionsUrl\(/.test(bar) && /Directions\s*<\/a>/.test(bar)
    // …and shown whenever there is anywhere to go — not gated off behind a
    // constant, which is how a control disappears while its code stays put.
    && /\{hasWhere && \(/.test(bar),
    'MEASURED: the card\'s "Route to" sat at y=1781 — 985px of scrolling')
  check('WHO: the customer can be called from the bar',
    /href=\{`tel:\$\{phone\}`\}/.test(bar) && /Call\s*\n?\s*<\/a>/.test(bar))
  check('WHAT TO KNOW: the crew note is shown',
    /\{note && \(/.test(bar) && /\{note\}<\/span>/.test(bar),
    'gate code, where to park, the dog — the reason you read the visit at all')
  check('WHAT WAS SAID: the crew conversation, not the customer thread',
    /<VisitConversation/.test(bar) && !/api\/comms\/send/.test(bar),
    '⛔ two audiences; a gate code must never reach an SMS from this bar')
  check('WHAT NEXT: Stop stays a first-class button beside Complete',
    /PauseCircle[\s\S]{0,200}Stop/.test(bar) && /CheckCircle2[\s\S]{0,80}Complete/.test(bar),
    'Stop behind an overflow is how a crew completes a job to get out of the rain')
  check('the three states are still told apart',
    /On the clock/.test(bar) && /Underway · stopped/.test(bar) && /Next stop/.test(bar),
    'a visit underway with nobody on the clock is neither of the other two')
  // ⚠️ Mutation-tested: the first version of this check ORed two patterns, and
  // the loose one matched `const [chat, setChat] = useState(false)` on the next
  // line — so flipping `open` to true passed. One exact declaration, no OR.
  check('the details start CLOSED',
    /const \[open, setOpen\] = useState\(false\)\r?\n/.test(bar),
    'a panel that opens itself covers the board it summarises')
  check('a new stop never inherits the last one\'s open panel',
    /setOpen\(false\); setChat\(false\) \}, \[job\.id\]\)/.test(bar))
  check('the conversation sheet tracks the LIVE viewport (dvh)',
    /supports-\[max-height:1dvh\]:max-h-\[\d+dvh\]/.test(bar) && /max-h-\[\d+vh\]/.test(bar),
    'vh is the URL-bar-hidden height — the composer would sit behind browser chrome')
  check('…and pays the home-indicator inset itself',
    /pb-\[max\([\d.]+rem,env\(safe-area-inset-bottom\)\)\]/.test(bar))
  check('the unread badge comes from the board, not a second query',
    /onChatUnread/.test(page) && /onChatUnread/.test(stripComments(read('src/components/schedule/DayOpsPanel.tsx'))),
    'two queries for one answer is how two surfaces disagree about a waiting message')
}

// ═══ 5. The card wall folds on a phone — without losing a field door ════════
console.log('\n═══ The day-board card at 375px ═══')
{
  const panel = stripComments(read('src/components/schedule/DayOpsPanel.tsx'))
  // The doors that change the WORK, and the one that gets you there, are
  // buttons at EVERY width. MEASURED: 12 controls per card, 347px tall.
  for (const [label, re] of [
    ['Stop for today', /label="Stop for today"/],
    ['Complete', /label="Complete"/],
    ['Start', /label="Start"/],
    ['Route to', /Route to/],
  ] as const) {
    const m = panel.match(re)
    const around = m ? panel.slice(Math.max(0, m.index! - 260), m.index! + 60) : ''
    check(`${label} is never folded away`, !!m && !/hidden sm:inline-flex/.test(around),
      'this is a door someone standing on site uses; a menu is not where it lives')
  }
  for (const label of ['Photos', 'Message', 'Services']) {
    check(`${label} folds into More on a phone`,
      new RegExp(`className="hidden sm:inline-flex"[^>]*label=(\\{?)[^>]*${label}`).test(panel)
      || new RegExp(`hidden sm:inline-flex[\\s\\S]{0,200}${label}`).test(panel),
      'it opens an inline panel — not what a thumb reaches for in a driveway')
    check(`…and is still reachable there`,
      new RegExp(`key: 'p-${label.toLowerCase()}'[^}]*className: 'sm:hidden'`).test(panel),
      'folded and NOT in the menu means the capability was deleted, not moved')
  }
  check('unread crew messages stay on the card, unfolded',
    /!chatUnread\[job\.id\] && 'hidden sm:inline-flex'/.test(panel),
    'an unread count is news, and news does not go behind a menu')
  check('the folded twins exist only below sm',
    !/key: 'p-[a-z]+'(?![^}]*className: 'sm:hidden')/.test(panel),
    'without sm:hidden the same action appears twice on desktop')
  check('the action button can be folded at all',
    /'hidden sm:inline-flex'|className\?: string/.test(panel) && /inline-flex items-center justify-center gap-1/.test(panel),
    'a base `flex` would beat `hidden` and un-fold every one of them')
}

// ═══ 6. The customer profile leads with the four actions on a phone ═════════
console.log('\n═══ Call · Message · Quote · Schedule, before the dossier ═══')
{
  const p = stripComments(read('src/app/dashboard/customers/[id]/page.tsx'))
  check('the actions are ordered ahead of the dossier strip on phones',
    /order-2 sm:order-3 grid grid-cols-2/.test(p) && /order-3 sm:order-2/.test(p),
    'MEASURED: Call sat at y=380 under up to eight metadata chips')
  check('…and the desktop order is put back at sm',
    /sm:order-3/.test(p) && /sm:order-2/.test(p))
  check('the reorder cannot break the spacing it rides on',
    /<CardBody className="flex flex-col gap-4">/.test(p),
    'space-y hangs its margin on DOM order, which `order` then moves out from under')
  for (const a of ['Call', 'Message', 'New quote', 'Schedule']) {
    check(`${a} is still one of the four`, new RegExp(`> ${a}\\s*<`).test(p) || p.includes(`> ${a}`))
  }
}

// ═══ 7. Duration speaks in units everywhere it is asked for ═════════════════
console.log('\n═══ A number and the unit it is spoken in ═══')
{
  const qb = stripComments(read('src/components/quotes/QuoteBuilder.tsx'))
  check('a quote line sizes work with the same control the job form uses',
    /<DurationField/.test(qb),
    'a two-day line was "960" in a box labelled (min) — arithmetic before an estimate')
  check('…and still stores plain minutes',
    /name=\{`services\.\$\{i\}\.est_minutes`/.test(qb),
    'the unit is how the number is SAID; the column is unchanged')
  check('…against THIS business\'s workday, never 24 hours',
    /workdayMinutes\(settings\?\.daily_capacity_hours\)/.test(qb))
  check('the old raw-minutes box is gone', !/label="Duration \(min\)"/.test(qb))
}

// ═══ 8. Nothing here fakes a write that has not happened ════════════════════
console.log('\n═══ Poor signal is told, not hidden ═══')
{
  const page = stripComments(read('src/app/dashboard/schedule/page.tsx'))
  // The field bar's primary calls the SAME engines the card does, so the
  // offline honesty those already carry applies to it unchanged. Pinned because
  // a "faster" bar that wrote directly would lose all of it silently.
  check('the bar\'s primary runs the page\'s own start/complete/resume',
    /await completeJob\(fieldNext\)/.test(page) && /await resumeJob\(fieldNext\)/.test(page)
    && /await startJob\(fieldNext\)/.test(page),
    'a second write path would skip queueOrRun and the undo contract with it')
  check('those engines still queue when there is no signal',
    /queueOrRun\(/.test(page) && /outcome === 'queued'/.test(page),
    'a completed job that never synced must say so, not look done')
  const sheet = stripComments(read('src/components/layout/QuickAdd.tsx'))
  check('the + only ever navigates — it writes nothing',
    !/supabase|fetch\(/.test(sheet),
    'a create sheet that writes offline would report success for a row nobody has')

  // ⛔ Stopping for the day and resuming are NOT queued — each is a work-session
  // write plus a visit patch as one intent, and replaying that is engineering
  // this session did not do. What they MUST do is roll back and say why in words
  // a contractor in a field can act on. "Could not stop for today: Load failed"
  // is the machine blaming them for their signal.
  for (const [what, msg] of [
    ['stopping for the day', 'today’s time was not recorded'],
    ['resuming', 'the clock did not start'],
  ] as const) {
    check(`${what} names a no-signal failure as one`,
      new RegExp(`isNetworkError\\(res\\.error\\)[\\s\\S]{0,220}${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(page),
      'a rolled-back write is honest; an unreadable reason is not')
  }
  check('…and both still roll the visit back',
    (page.match(/setJobs\(prevJobs => prevJobs\.map\(j => j\.id === job\.id \? \{ \.\.\.j, \.\.\.res\.prev \} : j\)\)/g) || []).length >= 2,
    'leaving the optimistic state on screen after a failed write IS the faked write')
  check('the no-signal question has ONE definition',
    /export function isNetworkError/.test(stripComments(read('src/lib/offline/outbox.ts'))),
    'a second copy would drift from the one that decides what is safe to queue')
}

console.log(`\n${fail === 0 ? '✓' : '✗'} field mode checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
