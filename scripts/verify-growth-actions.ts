// ── Verify: a Growth card never keeps "Acted" / "Won" for a save that did not happen ──
//   npm run verify:growth-actions
//
// recordRecommendation answers { ok: false } when the upsert is refused and
// throws when the connection drops. The page used to ignore both: the
// optimistic badge stayed, and after a throw `busy` stayed set forever. The
// rule that now decides what a card shows lives in lib/growthActionState and is
// exercised here with synthetic outcomes in every interleaving that matters —
// including two cards at once and two taps on one card whose answers arrive
// out of order — then the page is pinned to actually route through it.
//
// ⛔ FIXTURE DATA ONLY. No database, no network, no browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActionLedger, withRow } from '../src/lib/growthActionState'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

type Row = { opportunity_key: string; status: string }
const row = (key: string, status: string): Row => ({ opportunity_key: key, status })
const REFUSED = { ok: false as const, error: 'row-level security' }
const OK = { ok: true as const }

console.log('\n── 1. A failed save restores what the server last acknowledged ──')
{
  const L = createActionLedger<Row>()
  const seq = L.begin('renewal:A', row('renewal:A', 'won'), undefined)      // never acted before
  eq('the tap shows optimistically', L.display('renewal:A'), row('renewal:A', 'won'))
  const s = L.settle('renewal:A', seq, REFUSED)
  eq('ok:false → back to no feedback at all (the key is deleted)', s.display, undefined)
  check('…reported as a failure the owner must hear about', s.failed && !s.superseded, JSON.stringify(s))
  eq('…and the card is no longer busy', L.pendingKeys(), [])
}
{
  const L = createActionLedger<Row>()
  const loaded = row('renewal:B', 'acted')                                  // acted yesterday, loaded from the server
  const seq = L.begin('renewal:B', row('renewal:B', 'won'), loaded)
  const s = L.settle('renewal:B', seq, REFUSED)
  eq('with a loaded row, a failure restores THAT row — not nothing', s.display, loaded)
}
{
  // The page maps a throw to ok:false before the ledger sees it; the ledger's
  // contract is the same either way. withRow is the map edit the page applies.
  const L = createActionLedger<Row>()
  const seq = L.begin('k', row('k', 'dismissed'), undefined)
  const s = L.settle('k', seq, { ok: false, error: 'TypeError: fetch failed' })
  eq('a dismissed card whose save threw comes back (the key is removed from the map)', withRow({ k: row('k', 'dismissed'), other: row('other', 'won') }, 'k', s.display), { other: row('other', 'won') })
}

console.log('\n── 2. Two cards at once: one failure never touches the other ──')
{
  const L = createActionLedger<Row>()
  const a = L.begin('A', row('A', 'acted'), undefined)
  const b = L.begin('B', row('B', 'won'), undefined)
  eq('both busy while both are in flight', L.pendingKeys().sort(), ['A', 'B'])
  const sa = L.settle('A', a, REFUSED)
  eq('A fails → A restored', sa.display, undefined)
  eq('…B untouched and still optimistic', L.display('B'), row('B', 'won'))
  eq('…only B still busy', L.pendingKeys(), ['B'])
  const sb = L.settle('B', b, OK)
  eq('B succeeds → B confirmed', sb.display, row('B', 'won'))
  eq('nothing busy', L.pendingKeys(), [])
}

