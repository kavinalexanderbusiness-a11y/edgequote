// ── Verify: first-run setup says what's required, what's optional, and where next ──
//   npm run verify:first-use-setup
//
// WHY THIS SCRIPT EXISTS
// /setup is the first screen a brand-new business sees. It asked for two things
// without saying which one mattered: the primary button waited on the trade
// alone, the name was optional, and nothing said either. And its done screen
// ended at "Go to your dashboard" — one screen before the dashboard's own
// first-run card asked for the first quote anyway. This guard pins the three
// facts that fix that, and the one cross-file fact that keeps the new door
// honest with verify:create-doors (a bare quote door must be recorded by name).
//
// Source-level because the subject is a page's wiring — a Next page cannot
// export a helper to drive, and the decision is one boolean read off the seed
// state. \r is stripped first so a CRLF checkout cannot invert an absence
// check; comments are stripped so a comment documenting the fix is never
// mistaken for the fix.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SETUP = stripComments(src('src/app/setup/page.tsx'))
const PRIORITIES = stripComments(src('src/components/dashboard/TodaysPriorities.tsx'))
const SEED = stripComments(src('src/lib/onboarding/seed.ts'))
const LAYOUT = stripComments(src('src/app/dashboard/layout.tsx'))
const DOORS = src('scripts/verify-create-doors.ts')

// ═══════════════════════════════════════════════════════════════════════════
H('1. the business name is optional, and says so')
// The Input's own hint slot, so a screen reader hears it with the field
// (aria-describedby is wired inside Input), not a stray paragraph.
const nameField = /<Input label="Business name"[\s\S]{0,400}?\/>/.exec(SETUP)?.[0] ?? ''
check('the name field exists', nameField.length > 0)
const hint = /hint=\{configured \? undefined : '([^']+)'\}/.exec(nameField)?.[1] ?? ''
check('the name field carries a hint', hint.length > 0, 'hint={configured ? undefined : \'…\'} not found on the Business name Input')
check('the hint leads with "Optional"', /^Optional\b/.test(hint), hint)
check('the hint says where the name can be changed later', /Settings/.test(hint), hint)
check('the reseed surface keeps its unhinted field (gated on `configured`)', /hint=\{configured \? undefined/.test(nameField))
// What makes "optional" TRUE: the primary button waits on the trade alone.
check('the primary button waits on the trade alone', /disabled=\{!picked\}/.test(SETUP))
check('the name never gates the primary button', !/disabled=\{[^}]*\bname\b[^}]*\}/.test(SETUP))

// ═══════════════════════════════════════════════════════════════════════════
H('2. the trade choice and optional skip are explained once')
const REQ = 'Choose a trade to load starter services, or skip for now.'
const reqCount = SETUP.split(REQ).length - 1
check('the requirement is stated exactly once', reqCount === 1, `found ${reqCount}`)
check('…only for a first run (the reseed surface says nothing new)',
  new RegExp(`\\{!configured && \\(\\s*<p[^>]*>${REQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>\\s*\\)\\}`).test(SETUP))
const iLabel = SETUP.indexOf('What kind of work do you do?')
const iReq = SETUP.indexOf(REQ)
const iGrid = SETUP.indexOf('TRADE_PACKS.map')
check('…between the section label and the trade grid', iLabel > 0 && iReq > iLabel && iGrid > iReq)
// Skip is an honest exit: it records the neutral type when no trade was picked,
// and the name only if typed. Selecting a trade loads its starter services.
check('Skip for now requires no pick (neutral type when none)', /business_type: picked \|\| 'general'/.test(SETUP))
check('Skip for now requires no name (written only if typed)', /if \(trimmed\) row\.company_name = trimmed/.test(SETUP))

