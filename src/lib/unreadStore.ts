// ── THE app-wide unread count: one store, one read, one channel ─────────────
// The number every badge shows — the sum of conversations.unread for THIS
// account, muted conversations excluded (mute means "stop counting this at
// me"; the row's own badge still shows inside the inbox). Kept live through
// ONE Realtime stream on the conversations table.
//
// Before this file the number had three owners: hooks/useUnread opened its own
// query + channel per consumer (the Sidebar and the BottomNav = two channels),
// and CommsNav ran a third copy of the same query on every navigation, with no
// stream at all — so the Inbox pill could lag the sidebar badge until the next
// route change. useUnread's own comment named the fix: "if a third consumer
// ever appears, move this into a [shared store] instead of adding it". This is
// that store — the same shape as NotificationBell's feed and useModules
// (ref-counted: the first subscriber starts the read and the stream, the last
// one tears them down), pure and framework-free so a guard can drive it with a
// fake client and prove every rule below without a browser or a database.
//
// Rules the store holds:
//   • TENANT SCOPE — the query and the stream filter both carry the signed-in
//     user's id; nothing is ever read unscoped.
//   • MUTED EXCLUDED — `.eq('muted', false)` on the read.
//   • STALE RESPONSES DROPPED — every read carries a sequence number and the
//     generation it was issued in; a response that is older than one already
//     applied, or from before a stop/account switch, is ignored.
//   • A FAILED READ KEEPS THE LAST NUMBER — an error is not "nothing waiting".
//     (The old hook rendered 0 on a failed read: a false all-clear.)
//   • ACCOUNT CHANGE — sign-out zeroes and closes the stream; a different user
//     signing in gets a fresh scoped read and stream; the same user's token
//     refreshes are ignored.
//   • CLEANUP — the last unsubscribe removes the channel, the auth listener and
//     any pending debounce, and resets to 0 so no one inherits a number.
//   • BURSTS COALESCE — a trailing 250 ms debounce on stream events, matching
//     useRealtimeRefresh and the bell.
//
// The scheduled-messages pending count that CommsNav also shows is NOT here:
// it has one consumer and a different table. One store per number.

export interface UnreadSession { user?: { id: string } | null }

/** The slice of a Supabase browser client this store touches. Narrow on
 *  purpose: the real client satisfies it structurally, and a guard's fake
 *  implements exactly this much. */
export interface UnreadClient {
  auth: {
    getSession(): Promise<{ data: { session: UnreadSession | null } }>
    onAuthStateChange(callback: (event: string, session: UnreadSession | null) => void): { data: { subscription: { unsubscribe(): void } } }
  }
  from(table: string): { select(columns: string): UnreadFilter }
  channel(name: string): UnreadChannel
  removeChannel(channel: UnreadChannel): unknown
}

export interface UnreadRow { unread: number | null }
export interface UnreadResult { data: UnreadRow[] | null; error: { message: string } | null }
export interface UnreadFilter extends PromiseLike<UnreadResult> {
  eq(column: string, value: string | number | boolean): UnreadFilter
  gt(column: string, value: number): UnreadFilter
}
export interface UnreadChannel {
  on(type: 'postgres_changes', filter: { event: string; schema: string; table: string; filter: string }, callback: () => void): UnreadChannel
  subscribe(): UnreadChannel
}

export interface UnreadStoreDeps {
  client: () => UnreadClient
  /** Trailing debounce for stream bursts. Default 250 ms. */
  debounceMs?: number
  /** Timer injection for tests. Defaults to the platform timers. */
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface UnreadStore {
  /** useSyncExternalStore-shaped. Ref-counted: the first listener starts the
   *  read and the stream; the last one's unsubscribe tears them down. */
  subscribe(listener: () => void): () => void
  getSnapshot(): number
  getServerSnapshot(): number
}

export function createUnreadStore(deps: UnreadStoreDeps): UnreadStore {
  const debounceMs = deps.debounceMs ?? 250
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const listeners = new Set<() => void>()
  let count = 0
  let refs = 0
  let running = false
  let client: UnreadClient | null = null
  let uid: string | null = null
  let channel: UnreadChannel | null = null
  let authSub: { unsubscribe(): void } | null = null
  let timer: unknown = null
  // `gen` changes on every start, stop and account switch: a response issued
  // under an older generation belongs to a world that no longer exists.
  // `seq`/`applied` order responses within a generation: a slow read that
  // lands after a newer one must not overwrite it.
  let gen = 0
  let seq = 0
  let applied = 0

  function set(n: number) {
    if (n === count) return
    count = n
    for (const l of Array.from(listeners)) l()
  }

  async function refresh(): Promise<void> {
    const c = client, u = uid
    if (!c || !u) return
    const g = gen, s = ++seq
    const { data, error } = await c.from('conversations').select('unread')
      .eq('user_id', u).gt('unread', 0).eq('muted', false)
    if (g !== gen || s <= applied) return
    applied = s
    if (error) return
    set((data ?? []).reduce((sum, row) => sum + (row.unread || 0), 0))
  }

  function scheduleRefresh() {
    if (timer != null) clearT(timer)
    timer = setT(() => { timer = null; void refresh() }, debounceMs)
  }

  function detach() {
    if (timer != null) { clearT(timer); timer = null }
    if (channel && client) client.removeChannel(channel)
    channel = null
    uid = null
  }

  function attach(id: string) {
    const c = client
    if (!c) return
    uid = id
    void refresh()
    // A fresh topic per attach: supabase-js reuses a topic name, and adding a
    // postgres_changes binding to a channel that already subscribed throws.
    channel = c.channel(`unread:${id}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${id}` }, scheduleRefresh)
      .subscribe()
  }

  function switchAccount(next: string | null) {
    if (next === uid) return
    gen++
    detach()
    set(0)
    if (next) attach(next)
  }

  async function start(): Promise<void> {
    running = true
    gen++
    const g = gen
    const c = deps.client()
    client = c
    authSub = c.auth.onAuthStateChange((_event, session) => {
      if (running) switchAccount(session?.user?.id ?? null)
    }).data.subscription
    // Local session read — no auth round-trip; RLS scopes the read and the
    // stream to this user anyway.
    const { data: { session } } = await c.auth.getSession()
    if (g !== gen) return // stopped, or an auth event already attached, while this was in flight
    const id = session?.user?.id ?? null
    if (id) attach(id); else set(0)
  }

  function stop() {
    running = false
    gen++
    detach()
    if (authSub) { authSub.unsubscribe(); authSub = null }
    client = null
    seq = 0
    applied = 0
    set(0)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (++refs === 1) void start()
      let done = false
      return () => {
        if (done) return
        done = true
        listeners.delete(listener)
        if (refs > 0 && --refs === 0) stop()
      }
    },
    getSnapshot: () => count,
    getServerSnapshot: () => 0,
  }
}
