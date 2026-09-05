'use client'

import { useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { createUnreadStore, type UnreadClient, type UnreadChannel, type UnreadFilter, type UnreadRow } from '@/lib/unreadStore'

// ── THE app-wide unread count ────────────────────────────────────────────────
// One hook, one number, ONE store (lib/unreadStore): the sum of
// conversations.unread for this account, muted excluded, kept live through one
// Realtime channel however many badges are on screen — the Sidebar, the
// BottomNav and the Communications rail all read this same snapshot, so they
// can never disagree and never each open their own stream. The first consumer
// to mount starts the read and the channel; the last to unmount closes them.
// Tenant scope, stale-response protection, account-change handling and the
// failed-read rule live in the store, where verify:shared-unread proves them
// against a fake client.

// The real client, narrowed to the slice the store touches — written out call
// by call rather than cast, so a change in supabase-js's signatures fails
// typecheck here instead of at runtime. (A structural assignment of the whole
// client does not compile: RealtimeChannel.on is an overload set and the
// builder generics run too deep for the checker.)
function realClient(): UnreadClient {
  const sb = createClient()
  const channels = new WeakMap<UnreadChannel, ReturnType<typeof sb.channel>>()
  return {
    auth: {
      getSession: () => sb.auth.getSession(),
      onAuthStateChange: callback => sb.auth.onAuthStateChange((event, session) => callback(event, session)),
    },
    from: table => ({
      select: columns => {
        // PostgREST builders mutate in place and return themselves.
        const q = sb.from(table).select(columns)
        const f: UnreadFilter = {
          eq: (column, value) => { q.eq(column, value); return f },
          gt: (column, value) => { q.gt(column, value); return f },
          then: (onFulfilled, onRejected) => q
            // An untyped schema types this select as a generic row; the shape is the one the old hook narrowed to.
            .then(res => ({ data: res.data as unknown as UnreadRow[] | null, error: res.error ? { message: res.error.message } : null }))
            .then(onFulfilled, onRejected),
        }
        return f
      },
    }),
    channel: name => {
      const ch = sb.channel(name)
      const wrapped: UnreadChannel = {
        on: (_type, filter, callback) => {
          ch.on('postgres_changes', { event: '*', schema: filter.schema, table: filter.table, filter: filter.filter }, callback)
          return wrapped
        },
        subscribe: () => { ch.subscribe(); return wrapped },
      }
      channels.set(wrapped, ch)
      return wrapped
    },
    removeChannel: wrapped => {
      const ch = channels.get(wrapped)
      if (ch) void sb.removeChannel(ch)
    },
  }
}

const store = createUnreadStore({ client: realClient })

export function useUnread(): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}
