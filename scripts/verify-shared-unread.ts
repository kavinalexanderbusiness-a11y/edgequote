// ── verify:shared-unread — one owner for the unread number ───────────────────
//   npx tsx scripts/verify-shared-unread.ts
//   VERIFY_UNREAD_STORE=<path/to/other/unreadStore.ts> npx tsx scripts/verify-shared-unread.ts
//     → §2/§3 against another implementation. Used as the NEGATIVE CONTROL: the
//       frozen 3b94e37b blob must FAIL the §3 bootstrap/rejection cases this
//       guard was extended for, and pass everything else.
//
// §1 SOURCE: the conversations-unread read exists once (lib/unreadStore); the
//    Sidebar, the BottomNav and CommsNav all read it through useUnread; no
//    component opens its own conversations stream; CommsNav keeps only its
//    scheduled-messages pending count.
// §2 BEHAVIOUR, against a fake client (no browser, no database, no network):
//    ref-counting (one session read, one query, one channel however many
//    consumers), tenant scope on the read AND the stream, muted excluded,
//    debounced bursts, stale responses dropped, a failed read keeps the last
//    number, account switch / sign-out / same-user token refresh, and full
//    cleanup on the last unsubscribe — a late response after teardown applies
//    nothing.
// §3 BOOTSTRAP vs AUTH EVENTS, StrictMode, REJECTIONS — each case on a fresh
//    store with manually-resolved session reads, so the ORDER of answers is
//    the test: a SIGNED_OUT that lands while the bootstrap session read is in
//    flight outranks that read's later answer (the reviewed failure: 1 read,
//    1 channel, snapshot 4 where 0/0/0 was owed); a later legitimate sign-in
//    still attaches; INITIAL_SESSION before the bootstrap answers attaches
//    once; start → stop → start leaves one live stream; a same-user token
//    refresh does NOT discard an in-flight count read; a rejected session or
//    count read is caught (no unhandled rejection), attaches nothing on a
//    guess, keeps the last same-account number, and the store recovers.
// Synthetic throughout: nothing here touches Supabase.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { UnreadClient, UnreadChannel, UnreadFilter, UnreadResult, UnreadSession } from '../src/lib/unreadStore'

type StoreModule = typeof import('../src/lib/unreadStore')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Every rejection the store swallows must be swallowed; one that escapes is a
// failure of THIS guard's cases, counted here.
let unhandled = 0
process.on('unhandledRejection', () => { unhandled++ })

async function loadStore(): Promise<StoreModule> {
  const p = process.env.VERIFY_UNREAD_STORE
  if (!p) return import('../src/lib/unreadStore')
  const abs = resolve(p)
  // A file outside the project loads as CommonJS under tsx: its exports arrive under `default`.
  const unwrap = (m: StoreModule & { default?: StoreModule }) => (typeof m.createUnreadStore === 'function' ? m : m.default!)
  try { return unwrap(await import(pathToFileURL(abs).href)) } catch { return unwrap(createRequire(resolve('package.json'))(abs) as StoreModule) }
}

