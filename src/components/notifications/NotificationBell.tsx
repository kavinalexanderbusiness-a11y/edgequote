'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Bell, Check, FileText, DollarSign } from 'lucide-react'

export interface AppNotification {
  id: string
  created_at: string
  type: string
  title: string
  body: string | null
  href: string | null
  read: boolean
}

const ICON: Record<string, typeof FileText> = { quote_accepted: FileText, invoice_paid: DollarSign }
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

// In-app notification bell — quote-accepted / invoice-paid alerts with a live unread
// badge. Self-contained (own fetch + Realtime), so it drops into the sidebar header
// with one line and never depends on other nav state.
export function NotificationBell() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(20)
    setItems((data as AppNotification[]) || [])
  }

  useEffect(() => {
    let active = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      await load()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !active) return
      channel = supabase.channel(`notif:${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, () => load())
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const unread = items.filter(n => !n.read).length

  async function markRead(ids: string[]) {
    if (!ids.length) return
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n))
    await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
  }
  function openItem(n: AppNotification) {
    markRead([n.id]); setOpen(false)
    if (n.href) router.push(n.href)
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen(o => !o)} aria-label="Notifications"
        className="relative h-9 w-9 rounded-lg border border-border text-ink-muted hover:text-ink hover:bg-surface flex items-center justify-center">
        <Bell className="w-4.5 h-4.5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent text-black text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[88vw] rounded-card border border-border bg-bg-secondary shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
            <p className="text-sm font-bold text-ink">Notifications</p>
            {unread > 0 && (
              <button onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}
                className="text-[11px] font-medium text-accent hover:underline flex items-center gap-1"><Check className="w-3 h-3" /> Mark all read</button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
            {items.length === 0 ? (
              <p className="py-10 text-center text-xs text-ink-muted">No notifications yet.</p>
            ) : items.map(n => {
              const Icon = ICON[n.type] || Bell
              return (
                <button key={n.id} onClick={() => openItem(n)}
                  className={cn('w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface/40 transition-colors', !n.read && 'bg-accent/[0.04]')}>
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border', !n.read ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-ink-muted')}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm truncate', !n.read ? 'font-semibold text-ink' : 'text-ink-muted')}>{n.title}</p>
                    {n.body && <p className="text-[11px] text-ink-muted truncate">{n.body}</p>}
                    <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(n.created_at)}</p>
                  </div>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1.5" />}
                </button>
              )
            })}
          </div>
          <Link href="/dashboard/notifications" onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-center text-xs font-medium text-accent hover:underline border-t border-border">
            See all notifications
          </Link>
        </div>
      )}
    </div>
  )
}