// ═══════════════════════════════════════════════════════════════════════════
H('3. the done screen sends a first run to its first quote')
const iDone = SETUP.indexOf('if (result?.ok) {')
const iDoneReturn = SETUP.indexOf('return (', iDone)
const iFirstRun = SETUP.indexOf('const firstRun = !state.hasSettingsRow')
check('`firstRun` is decided inside the done branch, before it renders',
  iDone > 0 && iFirstRun > iDone && iDoneReturn > iFirstRun)
// The signal is the dashboard gate's own: "no business_settings row" is what
// sends an account to /setup in the first place, and what the seed state reads.
check('…from the same fact the dashboard gate redirects on (no settings row)',
  /hasSettingsRow: !!s\b/.test(SEED) && /if \(!bizErr && !bizRow\) redirect\('\/setup'\)/.test(LAYOUT))

const pickReturn = /return\s*\(\s*<Shell\s+wide\s*>/.exec(SETUP)
const iPick = pickReturn?.index ?? -1
check('the done-region boundary exists after its return', iPick > iDoneReturn && iDoneReturn > iDone)
const done = iPick > iDoneReturn ? SETUP.slice(iDone, iPick) : ''
const iBranch = done.indexOf('{firstRun ? (')
const iElse = done.indexOf(') : (', iBranch)
const iEnd = done.indexOf(')}', iElse)
check('the done screen branches on `firstRun`', iBranch > 0 && iElse > iBranch && iEnd > iElse)
const firstArm = done.slice(iBranch, iElse)
const elseArm = done.slice(iElse, iEnd)
const door = /router\.push\('\/dashboard\/quotes\/new'\); router\.refresh\(\) \}\}>([^<]+?)\s*<ArrowRight/.exec(firstArm)
check('a first run\'s primary action opens the quote builder, then refreshes (the layout re-reads the row)', !!door)
check('…under the dashboard first-run card\'s exact label',
  (door?.[1] ?? '').trim() === 'Create your first quote' && PRIORITIES.includes('>Create your first quote<'),
  `setup says "${(door?.[1] ?? '').trim()}"`)
check('a first run keeps the dashboard as its secondary action',
  /variant="secondary"[^>]*onClick=\{\(\) => \{ router\.push\('\/dashboard'\); router\.refresh\(\) \}\}>Go to your dashboard</.test(firstArm))
check('a configured business (reseed) still returns to its dashboard',
  /router\.push\('\/dashboard'\); router\.refresh\(\) \}\}>Go to your dashboard/.test(elseArm))
check('…and keeps its Review services button', /href="\/dashboard\/settings\/templates"[\s\S]{0,120}?Review services/.test(elseArm))
check('a first run keeps a door to the starter prices only when something was seeded',
  /\{firstRun && result\.seeded\.services > 0 && \([\s\S]{0,400}?href="\/dashboard\/settings\/templates"/.test(done))

// ═══════════════════════════════════════════════════════════════════════════
H('4. the new bare door is recorded where bare doors are audited')
// verify:create-doors scans every owner surface for a bare /dashboard/quotes/new
// and fails on any it does not know by name. This page now has one; it is a
// bare door for the same reason the first-run card's is — there is no customer
// yet — and the allowlist must say so or the other guard goes red.
const iMap = DOORS.indexOf('const BARE_QUOTE_DOORS')
const iMapEnd = DOORS.indexOf('\n}', iMap)
const mapBody = iMap > 0 && iMapEnd > iMap ? DOORS.slice(iMap, iMapEnd) : ''
check('verify:create-doors knows this door by name', /'app\/setup\/page\.tsx':\s*'[^']{20,}'/.test(mapBody))
const bareCount = (SETUP.match(/'\/dashboard\/quotes\/new'/g) ?? []).length
check('the page has exactly one bare quote door', bareCount === 1, `found ${bareCount}`)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) {
  console.log('\n❌ verify:first-use-setup — the first-run setup screen has drifted\n')
  process.exit(1)
}
console.log('\n✅ verify:first-use-setup — first-run setup says what is required, what is optional, and where next\n')
