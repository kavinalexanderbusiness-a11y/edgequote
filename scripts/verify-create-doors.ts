// ── Verify: one name per action, and creating never eats what you typed ──────
//   npm run verify:create-doors
//
// WHY THIS SCRIPT EXISTS
// An owner meets the same creation action from many places — a quote from seven
// surfaces, a job from the schedule header and the day board, scheduling from
// two controls on one customer page. That is GOOD (context is where the work
// starts) and must not be consolidated away. What it must not do is look like
// several different features:
//
//   • the same action wearing two names or two casings ("Add Job" in the page
//     header, "Add job" on the day board directly beneath it);
//   • a door that drops context the caller already had, so the form asks again;
//   • a dismissal that silently throws away a half-typed record.
//
// This guard pins the shapes and, just as importantly, RECORDS THE DOORS THAT
// ARE DELIBERATELY DIFFERENT so a future tidy-up does not flatten them.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(p)) out.push(p)
  }
  return out
}
// Owner surfaces only. Crew Mode and the customer portal have their own
// audiences and their own words.
const ownerFiles = walk(SRC)
  .map(p => p.slice(SRC.length + 1).replace(/\\/g, '/'))
  .filter(p => !p.includes('/crew/') && !p.startsWith('app/portal'))
  .map(p => ({ path: p, text: stripComments(read('src/' + p)) }))

check('the owner surface scan found files', ownerFiles.length > 150, `only ${ownerFiles.length}`)

// ── 1. One name per action ───────────────────────────────────────────────────
// Rendered labels only — this codebase documents PAST label fixes in comments,
// which a naive grep reports as live copy (that is why comments are stripped).
console.log('\n═══ The same action has one name ═══')

function labels(re: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const f of ownerFiles) {
    const seen = new Set<string>()
    for (const pat of [/>\s*([A-Z][^<>{}\n]{1,30}?)\s*</g, /(?:label|aria-label|title)="([A-Z][^"\n]{1,34})"/g]) {
      pat.lastIndex = 0
      let m
      while ((m = pat.exec(f.text))) if (re.test(m[1])) seen.add(m[1])
    }
    for (const s of seen) found.set(s, [...(found.get(s) ?? []), f.path])
  }
  return found
}

// Case-variants of one phrase are the tell: "Add Job" / "Add job" is one action
// that learned two spellings, not two features.
function noCaseVariants(name: string, re: RegExp) {
  const found = [...labels(re).keys()]
  const byLower = new Map<string, string[]>()
  for (const l of found) byLower.set(l.toLowerCase(), [...(byLower.get(l.toLowerCase()) ?? []), l])
  const variants = [...byLower.values()].filter(v => v.length > 1)
  check(`${name}: no two spellings of one label`, variants.length === 0,
    variants.map(v => v.join('  vs  ')).join(' · '))
}
noCaseVariants('quote', /^(New|Build|Create)\b.*quote/i)
noCaseVariants('job', /^Add\b.*job/i)
noCaseVariants('invoice', /^(New|Create)\b.*invoice/i)
noCaseVariants('customer', /^(New|Add|Create)\b.*customer/i)

// Two controls on the customer page start the same thing; they now say the same
// thing, in the vocabulary the rest of the app uses (a scheduled occurrence is a
// VISIT — see lib/vocabulary).
const customerPage = ownerFiles.find(f => f.path === 'app/dashboard/customers/[id]/page.tsx')!
check('customer page schedules a "visit", both times',
  !/Schedule job/.test(customerPage.text) && /Schedule a visit/.test(customerPage.text),
  'the visible link and the icon tooltip must not name one action twice')

// The builder titles itself the same as the four buttons that reach it.
check('the quote builder is titled like its doors',
  !/title="New Quote"/.test(read('src/app/dashboard/quotes/new/page.tsx')),
  'one click should not change the capitalisation of what you asked for')

// ── 2. Doors carry the context they already have ─────────────────────────────
console.log('\n═══ A door does not make you re-enter what it knows ═══')

