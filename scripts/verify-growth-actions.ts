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
import type { FeedbackRow } from '../src/lib/revenueIntelligence'

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
  const state = { feedback: { ...initial } as Record<string, FeedbackRow>, busy: new Set<string>() as ReadonlySet<string>, notice: null as ActionNotice | null }
  const saves: { key: string; status: string; d: ReturnType<typeof deferred<SaveAnswer>> }[] = []
  const reads: { key: string; d: ReturnType<typeof deferred<ReadAnswer>> }[] = []
  const deps: ActionDeps = {
    record: (o, status) => { const d = deferred<SaveAnswer>(); saves.push({ key: o.key, status, d }); return d.promise },
    read: key => { const d = deferred<ReadAnswer>(); reads.push({ key, d }); return d.promise },
    setRow: (key, row) => { state.feedback = withRow(state.feedback, key, row) },
    setBusy: keys => { state.busy = keys },
    setNotice: n => { state.notice = n },
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
    p.saves[0].d.resolve({ ok: false, error: 'row-level security' }); await flush()
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
    p.saves[0].d.resolve({ ok: false }); await flush()
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
      p.state.notice?.tone === 'reconciled' && /isn't on record/.test(p.state.notice.text) && !/was not recorded|nothing was recorded/.test(p.state.notice.text), JSON.stringify(p.state.notice))
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
    p.saves[0].d.resolve({ ok: false }); await flush()
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
    check('a successful load hands the server\'s feedback to onRefreshed', /controller\(\)\.onRefreshed\(res\.feedback\)/.test(code), '')
    check('busy is per card, from the controller', /busy=\{busyKeys\.has\(o\.key\)\}/.test(code) && /setBusy: setBusyKeys/.test(code), '')
    check('the notice is an alert; only the unconfirmed tone offers Refresh', /role="alert"[\s\S]{0,120}\{actionNotice\.text\}/.test(code) && /actionNotice\.tone === 'unconfirmed' && [\s\S]{0,200}onClick=\{load\}/.test(code), '')
    const lib = readFileSync(join(process.cwd(), 'src/lib/growthActions.ts'), 'utf8')
    check('neither the page nor the handler ever says "nothing was recorded"', !/nothing was recorded/i.test(code) && !/nothing was recorded/i.test(lib.replace(/\/\/[^\n\r]*/g, '')), '')
    check('the superseded ordering ledger is gone', !/growthActionState/.test(src), '')
  }

  console.log(failures === 0 ? '\n✅ growth actions: latched per card, refusals restored and said, a dropped wire read back — never a fabricated failure\n' : `\n❌ ${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
