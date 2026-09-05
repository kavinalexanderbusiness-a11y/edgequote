// ── verify:shared-unread — one owner for the unread number ───────────────────
//   npx tsx scripts/verify-shared-unread.ts
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
// Synthetic throughout: nothing here touches Supabase.
import { readFileSync } from 'node:fs'
import { createUnreadStore, type UnreadClient, type UnreadChannel, type UnreadFilter, type UnreadResult, type UnreadSession } from '../src/lib/unreadStore'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}
const read = (p: string) => readFileSync(p, 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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
  check('CommsNav no longer reads conversations itself', !/from\('conversations'\)/.test(comms))
  check('CommsNav reads the shared number through useUnread', /const unread = useUnread\(\)/.test(comms))
  check('CommsNav keeps its own scheduled-messages pending count (one consumer, other table)',
    /from\('scheduled_messages'\)/.test(comms) && /\.eq\('status', 'pending'\)/.test(comms) && /setPending\(/.test(comms))
  check('Sidebar and BottomNav still read the same hook', /const unread = useUnread\(\)/.test(sidebar) && /const unread = useUnread\(\)/.test(bottom))
  const bindings = [store, hook, comms, sidebar, bottom].map(s => (s.match(/table: 'conversations'/g) || []).length)
  check('exactly one conversations stream binding across the five files (the store)', bindings.join() === '1,0,0,0,0', bindings.join())
}

// ── §2 behaviour against a fake client ───────────────────────────────────────
console.log('\n── §2 behaviour (fake client) ──')

interface Deferred { resolve(r: UnreadResult): void; uid: string; filters: [string, string, unknown][]; select: string; table: string }
interface FakeChannel extends UnreadChannel { name: string; subscribed: boolean; removed: boolean; binding: { event: string; schema: string; table: string; filter: string } | null; fire: () => void }

function fakeClient(sessionUid: string | null) {
  const queries: Deferred[] = []
  const channels: FakeChannel[] = []
  let sessionReads = 0
  let authListener: ((event: string, session: UnreadSession | null) => void) | null = null
  let authUnsubscribed = 0
  const client: UnreadClient = {
    auth: {
      async getSession() { sessionReads++; return { data: { session: sessionUid ? { user: { id: sessionUid } } : null } } },
      onAuthStateChange(cb) { authListener = cb; return { data: { subscription: { unsubscribe() { authUnsubscribed++; authListener = null } } } } },
    },
    from(table) {
      return {
        select(columns) {
          let resolve!: (r: UnreadResult) => void
          const p = new Promise<UnreadResult>(r => { resolve = r })
          const d: Deferred = { resolve, uid: '', filters: [], select: columns, table }
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
    client, queries, channels,
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
const rows = (...n: (number | null)[]): UnreadResult => ({ data: n.map(unread => ({ unread })), error: null })

async function main() {
  const fx = fakeClient('tenant-a')
  const t = fakeTimers()
  const store = createUnreadStore({ client: () => fx.client, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
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
  const notifiedBefore = { ...notified }
  offC(); offC() // the second call is a no-op, not a double-decrement
  check('last unsubscribe: channel removed, auth listener unsubscribed, debounce cleared, snapshot 0',
    ch3.removed && !fx.hasAuthListener() && fx.authUnsubscribed() === 1 && t.size() === 0 && store.getSnapshot() === 0)
  const reads = fx.queries.length
  ch3.fire(); t.run(); await tick()
  check('a stream event after teardown issues no read', fx.queries.length === reads)
  fx.emitAuth('SIGNED_IN', 'tenant-b'); await tick()
  check('an auth event after teardown is ignored (listener gone)', fx.queries.length === reads && fx.channels.length === 3)

  // Late response after teardown
  const fx2 = fakeClient('tenant-a')
  const t2 = fakeTimers()
  const s2 = createUnreadStore({ client: () => fx2.client, setTimeout: t2.setTimeout, clearTimeout: t2.clearTimeout })
  let heard = 0
  const off2 = s2.subscribe(() => { heard++ })
  await tick()
  off2()
  fx2.queries[0].resolve(rows(50)); await tick()
  check('a read that resolves after the last unsubscribe applies nothing and notifies no one', s2.getSnapshot() === 0 && heard === 0)
  const off3 = s2.subscribe(() => { heard++ }); await tick()
  check('subscribing again restarts cleanly (a second session read, a second channel)', fx2.sessionReads() === 2 && fx2.live().length === 1)
  off3()

  // No session at all
  const fx3 = fakeClient(null)
  const s3 = createUnreadStore({ client: () => fx3.client })
  const off4 = s3.subscribe(() => {}); await tick()
  check('with no session: no read, no channel, snapshot 0', fx3.queries.length === 0 && fx3.channels.length === 0 && s3.getSnapshot() === 0)
  off4()
}

main().then(() => {
  console.log(`\n${fail ? '✗' : '✅'} verify:shared-unread — one owner for the unread number: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}).catch(e => { console.error(e); process.exit(1) })
