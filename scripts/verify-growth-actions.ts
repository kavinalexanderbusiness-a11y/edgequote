// ── Verify: the Growth card tap handler — latched per card, honest about the wire ──
//   npm run verify:growth-actions
//
// The handler the page runs is lib/growthActions.createActionController; the
// page only lends it React state through five callbacks. So it is driven HERE,
// as the page drives it, with controllable fake saves and reads: rapid taps on
// one card, taps on several cards, answers delayed and out of order, a server
// refusal, a thrown request read back as saved / not saved / unreadable, a
// refresh landing while a save is in flight, and a retry after a refusal.
//
// Two things it must never do (coordinator review of 12d1c9f2): infer commit
// order from response arrival order, and call a thrown request "not recorded".
//
// ⛔ FIXTURE DATA ONLY. No database, no network, no browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActionController, withRow, type ActionDeps, type ActionNotice, type ActionTarget, type SaveAnswer, type ReadAnswer } from '../src/lib/growthActions'
import { recordRecommendation, readRecommendation, type FeedbackRow } from '../src/lib/revenueIntelligence'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) => check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const flush = () => new Promise<void>(r => setTimeout(r, 0))

function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej }); return { promise, resolve, reject } }
const target = (key: string, name = key): ActionTarget => ({ key, kind: 'renewal', customerId: `cust-${key}`, customerName: name, expectedValue: 1960 })
const rowOf = (key: string, status: string): FeedbackRow => ({ opportunity_key: key, kind: 'renewal', status, expected_value: 1960, result_value: status === 'won' ? 1960 : null })

/** The page, as far as the handler can tell: a feedback map, a busy set, a notice, and the wire. */
function page(initial: Record<string, FeedbackRow> = {}) {
  const state = { feedback: { ...initial } as Record<string, FeedbackRow>, busy: new Set<string>() as ReadonlySet<string>, notice: null as ActionNotice | null, notices: {} as Record<string, ActionNotice> }
  const saves: { key: string; status: string; d: ReturnType<typeof deferred<SaveAnswer>> }[] = []
  const reads: { key: string; d: ReturnType<typeof deferred<ReadAnswer>> }[] = []
  const deps: ActionDeps = {
    record: (o, status) => { const d = deferred<SaveAnswer>(); saves.push({ key: o.key, status, d }); return d.promise },
    read: key => { const d = deferred<ReadAnswer>(); reads.push({ key, d }); return d.promise },
    setRow: (key, row) => { state.feedback = withRow(state.feedback, key, row) },
    setBusy: keys => { state.busy = keys },
    setNotice: (key, n) => { state.notice = n; if (n) state.notices[key] = n; else delete state.notices[key] },
  }
  const c = createActionController(deps, initial)
  return { c, state, saves, reads, status: (k: string) => state.feedback[k]?.status ?? null, busy: () => [...state.busy].sort() }
}