console.log('\n── 3. Two taps on one card, answers out of order ──')
{
  // (a) first save confirmed, second refused → back to the FIRST (acknowledged), not to nothing
  const L = createActionLedger<Row>()
  const s1 = L.begin('K', row('K', 'acted'), undefined)
  L.settle('K', s1, OK)
  const s2 = L.begin('K', row('K', 'won'), row('K', 'acted'))
  const r = L.settle('K', s2, REFUSED)
  eq('acted (ok) then won (refused) → shows acted, the acknowledged state', r.display, row('K', 'acted'))
  check('…and the failure is reported (it was the newest tap)', r.failed && !r.superseded, '')
}
{
  // (b) the OLDER save fails AFTER the newer one succeeded → the newer success stands
  const L = createActionLedger<Row>()
  const s1 = L.begin('K', row('K', 'acted'), undefined)
  const s2 = L.begin('K', row('K', 'won'), undefined)
  L.settle('K', s2, OK)
  const r = L.settle('K', s1, REFUSED)
  eq('an old failure does not overwrite the newer success', r.display, row('K', 'won'))
  check('…and is superseded — no error is shown for it', r.failed && r.superseded, JSON.stringify(r))
}
{
  // (c) the NEWER save fails while the older is still in flight, then the older succeeds
  const L = createActionLedger<Row>()
  const s1 = L.begin('K', row('K', 'acted'), undefined)
  const s2 = L.begin('K', row('K', 'won'), undefined)
  const r2 = L.settle('K', s2, REFUSED)
  eq('newest refused → the card shows the older tap still in flight', r2.display, row('K', 'acted'))
  check('…reported (it was the newest)', r2.failed && !r2.superseded, '')
  const r1 = L.settle('K', s1, OK)
  eq('the older save is then acknowledged → it is the truth', r1.display, row('K', 'acted'))
  eq('nothing busy afterwards', L.pendingKeys(), [])
}
{
  // (d) both fail → back to the loaded state, error shown once (for the newest)
  const L = createActionLedger<Row>()
  const loaded = row('K', 'acted')
  const s1 = L.begin('K', row('K', 'won'), loaded)
  const s2 = L.begin('K', row('K', 'dismissed'), loaded)
  const r1 = L.settle('K', s1, REFUSED)
  check('older failure while newer pending: superseded, card still shows the newer tap', r1.superseded && JSON.stringify(r1.display) === JSON.stringify(row('K', 'dismissed')), JSON.stringify(r1))
  const r2 = L.settle('K', s2, REFUSED)
  eq('newer failure → back to the loaded row', r2.display, loaded)
  check('…and THIS one is reported', r2.failed && !r2.superseded, '')
}
{
  // (e) acknowledgement order beats tap order: the older tap acknowledged LATER committed later
  const L = createActionLedger<Row>()
  const s1 = L.begin('K', row('K', 'acted'), undefined)
  const s2 = L.begin('K', row('K', 'won'), undefined)
  L.settle('K', s2, OK)
  const r = L.settle('K', s1, OK)
  eq('the later-acknowledged save is what the server holds, so it is what the card shows', r.display, row('K', 'acted'))
}

console.log('\n── 4. The page routes through the ledger and reports the failure ──')
{
  const src = readFileSync(join(process.cwd(), 'src/app/dashboard/revenue-intelligence/page.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
  const act = (code.match(/async function act\([\s\S]*?\n  \}/) || [''])[0]
  check('act() begins an attempt and shows the ledger\'s display, not a hand-written optimistic row', /ledger\.begin\(o\.key, row, feedback\[o\.key\]\)/.test(act) && /withRow\(prev, o\.key, ledger\.display\(o\.key\)\)/.test(act), '')
  check('…reads recordRecommendation\'s answer instead of discarding it', /r\.ok \? \{ ok: true \} : \{ ok: false, error: r\.error \}/.test(act), '')
  check('…and turns a throw into a failed outcome (no unhandled rejection, no stuck busy)', /catch \(e\) \{\s*outcome = \{ ok: false/.test(act), '')
  check('…settles and shows exactly what the ledger says', /ledger\.settle\(o\.key, seq, outcome\)/.test(act) && /withRow\(prev, o\.key, settled\.display\)/.test(act), '')
  check('…reports only a failure that was the newest tap on its card', /if \(settled\.failed && !settled\.superseded\)[\s\S]{0,80}setActionError\(/.test(act), '')
  check('busy is per card, from the ledger', /busy=\{busyKeys\.has\(o\.key\)\}/.test(code) && !/busy === o\.key/.test(code), '')
  check('the failure line is an alert above the cards, naming the tap and the customer', /role="alert"[^>]*>\{actionError\}/.test(code) && /Couldn't save "\$\{ACTION_LABEL\[status\]\}" for \$\{o\.customerName\}/.test(code), '')
  check('a successful refresh resets the ledger (the server\'s feedback is the new baseline)', /ledgerRef\.current = createActionLedger<FeedbackRow>\(\)/.test(code), '')
}

console.log(failures === 0 ? '\n✅ growth actions: a badge is only ever what the server acknowledged or a save still in flight\n' : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
