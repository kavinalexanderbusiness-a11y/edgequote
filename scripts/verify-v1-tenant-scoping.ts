// ── Verify: /api/v1 scopes every read and write to the calling key's tenant ──
//   npm run verify:v1-tenant-scoping
//
// ⛔⛔ WHY THIS GUARD EXISTS. The v1 handlers run on `createAdminClient()` — a
// SERVICE-ROLE client, which bypasses RLS. lib/integrations/v1.ts says so
// outright: "owner-scoped explicitly (admin client bypasses RLS)". So on this
// surface, and only on this surface, tenant isolation is NOT a database
// guarantee: it is the explicit `.eq('user_id', auth.userId)` in two shared
// handlers, plus the same discipline hand-written in four more routes.
//
// That is correct today — every route was read and every one scopes. It is also
// one forgotten `.eq` away from serving another business's customers to whoever
// holds an API key, with no RLS underneath to catch it. Nothing asserted that
// until now.
//
// ⭐ TWO HALVES, because either alone would be hollow:
//   §1 BEHAVIOURAL — the REAL handlers, driven against a recording fake that
//      answers like a database: it applies the filters it is given. A handler
//      that forgets the tenant filter therefore RECEIVES the other tenant's row,
//      and the assertion fails. Order and effect, not a grep.
//   §2 STRUCTURAL — every v1 route file must reach its data through the shared
//      handlers or scope by hand. This is what catches a NEW route added later,
//      which §1 cannot see.
//
// ⛔ Entirely offline: no network, no Supabase client, no credential, no real
// data. The fake is the only "database" and it holds two synthetic tenants.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const note = (s: string) => console.log(`     ${s}`)

const ROOT = process.cwd()
const V1_DIR = join(ROOT, 'src', 'app', 'api', 'v1')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const A_ROW = { id: 'aaaaaaaa-0000-4000-8000-000000000001', user_id: A, name: 'A Customer', created_at: '2026-01-02T00:00:00Z' }
const B_ROW = { id: 'bbbbbbbb-0000-4000-8000-000000000001', user_id: B, name: 'B Customer', created_at: '2026-01-01T00:00:00Z' }
const ROWS = [A_ROW, B_ROW]

/** A fake that ANSWERS LIKE A DATABASE: it returns exactly what the filters ask
 *  for. Forget `.eq('user_id', …)` and it hands back the other tenant's row —
 *  which is precisely the regression this guard must be able to see. */
