'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { AppNotification } from '@/components/notifications/NotificationBell'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Bell, Check, FileText, DollarSign, Loader2 } from 'lucide-react'

const ICON: Record<string, typeof FileText> = { quote_accepted: FileText, invoice_paid: DollarSign }
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(100)
    setItems((data as AppNotification[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function markRead(ids: string[]) {
    if (!ids.length) return
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n))
    await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
  }
  function openItem(n: AppNotification) { markRead([n.id]); if (n.href) router.push(n.href) }

  const unread = items.filter(n => !n.read).length

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Notifications" description="Quote accepted and invoice paid alerts."
        action={unread > 0 ? <Button variant="secondary" size="sm" onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}><Check className="w-3.5 h-3.5" /> Mark all read</Button> : undefined} />

      {loading ? (
        <div className="py-16 text-center text-sm text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div className="py-16 text-center">
          <Bell className="w-10 h-10 text-ink-faint mx-auto mb-3" />
          <p className="text-sm font-medium text-ink">No notifications yet</p>
          <p className="text-xs text-ink-muted mt-1">When a customer accepts a quote or pays an invoice, you’ll see it here.</p>
        </div>
      ) : (
        <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
          {items.map(n => {
            const Icon = ICON[n.type] || Bell
            return (
              <button key={n.id} onClick={() => openItem(n)}
                className={cn('w-full text-left px-4 py-3.5 flex items-start gap-3 hover:bg-surface/40 transition-colors', !n.read && 'bg-accent/[0.04]')}>
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border', !n.read ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-ink-muted')}>
                  <Icon className="w-4.5 h-4.5" />
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