async function main() {
  console.log('\n── 1. The latch: one save in flight per card; cards independent ──')
  {
    const p = page()
    eq('first tap accepted', p.c.act(target('A'), 'acted'), true)
    eq('second tap on the same card while in flight is REFUSED, synchronously', p.c.act(target('A'), 'won'), false)
    eq('…and issued no second request', p.saves.length, 1)
    eq('the card shows the first tap, optimistically', p.status('A'), 'acted')
    eq('a tap on ANOTHER card is accepted concurrently', p.c.act(target('B'), 'won'), true)
    eq('both busy', p.busy(), ['A', 'B'])
    // B's answer arrives before A's — order between different keys is irrelevant
    p.saves[1].d.resolve({ ok: true }); await flush()
    eq('B confirmed while A still pending', [p.status('B'), p.busy()], ['won', ['A']])
    p.saves[0].d.resolve({ ok: true }); await flush()
    eq('A confirmed; nothing busy', [p.status('A'), p.busy()], ['acted', []])
    eq('after settling, the same card accepts a new tap (latch released)', p.c.act(target('A'), 'won'), true)
  }

  console.log('\n── 2. A server refusal is definite: restored and said ──')
  {
    const loaded = rowOf('A', 'acted')                       // acted yesterday, loaded from the server
    const p = page({ A: loaded })
    p.c.act(target('A', 'Northgate'), 'won')
    eq('optimistic won', p.status('A'), 'won')
    p.saves[0].d.resolve({ ok: false, definite: true, error: 'row-level security' }); await flush()
    eq('refused → back to the LOADED row, not to nothing', p.state.feedback.A, loaded)
    check('…said as not recorded (the server answered), naming the tap and the customer',
      p.state.notice?.tone === 'refused' && /Couldn't save "Mark won" for Northgate — it was not recorded/.test(p.state.notice.text), JSON.stringify(p.state.notice))
    eq('…not busy', p.busy(), [])
    // retry recovery
    eq('a retry is accepted', p.c.act(target('A', 'Northgate'), 'won'), true)
    eq('…and clears the notice on tap', p.state.notice, null)
    p.saves[1].d.resolve({ ok: true }); await flush()
    eq('…and the retry confirms', p.status('A'), 'won')
  }
  {
    const p = page()
    p.c.act(target('D'), 'dismissed')
    eq('a dismissed card vanishes optimistically (status dismissed)', p.status('D'), 'dismissed')
    p.saves[0].d.resolve({ ok: false, definite: true }); await flush()
    eq('refused → the card comes back (key removed; no prior row)', p.state.feedback.D, undefined)
  }

  console.log('\n── 3. A thrown request is AMBIGUOUS: read back, never declared failed ──')
  {
    // (a) the read shows it DID save → the badge stands, nothing said
    const p = page()
    p.c.act(target('A'), 'won')
    p.saves[0].d.reject(new TypeError('fetch failed')); await flush()
    eq('after the throw a read-back is issued for that key', p.reads.map(r => r.key), ['A'])
    eq('…and the card stays optimistic (and busy) while the read is pending', [p.status('A'), p.busy()], ['won', ['A']])
    p.reads[0].d.resolve({ ok: true, row: rowOf('A', 'won') }); await flush()
    eq('read shows the save committed → badge stands', p.status('A'), 'won')
    eq('…no notice: nothing went wrong that the owner needs to act on', p.state.notice, null)
    eq('…not busy', p.busy(), [])
  }
  {
    // (b) the read shows it is NOT on record → take what is on record, say so without claiming a failed commit
    const loaded = rowOf('A', 'acted')
    const p = page({ A: loaded })
    p.c.act(target('A', 'Northgate'), 'won')
    p.saves[0].d.reject(new Error('network')); await flush()
    p.reads[0].d.resolve({ ok: true, row: loaded }); await flush()
    eq('the card shows what the read returned', p.state.feedback.A, loaded)
    check('…and the notice says it is not ON RECORD — it never says "was not recorded" or "nothing was recorded"',
      p.state.notice?.tone === 'reconciled'
      // ⭐ Qualified as OBSERVED state — a write the wire lost can still land after
      // the read, so the copy must say what was seen and when, never deliver a
      // verdict on the row.
      && /as of this check it is not on record/.test(p.state.notice.text)
      && !/was not recorded|nothing was recorded/.test(p.state.notice.text), JSON.stringify(p.state.notice))
  }
  {
    // (c) the read fails too → unconfirmed: last confirmed state shown, refresh advised, no repeat encouraged
    const loaded = rowOf('A', 'acted')
    const p = page({ A: loaded })
    p.c.act(target('A', 'Northgate'), 'won')
    p.saves[0].d.reject(new Error('network')); await flush()
    p.reads[0].d.reject(new Error('network')); await flush()
    eq('the card shows the last CONFIRMED row', p.state.feedback.A, loaded)
    check('…and the notice says it may or may not have been recorded, and to refresh — not to tap again',
      p.state.notice?.tone === 'unconfirmed' && /may or may not have been recorded/.test(p.state.notice.text) && /Refresh/.test(p.state.notice.text) && !/not recorded\./.test(p.state.notice.text), JSON.stringify(p.state.notice))
    eq('…not busy', p.busy(), [])
  }

  console.log('\n── 4. A refresh landing while a save is in flight ──')
  {
    const p = page()
    p.c.act(target('A'), 'won')                                          // in flight
    // the page reloads the server's feedback: A is "acted" there (older), C is new
    const fresh = { A: rowOf('A', 'acted'), C: rowOf('C', 'won') }
    p.state.feedback = { ...fresh }                                      // what setFeedback(res.feedback) does
    p.c.onRefreshed(fresh)
    eq('the in-flight card keeps its optimistic badge over the refreshed map', p.status('A'), 'won')
    eq('…while other cards take the refreshed rows', p.status('C'), 'won')
    p.saves[0].d.resolve({ ok: true }); await flush()
    eq('its own confirmation then stands', p.status('A'), 'won')
  }
  {
    const p = page()
    p.c.act(target('A'), 'won')
    const fresh = { A: rowOf('A', 'acted') }
    p.state.feedback = { ...fresh }; p.c.onRefreshed(fresh)
    p.saves[0].d.resolve({ ok: false, definite: true }); await flush()
    eq('a refusal after the refresh restores the REFRESHED row — never the pre-refresh baseline', p.state.feedback.A, fresh.A)
  }
  {
    const p = page({ A: rowOf('A', 'acted') })
    p.c.act(target('A'), 'won')
    p.state.feedback = {}; p.c.onRefreshed({})                            // refresh says: nothing on record any more
    p.saves[0].d.reject(new Error('network')); await flush()
    p.reads[0].d.reject(new Error('network')); await flush()
    eq('unconfirmed after a refresh falls back to the refreshed baseline (none), not the stale pre-refresh row', p.state.feedback.A, undefined)
  }

  console.log('\n── 5. The page runs THIS handler ──')
  {
    const src = readFileSync(join(process.cwd(), 'src/app/dashboard/revenue-intelligence/page.tsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
    check('act() delegates to the controller', /function act\([^)]*\) \{\s*controller\(\)\.act\(o, status\)\s*\}/.test(code), '')
    check('the controller is wired to the real save and the real read-back', /record: \(o, status, value\) => recordRecommendation\(supabase, o, status, value\)/.test(code) && /read: key => readRecommendation\(supabase, key\)/.test(code), '')
    check('a successful load hands the server\'s feedback to onRefreshed, with the clock it started at',
      /const since = controller\(\)\.beginRefresh\(\)/.test(code) && /controller\(\)\.onRefreshed\(res\.feedback, since\)/.test(code), '')
    check('busy is per card, from the controller', /busy=\{busyKeys\.has\(o\.key\)\}/.test(code) && /setBusy: setBusyKeys/.test(code), '')
    check('notices are rendered per key, as alerts; only the unconfirmed tone offers Refresh',
      /Object\.values\(actionNotices\)\.map\(n =>/.test(code)
      && /<p key=\{n\.key\} role="alert"[\s\S]{0,120}\{n\.text\}/.test(code)
      && /n\.tone === 'unconfirmed' && [\s\S]{0,200}onClick=\{load\}/.test(code), '')
    const lib = readFileSync(join(process.cwd(), 'src/lib/growthActions.ts'), 'utf8')
    check('neither the page nor the handler ever says "nothing was recorded"', !/nothing was recorded/i.test(code) && !/nothing was recorded/i.test(lib.replace(/\/\/[^\n\r]*/g, '')), '')
    check('the superseded ordering ledger is gone', !/growthActionState/.test(src), '')
  }


  console.log('\n── 6. Through the REAL adapter: a returned transport error is not a refusal ──')
  {
    // ⛔ These drive the SHIPPED recordRecommendation, not a stub. postgrest-js
    // resolves a dead connection as an error object with `status: 0`; a genuine
    // refusal arrives through processResponse with the real HTTP status. Nothing
    // else distinguishes them — `code` is '' on both paths.
    const client = (upsertResult: unknown, readRow: FeedbackRow | null = null) => ({
      auth: {
        getUser: async () => ({ data: { user: { id: 'u1' } } }),
        getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
      },
      from: () => {
        const c: Record<string, unknown> = {}
        for (const k of ['select', 'eq', 'limit']) c[k] = () => c
        c.upsert = async () => upsertResult
        c.then = (res: (v: unknown) => unknown) => res({ data: readRow ? [readRow] : [], error: null })
        return c
      },
    })
    const tgt = target('k1')

    const dead = await recordRecommendation(
      client({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0, statusText: '' }) as never,
      tgt, 'won', 1960)
    check('a dead connection (status 0) is NOT definite', dead.ok === false && dead.definite === false, JSON.stringify(dead))

    const refused = await recordRecommendation(
      client({ data: null, error: { message: 'new row violates row-level security policy', code: '42501' }, status: 403, statusText: 'Forbidden' }) as never,
      tgt, 'won', 1960)
    check('a real refusal (HTTP 403) IS definite', refused.ok === false && refused.definite === true, JSON.stringify(refused))

    // ⛔ GATEWAY CLASS. A 504 comes from the edge in FRONT of PostgREST: it gave up
    // waiting for a response to a request it had already forwarded, so Postgres may
    // well have committed. Its body is an HTML error page, which processResponse
    // cannot JSON-parse, so the error arrives as `{ message: '<html>…' }` with no
    // `code` — no structured rejection evidence at all.
    const gatewayHtml = '<html><head><title>504 Gateway Time-out</title></head><body><h1>504 Gateway Time-out</h1></body></html>'
    for (const [label, st] of [['504 gateway timeout', 504], ['503 unavailable', 503], ['502 bad gateway', 502], ['500 upstream', 500]] as [string, number][]) {
      const r = await recordRecommendation(
        client({ data: null, error: { message: gatewayHtml }, status: st, statusText: 'Gateway Time-out' }) as never,
        tgt, 'won', 1960)
      check(`⛔ a ${label} is NOT definite — it may have been forwarded and committed`,
        r.ok === false && r.definite === false, JSON.stringify(r))
    }
    // A 4xx from something in front of PostgREST also has no structured body.
    const edge4xx = await recordRecommendation(
      client({ data: null, error: { message: gatewayHtml }, status: 403, statusText: 'Forbidden' }) as never,
      tgt, 'won', 1960)
    check('a 4xx with a non-JSON body carries no rejection evidence, so it is not definite',
      edge4xx.ok === false && edge4xx.definite === false, JSON.stringify(edge4xx))

    // …and the shipped controller must take the read-back path for a 504.
    const sbGw = client({ data: null, error: { message: gatewayHtml }, status: 504, statusText: 'Gateway Time-out' }, null)
    const gwSeen: ActionNotice[] = []
    const gwCtl = createActionController({
      record: (o, st, v) => recordRecommendation(sbGw as never, o, st, v),
      read: key => readRecommendation(sbGw as never, key),
      setRow: () => {}, setBusy: () => {},
      setNotice: (_k, n) => { if (n) gwSeen.push(n) },
    })
    gwCtl.act(tgt, 'won')
    await new Promise(r => setTimeout(r, 10))
    check('⛔ a 504 reads back instead of claiming a refusal',
      gwSeen.length === 1 && gwSeen[0].tone !== 'refused', JSON.stringify(gwSeen))
    check('…and never tells the owner it was not recorded',
      !gwSeen.some(n => /not recorded/i.test(n.text)), JSON.stringify(gwSeen.map(n => n.text)))
    check('…and what it does say is qualified as observed, not categorical',
      gwSeen.every(n => !/it isn't on record\b/.test(n.text)), JSON.stringify(gwSeen.map(n => n.text)))

    const saved = await recordRecommendation(
      client({ data: null, error: null, status: 201, statusText: 'Created' }) as never, tgt, 'won', 1960)
    check('a successful upsert is still ok', saved.ok === true)

    // …and the shipped controller must then take the ambiguous path, not the
    // refusal path, for the dead-connection case.
    const sb = client({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0, statusText: '' }, null)
    const seen: ActionNotice[] = []
    const ctl = createActionController({
      record: (o, st, v) => recordRecommendation(sb as never, o, st, v),
      read: key => readRecommendation(sb as never, key),
      setRow: () => {}, setBusy: () => {},
      setNotice: (_k, n) => { if (n) seen.push(n) },
    })
    ctl.act(tgt, 'won')
    await new Promise(r => setTimeout(r, 10))
    check('⛔ a returned transport error reads back instead of claiming a refusal',
      seen.length === 1 && seen[0].tone !== 'refused', JSON.stringify(seen))
    check('…and it never says the save was not recorded',
      !seen.some(n => /not recorded/i.test(n.text)), JSON.stringify(seen.map(n => n.text)))
  }

  console.log('\n── 7. A refresh that BEGAN before a save cannot undo it ──')
  {
    const p = page()
    const since = p.c.beginRefresh()          // the read starts here
    p.c.act(target('k1'), 'won')
    p.saves[0].d.resolve({ ok: true }); await flush()
    check('the save is confirmed', p.status('k1') === 'won')
    // The server map answers now, from before the save committed.
    p.state.feedback = {}
    p.c.onRefreshed({}, since)
    check('⛔ the stale refresh does not erase the confirmed badge', p.status('k1') === 'won', JSON.stringify(p.state.feedback))

    const q = page()
    q.c.act(target('k1'), 'won')
    q.saves[0].d.resolve({ ok: true }); await flush()
    const after = q.c.beginRefresh()          // a read that starts AFTER the save
    q.state.feedback = {}
    q.c.onRefreshed({}, after)
    check('a refresh that began after it still takes the server as truth', q.status('k1') === null)
  }

  console.log('\n── 8. A notice belongs to its own card ──')
  {
    const p = page()
    p.c.act(target('k1'), 'won'); p.c.act(target('k2'), 'won')
    p.saves[0].d.resolve({ ok: false, definite: true }); await flush()
    p.saves[1].d.resolve({ ok: false, definite: true }); await flush()
    check('⛔ both failures are retained, not overwritten', Object.keys(p.state.notices).length === 2, JSON.stringify(Object.keys(p.state.notices)))
    check('each names its own key', p.state.notices.k1?.key === 'k1' && p.state.notices.k2?.key === 'k2')
    p.c.act(target('k1'), 'acted')
    check('tapping one card clears only its own notice',
      p.state.notices.k1 === undefined && p.state.notices.k2 !== undefined, JSON.stringify(Object.keys(p.state.notices)))
  }

  console.log(failures === 0 ? '\n✅ growth actions: latched per card, refusals restored and said, a dropped wire read back — never a fabricated failure\n' : `\n❌ ${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
