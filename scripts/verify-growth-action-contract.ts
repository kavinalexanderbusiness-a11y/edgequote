// ── verify:growth-action-contract — what the Growth action handler must promise
//
//   npm run verify:growth-action-contract
//
// ⭐ THIS IS A REVIEW INSTRUMENT, written to a CONTRACT rather than to an
// implementation, so it survives the repair it exists to check. It states the
// six behaviours a save-feedback handler owes the owner, drives them through the
// REAL committed seam (`createActionLedger` / `withRow` from
// src/lib/growthActionState, plus a stubbed `recordRecommendation`), and pins the
// page handler's own composition so a passing contract cannot drift away from the
// code that has to honour it.
//
// ⛔ TWO THINGS IT DELIBERATELY IS NOT.
//   1. It does not reimplement the ledger. Every ordering decision is made by the
//      real exported functions; a copy would only prove the copy.
//   2. It does not render the page. `act()` is a closure inside a client
//      component and there is no jsdom or test renderer in this repo, so the
//      handler's ORDER is pinned statically (§0) and its EFFECTS are exercised
//      through the seam. That boundary is stated, not blurred.
//
// ⛔ Offline and synthetic throughout: no Supabase client, no network, no record.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActionLedger, withRow, type ActionOutcome } from '../src/lib/growthActionState'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0, open = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
/** A contract item the current tip does not meet yet — reported, not counted as a pass. */
const owed = (name: string, met: boolean, detail: string) => {
  if (met) { pass++; console.log(`  ✓ ${name}`) }
  else { open++; console.log(`  ⚠ OWED  ${name}\n      ${detail}`) }
}
const H = (t: string) => console.log(`\n── ${t} ──\n`)
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

type Row = { opportunity_key: string; status: string }
const row = (key: string, status: string): Row => ({ opportunity_key: key, status })

// ── A driver that composes the REAL seam the way the handler does ────────────
// Deferred promises stand in for the network so every interleaving is exact.
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Save = { ok: boolean; error?: string }

function makeDriver() {
  const ledger = createActionLedger<Row>()
  let feedback: Record<string, Row> = {}
  let busy: string[] = []
  const writes: { key: string; status: string }[] = []
  const pending: ReturnType<typeof deferred<Save>>[] = []
  let lastError: string | null = null

  /** The stubbed import seam. One entry per attempted write — this is what
   *  proves whether same-key overlap happened. */
  const recordRecommendation = (key: string, status: string) => {
    writes.push({ key, status })
    const d = deferred<Save>()
    pending.push(d)
    return d.promise
  }

  /** The handler's composition, in the order §0 pins it to. */
  async function act(key: string, status: string) {
    const optimistic = row(key, status)
    const seq = ledger.begin(key, optimistic, feedback[key])
    lastError = null
    busy = ledger.pendingKeys()
    feedback = withRow(feedback, key, ledger.display(key))
    let outcome: ActionOutcome
    try {
      const r = await recordRecommendation(key, status)
      outcome = r.ok ? { ok: true } : { ok: false, error: r.error }
    } catch (e) {
      outcome = { ok: false, error: String((e as Error)?.message ?? e) }
    }
    const settled = ledger.settle(key, seq, outcome)
    feedback = withRow(feedback, key, settled.display)
    busy = ledger.pendingKeys()
    if (settled.failed && !settled.superseded) lastError = `failed:${key}`
    return settled
  }

  return {
    act,
    seed: (key: string, r: Row) => { feedback = withRow(feedback, key, r) },
    /** A refresh landing: what load() does with the server's feedback map. */
    refresh: (server: Record<string, Row>) => { feedback = { ...server } },
    settle: (i: number, v: Save) => pending[i].resolve(v),
    throwAt: (i: number, msg: string) => pending[i].reject(new Error(msg)),
    state: () => ({ feedback: { ...feedback }, busy: [...busy], writes: [...writes], lastError }),
  }
}
const tick = () => new Promise(r => setTimeout(r, 0))

// ═══════════════════════════════════════════════════════════════════════════
function section0() {
  H('0 · the page handler still composes the seam this contract drives')
  // If the handler stops using these in this order, the driver above is no
  // longer a faithful stand-in and every result below would be about nothing.
  const page = read('src/app/dashboard/revenue-intelligence/page.tsx')
  const order = ['ledger.begin(', 'recordRecommendation(', 'ledger.settle(']
  let at = -1, sequential = true
  for (const token of order) {
    const i = page.indexOf(token, at + 1)
    if (i < 0 || i < at) { sequential = false; break }
    at = i
  }
  check('act() calls begin → recordRecommendation → settle, in that order', sequential,
    'the driver in this file mirrors that composition; if it changes, re-mirror it')
  check('it imports the real ledger seam, not a local copy',
    /from '@\/lib\/growthActionState'/.test(page))
  check('the busy set is derived from the ledger, not tracked separately',
    /pendingKeys\(\)/.test(page))
}

async function section1() {
  H('1 · independent keys run concurrently')
  const d = makeDriver()
  const a = d.act('k1', 'acted'), b = d.act('k2', 'won')
  await tick()
  const s = d.state()
  check('both keys are in flight at once', s.busy.length === 2 && s.writes.length === 2,
    JSON.stringify(s.busy))
  check('each shows its own optimistic row',
    s.feedback.k1?.status === 'acted' && s.feedback.k2?.status === 'won')
  d.settle(0, { ok: true }); d.settle(1, { ok: true })
  await a; await b
  check('both settle clean, nothing left busy', d.state().busy.length === 0)
}

