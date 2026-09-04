// ── Verify: the signals→engine date handshake ───────────────────────────────
//   npm run verify:cron-tenant-time
//
// WHY THIS SCRIPT EXISTS
// `cron/signals` (11:00 UTC) stamps `automation_signals.detected_on` with each
// TENANT's calendar date. `cron/engine` (11:30 UTC) reads those rows back. The
// first version of this fix moved the writer alone and left the reader matching on
// the SERVER's date — which reads zero rows, silently, for exactly the tenants the
// fix exists to serve. Both halves of that contract now live in
// `src/lib/cron/tenantDay.ts`, and this guard drives THAT.
//
// ⭐⭐ WHAT IS TESTED HERE vs WHAT IS ASSERTED
//   • §1–§4 are BEHAVIOUR. They call the same functions both routes call, with
//     fixed instants, and assert what the pair would actually conclude.
//   • §5 is WIRING, and says so. A Next App Router `route.ts` may export only HTTP
//     handlers and recognised config, so the routes cannot be imported and driven
//     directly; what §5 pins is that each route still routes its dates through the
//     lib §1–§4 proves. It is deliberately narrow — reverting either route to its
//     old date source fails it.
//
// ⛔ Deliberately NOT re-tested here: `safeTimeZone`'s fallback, two zones
// disagreeing on one instant, and the DST-length helpers. `scripts/verify-tenant-time.ts`
// already owns all three, and a second copy would drift rather than protect.
//
// ⛔ Pure: no network, no database, no clock of its own. Every instant is fixed.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ownerDateISO, signalDatesFor, serverDateWindow, acceptTenantSignals, PRODUCER_LOOKBACK_MS,
} from '../src/lib/cron/tenantDay'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const eq = (n: string, a: unknown, b: unknown) => {
  const good = JSON.stringify(a) === JSON.stringify(b)
  if (good) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`) }
}
const ok = (n: string, c: boolean) => eq(n, c, true)

// The real schedule (vercel.json): signals `0 11 * * *`, engine `30 11 * * *`.
const WRITER = new Date('2026-06-15T11:00:00Z')
const READER = new Date('2026-06-15T11:30:00Z')

const EDM = 'America/Edmonton'     // UTC−6 — the only live tenant today
const CHATHAM = 'Pacific/Chatham'  // UTC+12:45 in June: local midnight lands at 11:15 UTC

// ═══════════════════════════════════════════════════════════════════════════
H('1. ⛔ TENANT MIDNIGHT BETWEEN THE TWO RUNS — the case per-tenant dates alone still lose')
{
  const written = ownerDateISO(CHATHAM, WRITER)
  const readerOwnDate = ownerDateISO(CHATHAM, READER)

  eq('the writer stamps the tenant day it was still on', written, '2026-06-15')
  eq('30 minutes later the tenant has rolled over', readerOwnDate, '2026-06-16')
  ok('⛔ so equality on per-tenant dates would MISS the row', written !== readerOwnDate)

  // …which is why the consumer accepts a bounded SET, not a single date.
  const accepted = signalDatesFor(CHATHAM, READER)
  eq('the consumer accepts both sides of that midnight', accepted, ['2026-06-15', '2026-06-16'])
  ok('⭐ and therefore accepts what the writer actually wrote', accepted.includes(written))
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. ⛔ NOT WIDENED FOR ANYONE ELSE — an ordinary tenant is still read exactly once')
{
  const accepted = signalDatesFor(EDM, READER)
  eq('a tenant with no midnight in the lookback gets ONE date', accepted, ['2026-06-15'])
  eq('…the same date its producer stamped', accepted[0], ownerDateISO(EDM, WRITER))
  ok('…so nothing from an earlier day becomes eligible again', accepted.length === 1)

  // The lookback is a lookback, not a day. If it ever reached 24h every signal
  // would be eligible on two runs and the evaluation log would silently double.
  ok('⛔ the lookback stays well under a day', PRODUCER_LOOKBACK_MS < 24 * 60 * 60 * 1000)
  eq('…and covers the real 30-minute schedule gap with slack', PRODUCER_LOOKBACK_MS >= 30 * 60 * 1000, true)
}

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE FULL HANDSHAKE — the rows the engine would actually keep')
{
  // One row per tenant, each stamped by the producer at ITS instant, exactly as
  // cron/signals would have written them.
  const rows = [
    { user_id: 'edm', detected_on: ownerDateISO(EDM, WRITER), signal: 'churn_risk' },
    { user_id: 'cha', detected_on: ownerDateISO(CHATHAM, WRITER), signal: 'churn_risk' },
    { user_id: 'unset', detected_on: ownerDateISO(null, WRITER), signal: 'churn_risk' },
    // A genuinely old row that must NOT be resurrected.
    { user_id: 'edm', detected_on: '2026-06-12', signal: 'recurring_ran_out' },
  ]
  const zones = new Map([['edm', EDM], ['cha', CHATHAM]])   // 'unset' deliberately absent

  const kept = acceptTenantSignals(rows, zones, READER)
  eq('the ordinary tenant’s row is kept', kept.some(r => r.user_id === 'edm' && r.signal === 'churn_risk'), true)
  eq('⭐ the midnight-straddling tenant’s row is kept', kept.some(r => r.user_id === 'cha'), true)
  eq('a tenant with no zone on record is kept via the shared fallback', kept.some(r => r.user_id === 'unset'), true)
  eq('⛔ the three-day-old row is DROPPED', kept.some(r => r.detected_on === '2026-06-12'), false)
  eq('…and nothing else was invented', kept.length, 3)

  // ⛔ THE REGRESSION, made concrete: a consumer that matched only its own
  // per-tenant date — the "obvious" fix — silently loses the straddler.
  const naive = rows.filter(r => r.detected_on === ownerDateISO(zones.get(r.user_id) ?? null, READER))
  eq('⛔ a same-date-only consumer drops the straddling tenant', naive.some(r => r.user_id === 'cha'), false)
  ok('⛔ …which is the silent data loss this guard exists to prevent', naive.length < kept.length)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE DATABASE PREFILTER — bounded, and never narrower than the truth')
{
  const win = serverDateWindow(READER)
  eq('three dates, server ±1', win, ['2026-06-14', '2026-06-15', '2026-06-16'])
  // Every zone on earth is within ±14h of UTC, so no tenant date can fall outside.
  for (const tz of [EDM, CHATHAM, 'Pacific/Kiritimati', 'Etc/GMT+12', 'Asia/Kolkata', 'UTC']) {
    ok(`prefilter covers ${tz}`, signalDatesFor(tz, READER).every(d => win.includes(d)))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
H('5. WIRING — each route still routes its dates through the lib above')
{
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  const producer = read('src/app/api/cron/signals/route.ts')
  const consumer = read('src/app/api/cron/engine/route.ts')

  // ⛔ Reverting the WRITER to the server clock fails here.
  ok('the producer imports the shared derivation', /from '@\/lib\/cron\/tenantDay'/.test(producer))
  ok('…and dates each owner with it', /ownerDateISO\(owner\.timezone, now\)/.test(producer))
  // ⚠️ The IMPORT, not the word. The route's own comment explains what it used to
  // call, so a bare /localTodayISO/ matched its documentation — a guard that fails
  // on its subject's prose is testing the wrong thing.
  ok('⛔ …and no longer imports the server clock',
    !/import \{[^}]*\blocalTodayISO\b[^}]*\} from/.test(producer))

  // ⛔ Reverting the READER to the exact server-date match fails here.
  ok('the consumer imports the shared selection', /acceptTenantSignals|serverDateWindow/.test(consumer))
  ok('…and prefilters on the bounded window', /\.in\('detected_on', serverDateWindow\(now\)\)/.test(consumer))
  ok('…and decides per tenant with the shared rule', /acceptTenantSignals\(fetched, zones, now\)/.test(consumer))
  ok('⛔ …and no longer matches detected_on against one server date',
    !/\.eq\('detected_on'/.test(consumer))
  ok('…and reads detected_on at all, which the old select did not',
    /select\('id, user_id, signal, subject_type, subject_id, detected_on'\)/.test(consumer))

  // ⛔⛔ THE SEND GATE MUST SURVIVE THIS FIX. The consumer can now reach a tenant's
  // zone, which makes a real `hour` computable for the first time — and passing one
  // would satisfy gate (1) of the three that keep `fired` unreachable. A date fix
  // must never arm the engine as a side effect.
  ok('⛔ the engine still passes hour: \'unknown\' (send gate 1 intact)',
    /hour: 'unknown'/.test(consumer))
  // ⚠️ Again the declaration, not the word — "dispatch" appears throughout this
  // route's header explaining precisely why it cannot send.
  ok('⛔ …and DISPATCHERS is still empty (send gate 3 intact)',
    /const DISPATCHERS: Record<string, unknown> = Object\.create\(null\)/.test(consumer))
  ok('⛔ …and nothing is ever assigned into it',
    !/DISPATCHERS\[/.test(consumer) && !/Object\.assign\(DISPATCHERS/.test(consumer))
}

console.log('')
if (fail) { console.log(`✗ cron-tenant-time: ${fail} check(s) failed (${pass} held)\n`); process.exit(1) }
console.log(`✓ cron-tenant-time: the signals→engine date handshake holds (${pass} checks)\n`)
