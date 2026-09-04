// ── Verify: every requested tenant's zone is actually loaded ────────────────
//   npm run verify:tenant-zone-loader
//
// WHY THIS SCRIPT EXISTS
// `loadTenantZones` issued ONE unranged query and returned a bare Map. Two silent
// failures came out of that, both found in review:
//
//   1. PostgREST caps a read at 1000 rows. Tenant 1001 onward simply was not in the
//      map, and every one of them then resolved to the FALLBACK zone — the same
//      1001st-owner silent drop `cron/signals` already pages against.
//   2. A FAILED read returned an empty map, indistinguishable from "these tenants
//      have no zone set". Three of the four callers send customer messages off the
//      date derived from that map, so one failed query could chase, expire, or
//      report an entire book on the wrong calendar day.
//
// ⭐⭐ THE DISTINCTION THIS GUARD EXISTS TO HOLD: a tenant with no zone is a
// DOCUMENTED FALLBACK; a read that failed is NOT. Both leave the map short, and
// only `ok` tells them apart.
//
// ⭐ The loader is driven for real against a stub that implements the actual
// PostgREST chain (`from().select().in().order().range()`), so pagination and
// batching are observed as issued requests rather than asserted about. §6 is
// wiring, and says so: routes cannot be imported (Next constrains route exports),
// so what is pinned there is that every caller checks `ok` before dating anyone.
//
// ⛔ Pure: no network, no database, no live cron. Nothing is sent.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadTenantZones, todayForTenant, ZONE_PAGE_ROWS, ZONE_ID_BATCH,
} from '../src/lib/tenantTimeServer'
// FALLBACK_TIME_ZONE lives in tenantTime; tenantTimeServer consumes it but does not
// re-export it. Importing it from the wrong module yielded `undefined`, which the
// section-5 assertion caught before this guard was ever trusted.
import { FALLBACK_TIME_ZONE } from '../src/lib/tenantTime'

const ROOT = join(__dirname, '..')
let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const eq = (n: string, a: unknown, b: unknown) => {
  const good = JSON.stringify(a) === JSON.stringify(b)
  if (good) { pass++; console.log(`  ✅ ${n}`) }
  else { fail++; console.log(`  ❌ ${n}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`) }
}
const ok = (n: string, c: boolean) => eq(n, c, true)

type Req = { ids: string[] | null; from: number; to: number }
type Resp = { data: { user_id: string; timezone: string | null }[] | null; error: { message: string } | null }

