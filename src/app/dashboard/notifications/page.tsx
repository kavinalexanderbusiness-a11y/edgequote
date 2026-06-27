'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { AppNotification } from '@/components/notifications/NotificationBell'
import { MorningBriefing } from '@/components/notifications/MorningBriefing'
import { groupNotifications, type NotifGroup } from '@/lib/notifications'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { Bell, Check, FileText, DollarSign, Loader2, MessageSquare, Globe, Star, CreditCard, AlertTriangle, RotateCcw, ShieldAlert, ChevronDown } from 'lucide-react'

const ICON: Record<string, typeof FileText> = {
  quote_accepted: FileText, invoice_paid: DollarSign,
  new_message: MessageSquare, portal_request: Globe, review_received: Star,
  payment_failed: CreditCard, autopay_review: AlertTriangle, website_lead: Globe,
  payment_refunded: RotateCcw, payment_disputed: ShieldAlert,
}
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  async function load(userId: string) {
    setUid(userId)
    // A failed fetch must NOT render as "No notifications yet" — the owner could miss
    // a payment_failed / autopay_review alert. Distinguish error from genuinely empty.
    const { data, error } = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(100)
    if (error) { setLoadError('Could not load notifications: ' + error.message); setLoading(false); return }
    setLoadError(null)
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
  function openGroup(g: NotifGroup) {
    if (g.count === 1) { openItem(g.items[0]); return }
    setExpanded(prev => { const s = new Set(prev); s.has(g.key) ? s.delete(g.key) : s.add(g.key); return s })
    if (g.unread) markRead(g.ids)
  }

  const { actionNeeded, activity, totalUnread } = useMemo(() => groupNotifications(items), [items])

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Notifications" description="Grouped and prioritized — only what needs you."
        action={totalUnread > 0 ? <Button variant="secondary" size="sm" onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}><Check className="w-3.5 h-3.5" /> Mark all read</Button> : undefined} />

      <MorningBriefing />

      {loadError && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
          {loadError} <button onClick={() => { setLoading(true); if (uid) load(uid) }} className="underline font-medium ml-1">Retry</button>
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : loadError ? null : items.length === 0 ? (
        <div className="py-12 text-center">
          <Bell className="w-10 h-10 text-ink-faint mx-auto mb-3" />
          <p className="text-sm font-medium text-ink">You&apos;re all caught up</p>
          <p className="text-xs text-ink-muted mt-1">Quote accepted, invoice paid, customer replies and alerts will appear here — grouped.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Needs attention — money/trust problems, never grouped, never buried */}
          {actionNeeded.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Needs attention</h2>
              <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.04] divide-y divide-border overflow-hidden">
                {actionNeeded.map(g => {
                  const Icon = ICON[g.type] || Bell
                  return (
                    <button key={g.key} onClick={() => openItem(g.items[0])}
                      className={cn('w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface/40 transition-colors', g.unread && 'bg-amber-500/[0.06]')}>
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border border-amber-500/30 bg-amber-500/10 text-amber-300"><Icon className="w-4.5 h-4.5" /></div>
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-sm', g.unread ? 'font-semibold text-ink' : 'text-ink-muted')}>{g.title}</p>
                        {g.body && <p className="text-xs text-ink-muted mt-0.5">{g.body}</p>}
                        <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(g.latestAt)}</p>
                      </div>
                      {g.unread > 0 && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 mt-2" />}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {/* Recent activity — wins & chatter, grouped by type, expandable */}
          {activity.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Recent activity</h2>
              <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
                {activity.map(g => {
                  const Icon = ICON[g.type] || Bell
                  const isOpen = expanded.has(g.key)
                  return (
                    <div key={g.key}>
                      <button onClick={() => openGroup(g)}
                        className={cn('w-full text-left px-4 py-3.5 flex items-start gap-3 hover:bg-surface/40 transition-colors', g.unread && 'bg-accent/[0.04]')}>
                        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border', g.unread ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border text-ink-muted')}><Icon className="w-4.5 h-4.5" /></div>
                        <div className="min-w-0 flex-1">
                          <p className={cn('text-sm flex items-center gap-2', g.unread ? 'font-semibold text-ink' : 'text-ink-muted')}>
                            {g.title}
                            {g.count > 1 && <span className="text-[10px] font-semibold text-ink-faint border border-border rounded-full px-1.5 py-0.5">{g.count}</span>}
                          </p>
                          {g.body && <p className="text-xs text-ink-muted mt-0.5 truncate">{g.body}</p>}
                          <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(g.latestAt)}</p>
                        </div>
                        {g.unread > 0 && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-2" />}
                        {g.count > 1 && <ChevronDown className={cn('w-4 h-4 text-ink-faint shrink-0 mt-1.5 transition-transform', isOpen && 'rotate-180')} />}
                      </button>
                      {/* Expanded individual items within the group */}
                      {isOpen && g.count > 1 && (
                        <div className="bg-bg-tertiary/40 divide-y divide-border/60 border-t border-border">
                          {g.items.map(n => (
                            <button key={n.id} onClick={() => openItem(n)}
                              className="w-full text-left pl-16 pr-4 py-2.5 flex items-start gap-2 hover:bg-surface/40 transition-colors">
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-ink">{n.title}</p>
                                {n.body && <p className="text-[11px] text-ink-muted truncate">{n.body}</p>}
                                <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(n.created_at)}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
