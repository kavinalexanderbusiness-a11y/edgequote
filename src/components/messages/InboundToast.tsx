'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'

// ── Foreground attention for inbound messages ──────────────────────────────────
// The one gap every notification audit found: with the app OPEN on some other
// page, a new text was a silent badge. OS push covers the closed-tab case; this
// covers the open one — a toast through THE toast system with a one-tap Reply
// that deep-links into the conversation (?c=). Quiet on the inbox itself (the
// list updates live there) and for muted conversations (mute means mute).
export function InboundToast() {
  const router = useRouter()
  const pathname = usePathname()
  const pathRef = useRef(pathname); pathRef.current = pathname
  const routerRef = useRef(router); routerRef.current = router

  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid || !active) return
      channel = supabase.channel(`inbound-toast:${uid}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `user_id=eq.${uid}` }, async payload => {
          const m = payload.new as { direction?: string; customer_id?: string; body?: string }
          if (m.direction !== 'inbound' || !m.customer_id) return
          // Already looking at messaging — the inbox and thread update live. Same
          // for THIS customer's profile page (it embeds the same live thread).
          if (pathRef.current.startsWith('/dashboard/messages')) return
          if (pathRef.current.includes(m.customer_id)) return
          const [convo, cust] = await Promise.all([
            supabase.from('conversations').select('muted').eq('customer_id', m.customer_id).maybeSingle(),
            supabase.from('customers').select('name').eq('id', m.customer_id).maybeSingle(),
          ])
          if ((convo.data as { muted?: boolean } | null)?.muted) return
          const name = (cust.data as { name?: string } | null)?.name || 'A customer'
          const preview = (m.body || '').replace(/\s+/g, ' ').slice(0, 90)
          const cid = m.customer_id
          toast(`${name}: ${preview}`, {
            tone: 'info', duration: 8000,
            action: { label: 'Reply', run: () => routerRef.current.push(`/dashboard/messages?c=${cid}`) },
          })
        })
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