async function section2() {
  H('2 · rapid taps on ONE key')
  const d = makeDriver()
  const first = d.act('k1', 'acted')
  await tick()
  const second = d.act('k1', 'won')
  await tick()
  const s = d.state()
  owed('⭐ a second tap does NOT start an overlapping write on the same key',
    s.writes.length === 1,
    `${s.writes.length} writes issued for one key while the first was pending — S111 asked for a `
    + 'synchronous per-key latch so two saves for one row can never be in flight together. '
    + 'Reconciling afterwards cannot work: RESPONSE ARRIVAL ORDER DOES NOT REVEAL COMMIT ORDER.')
  // Whatever the repair chooses, these must hold.
  d.settle(0, { ok: true })
  if (s.writes.length > 1) d.settle(1, { ok: true })
  await first; await second
  const e = d.state()
  check('after both answers the key is no longer busy', e.busy.length === 0)
  check('the card ends on the LAST action the owner asked for',
    e.feedback.k1?.status === 'won', JSON.stringify(e.feedback.k1))
}

async function section3() {
  H('3 · a failed save returns to the row that was really there')
  const d = makeDriver()
  d.seed('k1', row('k1', 'acted'))          // a row the server already acknowledged
  const p = d.act('k1', 'won')
  await tick()
  check('the card shows the optimistic row while saving', d.state().feedback.k1?.status === 'won')
  d.settle(0, { ok: false, error: 'denied' })
  await p
  const s = d.state()
  check('⛔ it reverts to the PRIOR acknowledged row, not to blank',
    s.feedback.k1?.status === 'acted', JSON.stringify(s.feedback.k1))
  check('and the failure is surfaced', s.lastError === 'failed:k1')

  const d2 = makeDriver()                    // no prior row at all
  const p2 = d2.act('k9', 'won')
  await tick(); d2.settle(0, { ok: false }); await p2
  check('with no prior row, the key is cleared rather than left showing a lie',
    d2.state().feedback.k9 === undefined)
}

async function section4() {
  H('4 · resolve · reject · and the outcome nobody can know')
  const d = makeDriver()
  const p = d.act('k1', 'acted'); await tick(); d.settle(0, { ok: true }); await p
  check('ok:true keeps the new row', d.state().feedback.k1?.status === 'acted')

  const d2 = makeDriver()
  const p2 = d2.act('k1', 'acted'); await tick(); d2.throwAt(0, 'network down'); await p2
  check('a thrown connection error still settles the card (no stuck spinner)',
    d2.state().busy.length === 0)

  // ⛔⛔ THE CLAIM A CLIENT CANNOT MAKE. A throw means the ANSWER was lost, not
  // that the write was. The row may well be committed.
  const page = read('src/app/dashboard/revenue-intelligence/page.tsx')
  owed('⭐ a thrown/timed-out save does not claim "nothing was recorded"',
    !/nothing was recorded/i.test(page),
    'page.tsx tells the owner "nothing was recorded" on every failure INCLUDING a throw. '
    + 'A dropped connection cannot distinguish "never reached the server" from "committed, '
    + 'answer lost" — the honest wording for that branch is that the result is unknown and '
    + 'will be reconciled, not a promise about the database.')
  owed('an ambiguous outcome is representable at all',
    /'unknown'|unknown:|ambiguous/i.test(read('src/lib/growthActionState.ts')),
    'ActionOutcome is { ok: true } | { ok: false } — two states for three real outcomes '
    + '(saved / refused / unknown). The third has nowhere to go, so it is reported as the second.')
}

async function section5() {
  H('5 · a refresh landing mid-action')
  const d = makeDriver()
  d.seed('k1', row('k1', 'acted'))
  const p = d.act('k1', 'won')
  await tick()
  // load() resolving now: it sets feedback from the server, which has not seen
  // the pending write yet.
  d.refresh({ k1: row('k1', 'acted') })
  const mid = d.state()
  owed('⭐ a refresh does not discard the pending optimistic row',
    mid.feedback.k1?.status === 'won',
    'load() does setFeedback(res.feedback) unconditionally, so a refresh that lands while a '
    + 'save is in flight replaces the pending card with the server row — the owner watches '
    + 'their tap undo itself. The ledger still holds the attempt; the page just stopped showing it.')
  d.settle(0, { ok: true })
  await p
  check('once it settles the acknowledged row is shown', d.state().feedback.k1?.status === 'won')
}

async function main() {
  section0()
  await section1(); await section2(); await section3(); await section4(); await section5()
  console.log(
    open > 0
      ? `\n⚠ growth-action-contract: ${pass} met, ${open} OWED by the repair, ${fail} failed\n`
      : fail === 0
        ? `\n✓ growth-action-contract: ${pass} checks passed\n`
        : `\n✗ growth-action-contract: ${fail} failed, ${pass} passed\n`)
  // ⛔⛔ AN OWED ITEM EXITS NON-ZERO. A guard that reports an unmet contract and
  // then returns 0 is dead safety that reads as green — exactly what this lane
  // keeps finding elsewhere, and it would apply to me too. This file lives on an
  // isolated review branch, so a red here reddens nobody else; it turns green the
  // moment the repair meets the contract.
  process.exit(fail === 0 && open === 0 ? 0 : 1)
}
main()