// Every quote door either knows the customer and passes it, or genuinely does
// not have one. The bare doors are listed BY NAME so a new bare door — one that
// drops a customer it was holding — shows up here instead of in a support call.
const BARE_QUOTE_DOORS: Record<string, string> = {
  'app/dashboard/page.tsx':                'home page header — no customer is on screen yet',
  'app/dashboard/quotes/page.tsx':         'the quote list header — the list is every customer’s',
  // Same species as the quote list header: the board spans every deal, so no one
  // customer is on screen to carry. The pipeline's PER-ROW doors are not bare —
  // lib/pipeline builds every prepare_quote / renew_service href with ?customer=.
  'app/dashboard/pipeline/page.tsx':       'the pipeline header — the board is every customer’s',
  // Same species again: a report ABOUT every customer has none on screen to
  // carry. Note this covers the page header only — the Sales page's per-row
  // doors all link to the quote or invoice they describe, never to the builder.
  'app/dashboard/sales/page.tsx':          'the sales report header — the report is every customer’s',
  'components/command/CommandPalette.tsx': 'global ⌘K — reachable from anywhere, belongs to nobody',
  // Not "we forgot the customer" — there cannot be one. This card renders only
  // while the business has no customer, quote, job or invoice at all, and the
  // builder it opens creates the customer and property as it saves.
  'components/dashboard/TodaysPriorities.tsx': 'the first-run card — it only renders when the business has NO customers yet',
  // Same species: the end of first-run setup, reached before the business has
  // a single customer to carry. Its door is the first-run card's, by name.
  'app/setup/page.tsx':                    'the setup done screen — a brand-new business has no customer yet',
  // ⛔ NO ENTRY for the mobile +. It used to be listed here as
  // 'components/layout/BottomNav.tsx — global, so it cannot know a customer'.
  // That excuse expired in Session 54: the door moved into lib/quickAdd, which
  // builds `/dashboard/quotes/new` + ?customer=&property= from whatever the
  // surface underneath published, so it is no longer a bare door at all. The
  // engine is still SCANNED (QUOTE_DOOR_ENGINES below) — if anyone ever
  // hard-codes the bare path back into it, this check fails rather than shrugs.
  'components/quotes/QuoteList.tsx':       'the empty-state CTA and the "n" shortcut on the same list',
  'components/messages/LeadCard.tsx':      'looks bare, is NOT — the prefill rides in sessionStorage',
}
const bare: string[] = []
const matched = new Set<string>()
// ⚠️ The surface scan above is .tsx only, and a create door no longer has to be
// a component: lib/quickAdd builds the mobile +'s hrefs as data. A door that
// moved into an engine must not fall out of this check by changing extension,
// so the engines that emit one are scanned too — explicitly, by name.
const QUOTE_DOOR_ENGINES = ['lib/quickAdd.ts']
const quoteDoorFiles = [
  ...ownerFiles,
  ...QUOTE_DOOR_ENGINES.map(p => ({ path: p, text: stripComments(read('src/' + p)) })),
]
for (const f of quoteDoorFiles) {
  if (!/['"`]\/dashboard\/quotes\/new['"`]/.test(f.text)) continue
  if (f.path in BARE_QUOTE_DOORS) matched.add(f.path)
  else bare.push(f.path)
}
check('no quote door drops a customer it already had', bare.length === 0,
  `${bare.join(', ')} — pass ?customer= (and ?property= when known), or record it in BARE_QUOTE_DOORS with the reason`)
// An allowlist nobody prunes stops being a record of decisions and becomes
// noise — and noise is where a real bare door hides.
const stale = Object.keys(BARE_QUOTE_DOORS).filter(p => !matched.has(p))
check('the allowlist has no stale entries', stale.length === 0,
  `${stale.join(', ')} no longer link to a bare /dashboard/quotes/new — drop the entry`)

// The lead door is the one that looks bare and is not: it stashes the lead's
// customer id AND what they asked for. Merging it into a plain link would lose
// the prefill and risk a duplicate customer.
const leadCard = read('src/components/messages/LeadCard.tsx')
check('the lead door still carries its prefill',
  leadCard.includes('LEAD_PREFILL_KEY') && leadCard.includes('leadToPrefill'),
  'it pushes a bare URL on purpose — the payload rides in sessionStorage')
check('…and that payload includes the customer',
  /customerId: lead\.customer_id/.test(read('src/lib/leads.ts')),
  'without it the builder could create a SECOND customer for a known lead')

// ── 3. Dismissing a create form asks before discarding ───────────────────────
console.log('\n═══ Closing a half-typed record asks first ═══')

const schedule = read('src/app/dashboard/schedule/page.tsx')
for (const [what, re] of [
  ['the backdrop', /bg-black\/50" onClick=\{requestCloseForm\}/],
  ['Escape', /e\.key === 'Escape'\) requestCloseForm\(\)/],
  ['the X button', /onClick=\{requestCloseForm\}[^\n]*aria-label="Close"/],
  ['the form’s Cancel', /onCancel=\{requestCloseForm\}/],
] as const) {
  check(`${what} goes through the guard`, re.test(schedule),
    'every dismissal path must ask when there is something to lose')
}
check('the guard only asks when the form is dirty',
  /if \(!formDirty\.current\) \{ closeForm\(\); return \}/.test(schedule),
  'confirming on an untouched form is a nag, not a safeguard')
check('a successful save closes WITHOUT asking',
  /closeForm\(\)/.test(schedule) && !/await confirm[\s\S]{0,400}handleAdd/.test(schedule),
  'the row is already written by then — confirming would be nonsense')
check('the form reports its own dirtiness',
  /onDirtyChange=\{d => \{ formDirty\.current = d \}\}/.test(schedule)
  // S81: the report widened to include the non-RHF Repeat/Ends controls
  // (recDirty) — isDirty alone could not see them, so a touched Repeat was
  // discardable in silence. Both dirt sources, one report.
  && /onDirtyChange\?\.\(isDirty \|\| recDirty\)/.test(read('src/components/schedule/JobForm.tsx')),
  'only the form knows; the page must not guess from its props')

// The other two create forms protect typing a different way — autosave. Pinned
// so nobody "simplifies" one of them away and leaves that form unprotected.
for (const f of ['src/components/quotes/QuoteBuilder.tsx', 'src/components/customers/CustomerForm.tsx']) {
  check(`${f.split('/').pop()} still autosaves`, read(f).includes('useAutosave'),
    'this is the OTHER protection against losing a half-entered record')
}

// ── 4. Creating reports its write ────────────────────────────────────────────
console.log('\n═══ A create that failed does not look like one that worked ═══')
const addStart = schedule.indexOf('async function handleAdd')
const addRest = schedule.slice(addStart)
const addEnd = addRest.indexOf('\n  async function', 10)
check('handleAdd was located and bounded', addStart > 0 && addEnd > 0,
  'the assertions below would otherwise scan the whole page and pass on unrelated code')
const addFn = addRest.slice(0, addEnd)

// A Supabase insert RESOLVES on failure — it returns `{ error }` rather than
// throwing. An unchecked one is a job the owner believes exists.
const writes = [
  ['the one-off insert', /insert\(\{ \.\.\.base, scheduled_date[\s\S]{0,200}?if \(error\)/],
  ['the recurrence row', /from\('job_recurrences'\)[\s\S]{0,900}?if \(recError \|\| !rec\)/],
  ['the visit rows', /insert\(rows\)\s*\n\s*if \(error\)/],
] as const
for (const [what, re] of writes) {
  check(`${what} is checked`, re.test(addFn), 'an unchecked write reports success it did not have')
}
// Two rollbacks, because two things can be half-written.
check('a failed visit insert deletes the orphan recurrence',
  (addFn.match(/from\('job_recurrences'\)\s*\.delete\(\)/g) || []).length >= 2,
  'a recurrence with no visits is a series the owner can see and cannot use')
check('and the owner is told nothing was scheduled',
  /nothing was scheduled/.test(addFn),
  'half a series written and reported as success is the worst outcome here')
check('the create verifies the visits actually persisted',
  /count: 'exact', head: true/.test(addFn) && /!count \|\| count < 1/.test(addFn),
  'RLS can accept an insert and store nothing; only a read-back proves it landed')

// ── 5. Doors that are DELIBERATELY different ─────────────────────────────────
// Recorded so a future "consolidate the buttons" pass reads the reason first.
console.log('\n═══ Deliberately distinct — do not merge ═══')
const DISTINCT: [string, string, string][] = [
  ['Build quote', 'src/components/messages/LeadCard.tsx',
   'a quote PRE-FILLED from what the lead asked for — not the same as a blank one'],
  ['Create draft', 'src/components/payments/NewInvoiceDialog.tsx',
   'the submit inside "New invoice"; it names what it produces (a draft, not a sent bill)'],
  ['Take a deposit', 'src/app/dashboard/payments/page.tsx',
   'opens the panel; "Record deposit" inside it commits — disclose then commit, not two doors'],
  ['New crew', 'src/components/dispatch/CrewManager.tsx',
   'the FIELD LABEL beside the "Add crew" submit — a caption, not a rival button'],
]
for (const [label, file, why] of DISTINCT) {
  check(`"${label}" still exists — ${why.slice(0, 58)}…`, read(file).includes(label),
    `${why}. If it was renamed on purpose, update this entry.`)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:create-doors — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:create-doors — one name per action, context carried, nothing silently discarded\n')
