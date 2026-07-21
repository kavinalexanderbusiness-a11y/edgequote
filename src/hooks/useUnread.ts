'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// ── THE app-wide unread count ────────────────────────────────────────────────
// One hook, one number: the sum of conversations.unread (muted excluded — mute
// means "stop counting this at me"; the row's own badge still shows inside the
// inbox). Kept live through the SAME Realtime table stream the inbox uses, so
// every consumer updates together without a refresh.
//
// Lifted verbatim from Sidebar so the mobile bottom nav could show the same
// badge. Two inline copies of this effect would be two subscriptions that can
// disagree about one number — the exact species of drift the sidebar/palette
// module loader already exists to prevent. Each consumer mounts its own
// subscription (Sidebar + BottomNav = 2 lightweight channels); if a third
// consumer ever appears, move this into a context provider instead of adding it.
export function useUnread(): number {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let active = true
    async function refresh(userId: string) {
      const { data } = await supabase.from('conversations').select('unread').eq('user_id', userId).gt('unread', 0).eq('muted', false)
      if (active) setUnread((data as { unread: number }[] | null)?.reduce((s, c) => s + (c.unread || 0), 0) || 0)
    }
    ;(async () => {
      // Local session read — no auth round-trip; RLS scopes the stream to us.
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user || !active) return
      await refresh(user.id)
      channel = supabase
        .channel(`unread:${user.id}:${Math.random().toString(36).slice(2, 8)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${user.id}` }, () => refresh(user.id))
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, [])

  return unread
}