function fakeAdminClient(rec: { eqs: [string, unknown][]; tables: string[] }) {
  const build = (table: string) => {
    rec.tables.push(table)
    const eqs: [string, unknown][] = []
    const rowsNow = () => ROWS.filter(r => eqs.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (c: string, v: unknown) => { eqs.push([c, v]); rec.eqs.push([c, v]); return chain }
    for (const p of ['order', 'range', 'gte', 'lte', 'limit', 'neq', 'in', 'is']) chain[p] = () => chain
    chain.maybeSingle = async () => ({ data: rowsNow()[0] ?? null, error: null })
    chain.single = async () => ({ data: rowsNow()[0] ?? null, error: null })
    chain.then = (r: (v: unknown) => unknown) => r({ data: rowsNow(), error: null })
    return chain
  }
  return { from: build }
}

async function main() {
  console.log('\n═══ /api/v1 is service-role: the tenant filter IS the isolation ═══\n')

  // ── §1 · behavioural, against the real handlers ───────────────────────────
  console.log('■ 1. The real handlers, driven with a swapped id')
  /* eslint-disable @typescript-eslint/no-require-imports */
  const authId = require.resolve('../src/lib/integrations/apiAuth')
  const v1Id = require.resolve('../src/lib/integrations/v1')
  const savedAuth = require.cache[authId], savedV1 = require.cache[v1Id]
  const rec = { eqs: [] as [string, unknown][], tables: [] as string[] }
  // Only the transport and the identity are faked. Every decision under test —
  // which filters are applied, in what order — stays the real module's.
  const real = require(authId) as Record<string, unknown>
  require.cache[authId] = {
    id: authId, filename: authId, loaded: true,
    exports: {
      ...real,
      authenticateRequest: async () => ({ auth: { sb: fakeAdminClient(rec), userId: A, keyId: 'k', keyName: 'n', scopes: ['read'] } }),
    },
  } as unknown as NodeModule
  delete require.cache[v1Id]
  const { itemHandler, listHandler } = require(v1Id) as {
    itemHandler: (e: string) => (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>
    listHandler: (e: string, f?: string[]) => (r: Request) => Promise<Response>
  }
  // listParams reads `req.nextUrl.searchParams` (a NextRequest field), so the
  // fake request carries one. Nothing else about the request is simulated.
  const req = (url = 'http://zz.invalid/api/v1/customers') =>
    Object.assign(new Request(url, { headers: { authorization: 'Bearer eq_live_zz' } }),
      { nextUrl: new URL(url) }) as unknown as Request

  const item = itemHandler('customer')
  const own = await item(req(), { params: Promise.resolve({ id: A_ROW.id }) })
  const ownBody = await own.json() as { data?: { id?: string } }
  check('the legitimate owner still gets their own record (200)',
    own.status === 200 && ownBody.data?.id === A_ROW.id, `status ${own.status}`)

  rec.eqs.length = 0
  const swapped = await item(req(), { params: Promise.resolve({ id: B_ROW.id }) })
  const swappedBody = await swapped.text()
  check('⛔ a SWAPPED id returns 404, not another tenant\'s record',
    swapped.status === 404, `status ${swapped.status}`)
  check('⛔ …and no field of the other tenant\'s row appears in the body',
    !swappedBody.includes('B Customer') && !swappedBody.includes(B_ROW.id), swappedBody.slice(0, 120))
  check('the tenant filter was actually applied (not merely absent output)',
    rec.eqs.some(([c, v]) => c === 'user_id' && v === A), JSON.stringify(rec.eqs))

  rec.eqs.length = 0
  const listed = await (listHandler('customer'))(req())
  const listBody = await listed.text()
  check('the collection never contains another tenant\'s row',
    !listBody.includes('B Customer') && listBody.includes('A Customer'), listBody.slice(0, 140))
  check('…and it applied the tenant filter too',
    rec.eqs.some(([c, v]) => c === 'user_id' && v === A))

  require.cache[authId] = savedAuth; require.cache[v1Id] = savedV1
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ── §2 · the fixture can SEE the failure ─────────────────────────────────
  // Without this, every assertion above could be passing because the fake
  // returns nothing to anyone.
  console.log('\n■ 2. [negative control] an UNSCOPED query does leak, so §1 is a measurement')
  {
    const rec2 = { eqs: [] as [string, unknown][], tables: [] as string[] }
    const sb = fakeAdminClient(rec2)
    const unscoped = await (sb.from('customers') as { select: () => { eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> } } })
      .select().eq('id', B_ROW.id).maybeSingle()
    check('dropping .eq(user_id) hands back the OTHER tenant\'s row',
      (unscoped.data as { name?: string } | null)?.name === 'B Customer',
      'if this fails the fake is inert and §1 proves nothing')
  }

  // ── §3 · structural — the route a future session adds ────────────────────
  console.log('\n■ 3. Every v1 route reaches data through a tenant-scoped path')
  const routes: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'route.ts') routes.push(p)
    }
  }
  if (existsSync(V1_DIR)) walk(V1_DIR)
  check('v1 routes were found at all', routes.length > 0, `${routes.length}`)
  for (const p of routes) {
    const src = readFileSync(p, 'utf8')
    const rel = p.slice(p.indexOf(join('api', 'v1')))
    const shared = /\b(itemHandler|listHandler)\b/.test(src)
    // A hand-rolled route must scope every access to the authenticated key's
    // tenant: read filters by it, writes stamp it.
    const handScoped = /\.eq\(\s*['"]user_id['"]\s*,\s*auth\.userId\s*\)/.test(src)
      || /user_id:\s*auth\.userId/.test(src)
    check(`${rel} is tenant-scoped`, shared || handScoped,
      'a v1 route runs on the service-role client, so a missing user_id filter serves another tenant')
  }
  note(`${routes.length} v1 route files checked`)

  console.log(`\n${fail === 0 ? '✅' : '❌'} v1 tenant scoping: ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('\nGUARD ERROR:', e); process.exit(1) })
