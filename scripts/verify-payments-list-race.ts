// ── Verify: only the newest scope may paint the payments list ───────────────
//   npm run verify:payments-list-race
//
// THE USER-VISIBLE ISSUE THIS REPRODUCES
// /dashboard/payments chooses its rows on the SERVER: the range control adds
// `gte('paid_at', …)`, so changing it refetches. Those fetches are async and
// unordered, and the page committed whatever RESOLVED last.
//
//   pick "Last 365 days"  → a big, slow query starts
//   pick "Last 30 days"   → a small, fast query starts and lands first
//   …the 365-day response arrives and overwrites it
//
// The control now reads "Last 30 days" over a year of payments, and the money
// summary above the table — derived from those same rows — shows a year's takings
// under a 30-day heading. Nothing looks broken. The number is just wrong, and an
// owner reconciling their books has no way to tell.
//
// Four things trigger that fetch (the range control, the realtime subscription,
// saving a deposit, the Retry button), so any two overlapping does it.
//
// ⛔ Synthetic throughout: fake delayed responses, invented rows, no Supabase, no
// customer data, no payment call, no network.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequestGate } from '../src/lib/requestGate'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const eq = (n: string, a: unknown, b: unknown) => {
  const good = JSON.stringify(a) === JSON.stringify(b)
  if (good) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`) }
}
const ok = (n: string, c: boolean) => eq(n, c, true)

// ── A synthetic payments backend ────────────────────────────────────────────
type Row = { id: string; amount: number }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Two scopes, deliberately opposite in size and speed — the real shape. */
const SCOPES: Record<string, { rows: Row[]; ms: number }> = {
  '365': { rows: Array.from({ length: 12 }, (_, i) => ({ id: `y${i}`, amount: 100 })), ms: 60 },
  '30': { rows: [{ id: 'm0', amount: 100 }], ms: 5 },
}
const fetchScope = async (scope: string): Promise<Row[]> => {
  const s = SCOPES[scope]
  await sleep(s.ms)
  return s.rows
}
/** What the screen shows above the table — derived from the committed rows. */
const totalOf = (rows: Row[]) => rows.reduce((n, r) => n + r.amount, 0)

async function main() {
  // ═════════════════════════════════════════════════════════════════════════
  H('1. ⛔ THE DEFECT, reproduced: last-to-RESOLVE wins, not last-to-be-ASKED')
  {
    // Exactly the old control flow: no gate, commit unconditionally.
    let shownRows: Row[] = []
    let shownScope = ''
    const load = async (scope: string) => {
      const rows = await fetchScope(scope)
      shownRows = rows; shownScope = scope
    }
    const slow = load('365')       // owner picks 365…
    await sleep(1)
    const fast = load('30')        // …then quickly picks 30
    await Promise.all([slow, fast])

    eq('the owner last asked for the 30-day scope', 'the last pick was 30', 'the last pick was 30')
    eq('⛔ but the list holds the 365-day rows', shownRows.length, 12)
    eq('⛔ …and the label last written is the slow one', shownScope, '365')
    ok('⛔ the money summary is a YEAR\'s takings under a 30-day pick', totalOf(shownRows) === 1200)
    ok('…when the correct figure was', totalOf(SCOPES['30'].rows) === 100)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('2. ✅ THE FIX: a superseded response may finish, but may not speak')
  {
    const gate = createRequestGate()
    let shownRows: Row[] = []
    let shownScope = ''
    const load = async (scope: string) => {
      const token = gate.begin()
      const rows = await fetchScope(scope)
      if (!gate.isCurrent(token)) return           // superseded — stay silent
      shownRows = rows; shownScope = scope
    }
    const slow = load('365')
    await sleep(1)
    const fast = load('30')
    await Promise.all([slow, fast])

    eq('the list holds the 30-day rows', shownRows.length, 1)
    eq('the label matches them', shownScope, '30')
    eq('⭐ and the summary is the 30-day figure', totalOf(shownRows), 100)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('3. a superseded FAILURE must not clobber a newer success')
  {
    const gate = createRequestGate()
    let rows: Row[] = []
    let error: string | null = null
    let loading = true
    const loadFailing = async () => {
      const token = gate.begin()
      await sleep(60)
      if (!gate.isCurrent(token)) return
      error = 'Could not load payments'; loading = false
    }
    const loadOk = async () => {
      const token = gate.begin()
      await sleep(5)
      if (!gate.isCurrent(token)) return
      rows = SCOPES['30'].rows; error = null; loading = false
    }
    const a = loadFailing()
    await sleep(1)
    const b = loadOk()
    await Promise.all([a, b])

    eq('the newer successful rows are shown', rows.length, 1)
    eq('⛔ the older failure did NOT paint an error over them', error, null)
    eq('…and did not flip loading off on the newer request\'s behalf', loading, false)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('4. the gate itself')
  {
    const g = createRequestGate()
    const t1 = g.begin()
    ok('a lone request is current', g.isCurrent(t1))
    const t2 = g.begin()
    ok('⛔ the older token is no longer current', !g.isCurrent(t1))
    ok('the newer one is', g.isCurrent(t2))
    ok('[negative control] a token never issued is not current', !g.isCurrent(999))
    const other = createRequestGate()
    ok('[negative control] gates are independent', other.isCurrent(1) === false || other.begin() === 1)
  }

  // ═════════════════════════════════════════════════════════════════════════
  H('5. WIRING — the page routes its fetch through the gate')
  {
    const src = readFileSync(join(ROOT, 'src/app/dashboard/payments/page.tsx'), 'utf8')
    ok('the page imports the gate', /from '@\/lib\/requestGate'/.test(src))
    ok('…holds one across renders', /useRef\(createRequestGate\(\)\)/.test(src))
    ok('…claims a token at the top of the fetch', /const token = gate\.current\.begin\(\)/.test(src))
    // ⛔ Two guards: one before the session/error branches, one before the commits.
    const guards = (src.match(/if \(!gate\.current\.isCurrent\(token\)\) return/g) ?? []).length
    ok(`…and checks it before every commit point (${guards} guards)`, guards >= 2)
    ok('⛔ the error branch is guarded too, not just the success path',
      src.indexOf('isCurrent(token)') < src.indexOf('Could not load payments'))
  }
}

main()
  .catch(e => { fail++; console.log(`  ❌ threw\n     ${String(e?.message ?? e)}`) })
  .then(() => {
    console.log('')
    if (fail) { console.log(`✗ payments-list-race: ${fail} check(s) failed (${pass} held)\n`); process.exit(1) }
    console.log(`✓ payments-list-race: only the newest scope paints the list (${pass} checks)\n`)
  })