/** A stub shaped like the real PostgREST builder chain the loader uses. */
function stub(respond: (r: Req) => Resp) {
  const calls: Req[] = []
  const client = {
    from() {
      let ids: string[] | null = null
      const b = {
        select() { return b },
        in(_c: string, v: string[]) { ids = v; return b },
        order() { return b },
        range(from: number, to: number) {
          const req: Req = { ids, from, to }
          calls.push(req)
          return Promise.resolve(respond(req))
        },
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const rowsFor = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ user_id: `t${String(offset + i).padStart(5, '0')}`, timezone: 'Pacific/Auckland' }))

// ⚠️ Wrapped: tsx transforms this file to CJS, where top-level `await` is a
// syntax error. The summary runs inside the chain so a throw is still counted.
async function main() {
// ═══════════════════════════════════════════════════════════════════════════
H('1. ⛔ MORE THAN ONE PAGE — the 1001st tenant must not vanish')
{
  const TOTAL = 2500
  const { client, calls } = stub(({ from }) => {
    const remaining = Math.max(0, TOTAL - from)
    return { data: rowsFor(Math.min(ZONE_PAGE_ROWS, remaining), from), error: null }
  })
  const res = await loadTenantZones(client)
  eq('the read succeeded', res.ok, true)
  eq(`all ${TOTAL} tenants came back, not just the first page`, res.zones.size, TOTAL)
  ok('⭐ the 1001st tenant is present', res.zones.has('t01000'))
  ok('…and so is the last', res.zones.has('t02499'))
  eq('it took three pages', calls.length, 3)
  eq('…each a bounded range', calls.map(c => [c.from, c.to]), [[0, 999], [1000, 1999], [2000, 2999]])

  // [negative control] a single unranged read — the OLD behaviour — stops at 1000.
  const oldStyle = rowsFor(ZONE_PAGE_ROWS, 0)
  ok('⛔ [negative control] one page alone would have lost tenant 1001',
    !new Map(oldStyle.map(r => [r.user_id, r.timezone])).has('t01000'))
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE ID LIST IS BATCHED — a long in.(…) becomes a URL, not an answer')
{
  const ids = Array.from({ length: 450 }, (_, i) => `t${String(i).padStart(5, '0')}`)
  const { client, calls } = stub(({ ids: got, from }) =>
    from > 0 ? { data: [], error: null }
             : { data: (got ?? []).map(u => ({ user_id: u, timezone: 'America/Edmonton' })), error: null })
  const res = await loadTenantZones(client, ids)
  eq('every requested tenant resolved', res.zones.size, 450)
  ok('no batch exceeds the cap', calls.every(c => (c.ids?.length ?? 0) <= ZONE_ID_BATCH))
  eq('the batches cover the whole request exactly once',
    [...new Set(calls.flatMap(c => c.ids ?? []))].length, 450)
  ok('…and it really was split', calls.filter(c => c.from === 0).length > 1)
}

// ═══════════════════════════════════════════════════════════════════════════
H('3. ⛔⛔ A FAILED READ IS NOT A FALLBACK — the two absences must not look alike')
{
  const { client } = stub(() => ({ data: null, error: { message: 'connection reset' } }))
  const res = await loadTenantZones(client, ['a', 'b'])
  eq('⛔ the caller is told the read FAILED', res.ok, false)
  eq('…with the reason', res.error, 'connection reset')
  eq('…and no tenant was invented', res.zones.size, 0)

  // The trap in one line: the map looks IDENTICAL to a book where nobody set a
  // zone, and dating off it silently moves every tenant to the fallback day.
  const dated = todayForTenant(res.zones, 'a', new Date('2026-06-15T11:30:00Z'))
  eq('⛔ dating off that map yields the FALLBACK day for everyone',
    dated, todayForTenant(new Map(), 'a', new Date('2026-06-15T11:30:00Z')))
  ok('⛔ …which is why `ok` exists and callers must abort on it', res.ok === false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. A FAILURE PART-WAY THROUGH IS STILL A FAILURE')
{
  const { client } = stub(({ from }) =>
    from === 0 ? { data: rowsFor(ZONE_PAGE_ROWS, 0), error: null }
               : { data: null, error: { message: 'statement timeout' } })
  const res = await loadTenantZones(client)
  eq('⛔ a partial read reports failure, not success', res.ok, false)
  eq('…with the reason', res.error, 'statement timeout')
  ok('…even though the first page had loaded', res.zones.size === ZONE_PAGE_ROWS)
}

// ═══════════════════════════════════════════════════════════════════════════
H('5. THE DOCUMENTED FALLBACK STILL WORKS — a tenant with no zone is not an error')
{
  const { client } = stub(({ from }) => from > 0 ? { data: [], error: null } : ({
    data: [{ user_id: 'set', timezone: 'Pacific/Chatham' }, { user_id: 'unset', timezone: null }],
    error: null,
  }))
  const res = await loadTenantZones(client, ['set', 'unset', 'absent'])
  eq('the read succeeded', res.ok, true)
  eq('a stored zone is kept', res.zones.get('set'), 'Pacific/Chatham')
  eq('a NULL zone resolves to the shared fallback', res.zones.get('unset'), FALLBACK_TIME_ZONE)
  eq('a tenant with no row at all is simply absent', res.zones.has('absent'), false)
  eq('…and dates by the fallback, on purpose',
    todayForTenant(res.zones, 'absent', new Date('2026-06-15T11:30:00Z')),
    todayForTenant(new Map([['absent', FALLBACK_TIME_ZONE]]), 'absent', new Date('2026-06-15T11:30:00Z')))
}

// ═══════════════════════════════════════════════════════════════════════════
H('6. WIRING — every caller aborts on a failed read instead of dating anyone')
{
  const CALLERS = [
    'src/app/api/cron/engine/route.ts',
    'src/app/api/cron/reports/route.ts',
    'src/app/api/cron/invoice-reminders/route.ts',
    'src/app/api/cron/quote-followup/route.ts',
  ]
  for (const rel of CALLERS) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    ok(`${rel.split('/').slice(-2)[0]}: takes the result, not a bare map`,
      /const zoneRead = await loadTenantZones\(/.test(src))
    ok(`${rel.split('/').slice(-2)[0]}: ⛔ aborts when the read failed`,
      /if \(!zoneRead\.ok\)/.test(src))
    // The abort must come BEFORE the zones are used to date anything.
    ok(`${rel.split('/').slice(-2)[0]}: ⛔ …before any date is derived from them`,
      src.indexOf('if (!zoneRead.ok)') < src.indexOf('zoneRead.zones'))
  }
}

}

main()
  .catch(e => { fail++; console.log(`  ❌ the loader checks threw\n      ${String(e?.message ?? e).slice(0, 200)}`) })
  .then(() => {
    console.log('')
    if (fail) { console.log(`✗ tenant-zone-loader: ${fail} check(s) failed (${pass} held)\n`); process.exit(1) }
    console.log(`✓ tenant-zone-loader: every requested zone is loaded, and a failed read says so (${pass} checks)\n`)
  })