// ── §1 source ───────────────────────────────────────────────────────────────
console.log('\n── §1 one owner in source ──')
{
  const store = strip(read('src/lib/unreadStore.ts'))
  const hook = strip(read('src/hooks/useUnread.ts'))
  const comms = strip(read('src/components/messages/CommsNav.tsx'))
  const sidebar = strip(read('src/components/layout/Sidebar.tsx'))
  const bottom = strip(read('src/components/layout/BottomNav.tsx'))
  const predicate = /from\('conversations'\)\.select\('unread'\)\s*\.eq\('user_id', u\)\.gt\('unread', 0\)\.eq\('muted', false\)/
  check('the store reads conversations.unread scoped to the user, > 0, muted excluded', predicate.test(store))
  check('the store streams conversations changes filtered to the user', /table: 'conversations', filter: `user_id=eq\.\$\{id\}`/.test(store))
  check('useUnread builds exactly one store at module scope and reads it with useSyncExternalStore',
    (store.match(/createUnreadStore\(/g) || []).length === 1 && (hook.match(/createUnreadStore\(/g) || []).length === 1
    && /useSyncExternalStore\(store\.subscribe, store\.getSnapshot, store\.getServerSnapshot\)/.test(hook) && !/useEffect/.test(hook))
  check('the hook\'s channel teardown swallows a rejected unsubscribe', /removeChannel\(ch\)\.catch\(/.test(hook))
  check('CommsNav no longer reads conversations itself', !/from\('conversations'\)/.test(comms))
  check('CommsNav reads the shared number through useUnread', /const unread = useUnread\(\)/.test(comms))
  check('CommsNav keeps its own scheduled-messages pending count (one consumer, other table)',
    /from\('scheduled_messages'\)/.test(comms) && /\.eq\('status', 'pending'\)/.test(comms) && /setPending\(/.test(comms))
  check('Sidebar and BottomNav still read the same hook', /const unread = useUnread\(\)/.test(sidebar) && /const unread = useUnread\(\)/.test(bottom))
  const bindings = [store, hook, comms, sidebar, bottom].map(s => (s.match(/table: 'conversations'/g) || []).length)
  check('exactly one conversations stream binding across the five files (the store)', bindings.join() === '1,0,0,0,0', bindings.join())
}

// ── the fake ─────────────────────────────────────────────────────────────────
interface Deferred { resolve(r: UnreadResult): void; reject(e: unknown): void; uid: string; filters: [string, string, unknown][]; select: string; table: string }
interface SessionRead { resolve(uid: string | null): void; reject(e: unknown): void }
interface FakeChannel extends UnreadChannel { name: string; subscribed: boolean; removed: boolean; binding: { event: string; schema: string; table: string; filter: string } | null; fire: () => void }

/** `manual: true` → every getSession() is a deferred the case resolves or rejects itself. */
function fakeClient(sessionUid: string | null, opts: { manual?: boolean } = {}) {
  const queries: Deferred[] = []
  const channels: FakeChannel[] = []
  const sessions: SessionRead[] = []
  let sessionReads = 0
  let authListener: ((event: string, session: UnreadSession | null) => void) | null = null
  let authUnsubscribed = 0
  const sessionOf = (uid: string | null) => ({ data: { session: uid ? { user: { id: uid } } : null } })
  const client: UnreadClient = {
    auth: {
      getSession() {
        sessionReads++
        if (!opts.manual) return Promise.resolve(sessionOf(sessionUid))
        return new Promise((res, rej) => { sessions.push({ resolve: uid => res(sessionOf(uid)), reject: rej }) })
      },
      onAuthStateChange(cb) { authListener = cb; return { data: { subscription: { unsubscribe() { authUnsubscribed++; authListener = null } } } } },
    },
    from(table) {
      return {
        select(columns) {
          let resolve!: (r: UnreadResult) => void
          let reject!: (e: unknown) => void
          const p = new Promise<UnreadResult>((r, j) => { resolve = r; reject = j })
          const d: Deferred = { resolve, reject, uid: '', filters: [], select: columns, table }
          queries.push(d)
          const f: UnreadFilter = {
            eq(c, v) { d.filters.push(['eq', c, v]); if (c === 'user_id') d.uid = String(v); return f },
            gt(c, v) { d.filters.push(['gt', c, v]); return f },
            then: (onF, onR) => p.then(onF, onR),
          }
          return f
        },
      }
    },
    channel(name) {
      const ch: FakeChannel = {
        name, subscribed: false, removed: false, binding: null, fire: () => {},
        on(_type, filter, cb) { ch.binding = filter; ch.fire = cb; return ch },
        subscribe() { ch.subscribed = true; return ch },
      }
      channels.push(ch)
      return ch
    },
    removeChannel(ch) { (ch as FakeChannel).removed = true },
  }
  return {
    client, queries, channels, sessions,
    sessionReads: () => sessionReads,
    authUnsubscribed: () => authUnsubscribed,
    emitAuth: (event: string, uid: string | null) => authListener?.(event, uid ? { user: { id: uid } } : null),
    hasAuthListener: () => authListener !== null,
    live: () => channels.filter(c => c.subscribed && !c.removed),
  }
}

function fakeTimers() {
  let id = 0
  const pending = new Map<number, () => void>()
  return {
    setTimeout: (fn: () => void, _ms: number) => { const h = ++id; pending.set(h, fn); return h },
    clearTimeout: (h: unknown) => { pending.delete(h as number) },
    run: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach(f => f()) },
    size: () => pending.size,
  }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))
// Long enough for Node to report an unhandled rejection from the previous turn.
const settle = () => new Promise<void>(r => setTimeout(r, 15))
const rows = (...n: (number | null)[]): UnreadResult => ({ data: n.map(unread => ({ unread })), error: null })

async function main() {
  const mod = await loadStore()
  if (process.env.VERIFY_UNREAD_STORE) console.log(`\n(§2/§3 against ${resolve(process.env.VERIFY_UNREAD_STORE)})`)
  const S = (fx: ReturnType<typeof fakeClient>, t: ReturnType<typeof fakeTimers>) =>
    mod.createUnreadStore({ client: () => fx.client, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })

  // ── §2 behaviour against a fake client ─────────────────────────────────────
  console.log('\n── §2 behaviour (fake client) ──')
  const fx = fakeClient('tenant-a')
  const t = fakeTimers()
  const store = S(fx, t)
  const notified = { a: 0, b: 0, c: 0 }

  check('before any subscriber: no session read, no query, no channel, snapshot 0, server snapshot 0',
    fx.sessionReads() === 0 && fx.queries.length === 0 && fx.channels.length === 0 && store.getSnapshot() === 0 && store.getServerSnapshot() === 0)

  // First consumer (the Sidebar)
  const offA = store.subscribe(() => { notified.a++ })
  await tick()
  const q1 = fx.queries[0]
  check('first subscriber: exactly one session read, one query, one channel, one auth listener',
    fx.sessionReads() === 1 && fx.queries.length === 1 && fx.channels.length === 1 && fx.hasAuthListener())
  check('the read is tenant-scoped, > 0, muted excluded — in that shape', !!q1 && q1.table === 'conversations' && q1.select === 'unread'
    && JSON.stringify(q1.filters) === JSON.stringify([['eq', 'user_id', 'tenant-a'], ['gt', 'unread', 0], ['eq', 'muted', false]]), JSON.stringify(q1?.filters))
  const ch1 = fx.channels[0]
  check('the stream is subscribed on conversations, filtered to the same user', !!ch1 && ch1.subscribed && ch1.binding?.table === 'conversations'
    && ch1.binding?.schema === 'public' && ch1.binding?.event === '*' && ch1.binding?.filter === 'user_id=eq.tenant-a', JSON.stringify(ch1?.binding))
  check('the topic is unique per attach (no reused-topic throw)', !!ch1 && /^unread:tenant-a:[a-z0-9]+$/.test(ch1.name), ch1?.name)

  q1.resolve(rows(3, 2)); await tick()
  check('the snapshot is the sum of unread (3 + 2 = 5) and the listener heard once', store.getSnapshot() === 5 && notified.a === 1, `${store.getSnapshot()} / ${notified.a}`)

  // Second and third consumers (BottomNav, CommsNav) — join, never restart
  const offB = store.subscribe(() => { notified.b++ })
  const offC = store.subscribe(() => { notified.c++ })
  await tick()
  check('two more subscribers: still one session read, one query, one channel; they read 5 at once',
    fx.sessionReads() === 1 && fx.queries.length === 1 && fx.channels.length === 1 && store.getSnapshot() === 5)

  // Realtime burst → one debounced refetch
  ch1.fire(); ch1.fire(); ch1.fire()
  check('a burst of stream events issues no read before the debounce elapses', fx.queries.length === 1 && t.size() === 1)
  t.run(); await tick()
  check('…and exactly one read after it', fx.queries.length === 2)
  fx.queries[1].resolve(rows(1)); await tick()
  check('the new number lands (1) and every listener heard exactly once', store.getSnapshot() === 1 && notified.a === 2 && notified.b === 1 && notified.c === 1, JSON.stringify(notified))

  // Stale response: an older read landing after a newer one is dropped
  ch1.fire(); t.run(); await tick()
  const slow = fx.queries[2]
  ch1.fire(); t.run(); await tick()
  const fast = fx.queries[3]
  check('two reads in flight', !!slow && !!fast && fx.queries.length === 4)
  fast.resolve(rows(7)); await tick()
  check('the newer read applies (7)', store.getSnapshot() === 7)
  const before = { ...notified }
  slow.resolve(rows(4)); await tick()
  check('the OLDER read landing later is dropped — still 7, nobody notified', store.getSnapshot() === 7 && JSON.stringify(notified) === JSON.stringify(before), `${store.getSnapshot()}`)

  // A failed read keeps the last number
  ch1.fire(); t.run(); await tick()
  fx.queries[4].resolve({ data: null, error: { message: 'connection reset' } }); await tick()
  check('a failed read keeps the last number (7), never a false 0', store.getSnapshot() === 7)

  // Null unread rows count as 0 (the sum, not the filter, handles nulls)
  ch1.fire(); t.run(); await tick()
  fx.queries[5].resolve(rows(null, 2)); await tick()
  check('null unread rows add nothing (null + 2 = 2)', store.getSnapshot() === 2)

  // Same-user auth noise: nothing restarts
  fx.emitAuth('TOKEN_REFRESHED', 'tenant-a'); await tick()
  check('a token refresh for the same user changes nothing (no new read, no new channel)', fx.queries.length === 6 && fx.channels.length === 1 && !ch1.removed)

  // Account switch: a pending read for A must not paint for B
  ch1.fire(); t.run(); await tick()
  const lateA = fx.queries[6]
  fx.emitAuth('SIGNED_IN', 'tenant-b'); await tick()
  const ch2 = fx.channels[1]
  const qB = fx.queries[7]
  check('switching to another account zeroes at once, removes A\'s channel, opens B\'s, reads for B',
    store.getSnapshot() === 0 && ch1.removed && !!ch2 && ch2.subscribed && ch2.binding?.filter === 'user_id=eq.tenant-b' && !!qB && qB.uid === 'tenant-b',
    `snap=${store.getSnapshot()} ch1.removed=${ch1.removed} ch2=${JSON.stringify(ch2?.binding)} qB=${qB?.uid}`)
  lateA.resolve(rows(99)); await tick()
  check('A\'s late response is dropped (still 0)', store.getSnapshot() === 0)
  qB.resolve(rows(2)); await tick()
  check('B\'s read lands (2)', store.getSnapshot() === 2)
  check('B\'s stream events drive B\'s reads', (ch2.fire(), t.run(), true) && fx.queries.length === 9 && fx.queries[8].uid === 'tenant-b')
  fx.queries[8].resolve(rows(2)); await tick()

  // Sign-out
  fx.emitAuth('SIGNED_OUT', null); await tick()
  check('sign-out zeroes and removes the channel without a read', store.getSnapshot() === 0 && ch2.removed && fx.queries.length === 9 && fx.live().length === 0)
  fx.emitAuth('SIGNED_IN', 'tenant-a'); await tick()
  check('signing back in reads and streams for that user again', fx.queries[9]?.uid === 'tenant-a' && fx.live().length === 1 && fx.live()[0].binding?.filter === 'user_id=eq.tenant-a')
  fx.queries[9].resolve(rows(4)); await tick()
  check('…and lands (4)', store.getSnapshot() === 4)

  // Cleanup on the last unsubscribe
  const ch3 = fx.live()[0]
  ch3.fire() // a pending debounce that must be cleared
  check('a debounce is pending before teardown', t.size() === 1)
  offA(); offB()
  check('two of three gone: still live (channel kept, listener kept)', !ch3.removed && fx.hasAuthListener() && store.getSnapshot() === 4)
  offC(); offC() // the second call is a no-op, not a double-decrement
  check('last unsubscribe: channel removed, auth listener unsubscribed, debounce cleared, snapshot 0',
    ch3.removed && !fx.hasAuthListener() && fx.authUnsubscribed() === 1 && t.size() === 0 && store.getSnapshot() === 0)
  const reads = fx.queries.length
  ch3.fire(); t.run(); await tick()
  check('a stream event after teardown issues no read', fx.queries.length === reads)
  fx.emitAuth('SIGNED_IN', 'tenant-b'); await tick()
  check('an auth event after teardown is ignored (listener gone)', fx.queries.length === reads && fx.channels.length === 3)

  // Late response after teardown
  {
    const fx2 = fakeClient('tenant-a')
    const t2 = fakeTimers()
    const s2 = S(fx2, t2)
    let heard = 0
    const off2 = s2.subscribe(() => { heard++ })
    await tick()
    off2()
    fx2.queries[0].resolve(rows(50)); await tick()
    check('a read that resolves after the last unsubscribe applies nothing and notifies no one', s2.getSnapshot() === 0 && heard === 0)
    const off3 = s2.subscribe(() => { heard++ }); await tick()
    check('subscribing again restarts cleanly (a second session read, a second channel)', fx2.sessionReads() === 2 && fx2.live().length === 1)
    off3()
  }

  // No session at all
  {
    const fx3 = fakeClient(null)
    const s3 = mod.createUnreadStore({ client: () => fx3.client })
    const off4 = s3.subscribe(() => {}); await tick()
    check('with no session: no read, no channel, snapshot 0', fx3.queries.length === 0 && fx3.channels.length === 0 && s3.getSnapshot() === 0)
    off4()
  }

  // ── §3 bootstrap vs auth events, StrictMode, rejections ────────────────────
  console.log('\n── §3 bootstrap vs auth events, StrictMode, rejections (fresh store per case, manual session reads) ──')

  // 3.1 POSITIVE CONTROL — the same shape with NO auth event attaches. This is
  // what makes 3.2's 0/0/0 a finding rather than a store that never attaches.
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    check('3.1 control: bootstrap session read pending → nothing read yet', fx.sessions.length === 1 && fx.queries.length === 0 && fx.channels.length === 0)
    fx.sessions[0].resolve('tenant-a'); await tick()
    fx.queries[0]?.resolve(rows(4)); await tick()
    check('3.1 control: with NO auth event, the bootstrap answer attaches A — 1 read, 1 live channel, snapshot 4',
      fx.queries.length === 1 && fx.live().length === 1 && s.getSnapshot() === 4, `reads=${fx.queries.length} live=${fx.live().length} snap=${s.getSnapshot()}`)
    off()
  }

  // 3.2 THE REVIEWED FAILURE — SIGNED_OUT lands while the bootstrap read is in
  // flight; the read then answers "user A". The auth event is later, so A must
  // NOT attach. (3b94e37b attached: 1 read, 1 channel, snapshot 4.)
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    fx.emitAuth('SIGNED_OUT', null); await tick()
    fx.sessions[0].resolve('tenant-a'); await tick()
    fx.queries[0]?.resolve(rows(4)); await tick()
    check('3.2 SIGNED_OUT during the bootstrap, then the session read answers A: NOTHING attaches — 0 reads, 0 channels, snapshot 0',
      fx.queries.length === 0 && fx.channels.length === 0 && s.getSnapshot() === 0, `reads=${fx.queries.length} channels=${fx.channels.length} snap=${s.getSnapshot()}`)
    fx.emitAuth('SIGNED_IN', 'tenant-a'); await tick()
    check('3.2 …and a later legitimate SIGNED_IN attaches: 1 read for A, 1 live channel',
      fx.queries.length === 1 && fx.queries[0]?.uid === 'tenant-a' && fx.live().length === 1, `reads=${fx.queries.length} live=${fx.live().length}`)
    fx.queries[0]?.resolve(rows(4)); await tick()
    check('3.2 …with the number landing (4)', s.getSnapshot() === 4)
    off()
    check('3.2 cleanup: live channel removed, snapshot 0', fx.live().length === 0 && s.getSnapshot() === 0)
  }

  // 3.3 Initial signed-out session, then a legitimate sign-in, then sign-out
  {
    const fx = fakeClient(null, { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    fx.sessions[0].resolve(null); await tick()
    check('3.3 a signed-out bootstrap attaches nothing: 0 reads, 0 channels, snapshot 0', fx.queries.length === 0 && fx.channels.length === 0 && s.getSnapshot() === 0)
    fx.emitAuth('SIGNED_IN', 'tenant-a'); await tick()
    fx.queries[0]?.resolve(rows(2)); await tick()
    check('3.3 a later SIGNED_IN attaches A: 1 read, 1 live channel, snapshot 2', fx.queries.length === 1 && fx.live().length === 1 && s.getSnapshot() === 2)
    fx.emitAuth('SIGNED_OUT', null); await tick()
    check('3.3 SIGNED_OUT again: 0, channel removed, no read issued', s.getSnapshot() === 0 && fx.live().length === 0 && fx.queries.length === 1)
    off()
  }

  // 3.4 INITIAL_SESSION arrives before the bootstrap read answers
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    fx.emitAuth('INITIAL_SESSION', 'tenant-a'); await tick()
    check('3.4 INITIAL_SESSION(A) before the bootstrap answers: attaches once — 1 read, 1 live channel', fx.queries.length === 1 && fx.live().length === 1)
    fx.sessions[0].resolve('tenant-a'); await tick()
    check('3.4 the bootstrap answer arriving afterwards adds nothing (still 1 read, 1 channel)', fx.queries.length === 1 && fx.channels.length === 1)
    fx.queries[0].resolve(rows(3)); await tick()
    check('3.4 …snapshot 3', s.getSnapshot() === 3)
    off()
  }

  // 3.5 StrictMode: start → stop → start before anything answers
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off1 = s.subscribe(() => {}); off1()
    const off2 = s.subscribe(() => {}); await tick()
    check('3.5 start→stop→start: two session reads, the first auth listener unsubscribed, one listener live, nothing read',
      fx.sessions.length === 2 && fx.authUnsubscribed() === 1 && fx.hasAuthListener() && fx.queries.length === 0)
    fx.sessions[0].resolve('tenant-a'); await tick()
    check('3.5 the FIRST start\'s session answer is dropped (still nothing read, no channel)', fx.queries.length === 0 && fx.channels.length === 0)
    fx.sessions[1].resolve('tenant-a'); await tick()
    fx.queries[0]?.resolve(rows(3)); await tick()
    check('3.5 the second start attaches exactly once: 1 read, 1 live channel, snapshot 3', fx.queries.length === 1 && fx.live().length === 1 && s.getSnapshot() === 3)
    off2()
    check('3.5 cleanup after the second: no live channel, no listener, snapshot 0', fx.live().length === 0 && !fx.hasAuthListener() && s.getSnapshot() === 0)
  }

  // 3.5b StrictMode where the FIRST start's session read rejects after the restart
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off1 = s.subscribe(() => {}); off1()
    const off2 = s.subscribe(() => {}); await tick()
    const u0 = unhandled
    fx.sessions[0].reject(new Error('first session read failed')); await settle()
    check('3.5b the first start\'s rejected session read is caught (no unhandled rejection) and changes nothing', unhandled === u0 && fx.queries.length === 0)
    fx.sessions[1].resolve('tenant-a'); await tick()
    check('3.5b the second start still bootstraps: 1 read, 1 live channel', fx.queries.length === 1 && fx.live().length === 1)
    off2()
  }

  // 3.6 A same-user auth event must NOT discard an in-flight count read
  const fx6 = fakeClient('tenant-a'); const t6 = fakeTimers(); const s6 = S(fx6, t6)
  {
    const off = s6.subscribe(() => {}); await tick()
    fx6.queries[0].resolve(rows(5)); await tick()
    fx6.live()[0].fire(); t6.run(); await tick()
    check('3.6 a count read is in flight', fx6.queries.length === 2)
    fx6.emitAuth('TOKEN_REFRESHED', 'tenant-a'); await tick()
    check('3.6 TOKEN_REFRESHED for the same user: no new channel, no new read', fx6.channels.length === 1 && fx6.queries.length === 2 && !fx6.channels[0].removed)
    fx6.queries[1].resolve(rows(6)); await tick()
    check('3.6 …and the in-flight read still applies (6) — not discarded', s6.getSnapshot() === 6, `${s6.getSnapshot()}`)

    // 3.7 SIGNED_OUT while a same-account read is in flight
    fx6.live()[0].fire(); t6.run(); await tick()
    const inflight = fx6.queries[2]
    fx6.emitAuth('SIGNED_OUT', null); await tick()
    check('3.7 SIGNED_OUT with a read in flight: zero at once, channel removed', s6.getSnapshot() === 0 && fx6.live().length === 0)
    inflight.resolve(rows(9)); await tick()
    check('3.7 …the signed-out account\'s late answer does not paint (still 0)', s6.getSnapshot() === 0)
    off()
  }

  // 3.8 A rejected session read
  {
    const fx = fakeClient('tenant-a', { manual: true }); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    const u0 = unhandled
    fx.sessions[0].reject(new Error('session read failed')); await settle()
    check('3.8 a rejected session read is caught: no unhandled rejection, nothing attached, snapshot 0',
      unhandled === u0 && fx.queries.length === 0 && fx.channels.length === 0 && s.getSnapshot() === 0, `unhandled+${unhandled - u0} reads=${fx.queries.length}`)
    fx.emitAuth('SIGNED_IN', 'tenant-a'); await tick()
    fx.queries[0]?.resolve(rows(1)); await tick()
    check('3.8 …and the store recovers on the auth stream: 1 read, 1 live channel, snapshot 1', fx.queries.length === 1 && fx.live().length === 1 && s.getSnapshot() === 1)
    off()
  }

  // 3.9 A rejected count read keeps the last same-account number; the stream stays; the next read applies
  {
    const fx = fakeClient('tenant-a'); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    fx.queries[0].resolve(rows(7)); await tick()
    fx.live()[0].fire(); t.run(); await tick()
    const u0 = unhandled
    fx.queries[1].reject(new Error('network')); await settle()
    check('3.9 a rejected count read is caught: no unhandled rejection, snapshot still 7, channel intact',
      unhandled === u0 && s.getSnapshot() === 7 && fx.live().length === 1, `unhandled+${unhandled - u0} snap=${s.getSnapshot()} live=${fx.live().length}`)
    fx.live()[0].fire(); t.run(); await tick()
    fx.queries[2].resolve(rows(8)); await tick()
    check('3.9 …the next read applies (8)', s.getSnapshot() === 8)
    off()
  }

  // 3.10 An older good read landing after a newer FAILED one still applies (older data beats no data)
  {
    const fx = fakeClient('tenant-a'); const t = fakeTimers(); const s = S(fx, t)
    const off = s.subscribe(() => {}); await tick()
    fx.queries[0].resolve(rows(7)); await tick()
    fx.live()[0].fire(); t.run(); await tick()
    const older = fx.queries[1]
    fx.live()[0].fire(); t.run(); await tick()
    const newer = fx.queries[2]
    newer.resolve({ data: null, error: { message: 'timeout' } }); await tick()
    check('3.10 the newer read fails: still 7', s.getSnapshot() === 7)
    older.resolve(rows(3)); await tick()
    check('3.10 the older good read then lands (3): newer than what is showing, so it applies', s.getSnapshot() === 3, `${s.getSnapshot()}`)
    fx.live()[0].fire(); t.run(); await tick()
    fx.queries[3].resolve(rows(10)); await tick()
    check('3.10 ordering is still enforced afterwards (10)', s.getSnapshot() === 10)
    off()
  }

  check('no unhandled rejection escaped any case', unhandled === 0, `${unhandled}`)
}

main().then(() => {
  console.log(`\n${fail ? '✗' : '✅'} verify:shared-unread — one owner for the unread number: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}).catch(e => { console.error(e); process.exit(1) })
