'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { AppNotification } from '@/components/notifications/NotificationBell'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import { Bell, Check, FileText, DollarSign, MessageSquare, Globe, Star } from 'lucide-react'

const ICON: Record<string, typeof FileText> = {
  quote_accepted: FileText, invoice_paid: DollarSign,
  new_message: MessageSquare, portal_request: Globe, review_received: Star,
}
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)

  async function load(userId: string) {
    const { data } = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(100)
    setItems((data as AppNotification[]) || [])
    setLoading(false)
  }
  // Initial load + live updates (the bell and this page stay in sync without a refresh).
  useEffect(() => {
    let active = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { setLoading(false); return }
      if (!active) return
      await load(uid)
      channel = supabase.channel(`notif-page:${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, () => load(uid))
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function markRead(ids: string[]) {
    if (!ids.length) return
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n))
    await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
  }
  function openItem(n: AppNotification) { markRead([n.id]); if (n.href) router.push(n.href) }

  const unread = items.filter(n => !n.read).length

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Notifications" description="Quote accepted and invoice paid alerts."
        action={unread > 0 ? <Button variant="secondary" size="sm" onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}><Check className="w-3.5 h-3.5" /> Mark all read</Button> : undefined} />

      {loading ? (
        <SkeletonRows count={6} />
      ) : items.length === 0 ? (
        <EmptyState icon={Bell} title="No notifications yet"
          description="When a customer accepts a quote or pays an invoice, you’ll see it here." />
      ) : (
        <div className="rounded-card border border-border bg-surface divide-y divide-border overflow-hidden">
          {items.map(n => {
            const Icon = ICON[n.type] || Bell
            return (
              <button key={n.id} onClick={() => openItem(n)}
                className={cn('w-full text-left px-4 py-3.5 flex items-start gap-3 hover:bg-surface-raised transition-colors', !n.read && 'bg-accent/[0.04]')}>
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border', !n.read ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-ink-muted')}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm', !n.read ? 'font-semibold text-ink' : 'text-ink-muted')}>{n.title}</p>
                  {n.body && <p className="text-xs text-ink-muted mt-0.5">{n.body}</p>}
                  <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(n.created_at)}</p>
                </div>
                {!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-2" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
