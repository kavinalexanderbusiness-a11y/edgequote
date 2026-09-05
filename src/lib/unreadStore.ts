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
//   • MUTED EXCLUDED — the read filters muted conversations out.
//   • AUTH EVENTS OUTRANK THE BOOTSTRAP READ — the first thing a start does is
//     read the local session; an auth event that arrives while that read is in
//     flight is later, authoritative information, so the read's answer is
//     dropped when it lands. (Found by review: a SIGNED_OUT during the
//     bootstrap used to be ignored because "null is already the attached
//     user", and the stale session answer then attached an account the auth
//     stream had already said was gone.) This is tracked apart from `gen` so a
//     same-user token refresh never discards an in-flight count read.
//   • STALE RESPONSES DROPPED — every read carries a sequence number and the
//     generation it was issued in; a response that is older than one already
//     applied, or from before a stop/account switch, is ignored.
//   • A FAILED READ KEEPS THE LAST NUMBER — an error is not "nothing waiting".
//     (The old hook rendered 0 on a failed read: a false all-clear.) A failed
//     read also does not close the door on an OLDER read still in flight: its
//     data is older than the failed attempt but newer than what is showing.
//   • REJECTIONS ARE CONTAINED — the session read and the count read are
//     fire-and-forget; a rejected promise is caught here, never an unhandled
//     rejection. A rejected session read attaches nothing (the auth stream
//     will speak); a rejected count read keeps the last number.
//   • ACCOUNT CHANGE — sign-out zeroes and closes the stream; a different user
//     signing in gets a fresh scoped read and stream; the same user's token
//     refreshes are ignored.
//   • CLEANUP — the last unsubscribe removes the channel, the auth listener and
//     any pending debounce, and resets to 0 so no one inherits a number. A
//     start → stop → start (React StrictMode's dev double mount) leaves exactly
//     one live stream and drops the first start's late answers.
//   • BURSTS COALESCE — a trailing 250 ms debounce on stream events, matching
//     useRealtimeRefresh and the bell.
//
// The scheduled-messages pending count that CommsNav also shows is NOT here:
// it has one consumer and a different table. One store per number.

export interface UnreadSession { user?: { id: string } | null }

/** The slice of a Supabase browser client this store touches. Narrow on
 *  purpose: hooks/useUnread adapts the real client to it call by call, and a
 *  guard's fake implements exactly this much. */
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
  // `seq`/`applied` order count reads within a generation: a slow read that
  // lands after a newer one must not overwrite it.
  // `bootstrapping` is true only while the start's session read is in flight
  // AND no auth event has spoken since; an auth event clears it without
  // touching `gen`, so the bootstrap answer is dropped but in-flight count
  // reads for the same account survive.
  let gen = 0
  let seq = 0
  let applied = 0
  let bootstrapping = false

  function set(n: number) {
    if (n === count) return
    count = n
    for (const l of Array.from(listeners)) l()
  }

  async function refresh(): Promise<void> {
    const c = client, u = uid
    if (!c || !u) return
    const g = gen, s = ++seq
    let result: UnreadResult
    try {
      result = await c.from('conversations').select('unread')
        .eq('user_id', u).gt('unread', 0).eq('muted', false)
    } catch {
      return // a rejected read keeps the last number; nothing else changes
    }
    if (g !== gen || s <= applied) return
    if (result.error) return // keep the last number; `applied` stays so an older good read may still land
    applied = s
    set((result.data ?? []).reduce((sum, row) => sum + (row.unread || 0), 0))
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
    bootstrapping = true
    authSub = c.auth.onAuthStateChange((_event, session) => {
      if (!running) return
      // Later information than the session read below: whatever that read
      // returns afterwards describes a session that has since changed (or
      // never was). Cleared here, not via `gen`, so a same-user event never
      // discards an in-flight count read.
      bootstrapping = false
      switchAccount(session?.user?.id ?? null)
    }).data.subscription
    // Local session read — no auth round-trip; RLS scopes the read and the
    // stream to this user anyway.
    let id: string | null
    try {
      const { data: { session } } = await c.auth.getSession()
      id = session?.user?.id ?? null
    } catch {
      // The session could not be read: attach nothing on a guess and stay at
      // 0; the auth stream registered above will say who this is.
      if (g === gen) bootstrapping = false
      return
    }
    if (g !== gen || !bootstrapping) return // stopped, or an auth event has already spoken
    bootstrapping = false
    if (id) attach(id); else set(0)
  }

  function stop() {
    running = false
    gen++
    bootstrapping = false
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
