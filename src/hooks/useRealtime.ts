'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// One shared browser client for ALL realtime hooks → every subscription
// multiplexes over a SINGLE WebSocket (many channels, one socket) instead of
// each component opening its own connection.
let _rt: ReturnType<typeof createClient> | null = null
function rtClient() { return (_rt ??= createClient()) }
let _seq = 0

type RtEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE'

// Subscribe to Postgres changes on `table` (scoped by `filter`, e.g.
// `user_id=eq.<uid>`) and run `onChange` whenever a matching row changes. The
// callback is held in a ref so re-renders never resubscribe; changes are
// debounced (250ms) so a burst of writes triggers a single refetch — no polling.
// Pass filter=null/undefined to stay dormant until the id is known.
export function useRealtimeRefresh(
  table: string,
  filter: string | null | undefined,
  onChange: () => void,
  event: RtEvent = '*',
) {
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    if (!filter) return
    const supabase = rtClient()
    let t: ReturnType<typeof setTimeout> | null = null
    const fire = () => { if (t) clearTimeout(t); t = setTimeout(() => cb.current(), 250) }
    const channel = supabase
      .channel(`rt:${table}:${filter}:${++_seq}`)
      .on('postgres_changes', { event, schema: 'public', table, filter }, fire)
      .subscribe()
    // postgres_changes are NOT replayed after a dropped connection or a tab that
    // was backgrounded (the socket may have been suspended), so any rows that
    // changed during the gap would be missed. Refetch once on reconnect / when the
    // tab becomes visible again so the view always self-heals. Debounced + batched.
    const onWake = () => { if (document.visibilityState === 'visible') fire() }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      if (t) clearTimeout(t)
      supabase.removeChannel(channel)
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [table, filter, event])
}
