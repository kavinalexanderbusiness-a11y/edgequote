'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { AppNotification } from '@/components/notifications/NotificationBell'
import { groupNotifications, notificationActionLabel, type NotifGroup } from '@/lib/notifications'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { cn } from '@/lib/utils'
import { Bell, Check, FileText, DollarSign, MessageSquare, Globe, Star, CreditCard, AlertTriangle, RotateCcw, ShieldAlert, ShieldCheck, ChevronDown, Clock, X, Archive } from 'lucide-react'

const ICON: Record<string, typeof FileText> = {
  quote_accepted: FileText, invoice_paid: DollarSign,
  new_message: MessageSquare, portal_request: Globe, review_received: Star,
  payment_failed: CreditCard, autopay_review: AlertTriangle, website_lead: Globe,
  payment_refunded: RotateCcw, payment_disputed: ShieldAlert,
  payment_dispute_lost: ShieldAlert, payment_dispute_won: ShieldCheck,
}
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }
// A website lead arrives as a portal_request whose body is the "New … lead — …"
// summary. Detect it at the render layer so a hot prospect gets the lead treatment
// (title, Build-quote action, accent) instead of reading like ordinary portal chatter.
const isLeadNotif = (n: AppNotification | undefined): boolean =>
  !!n && n.type === 'portal_request' && /new\b[^]*\blead/i.test(n.body || '')
// "Remind me later" → tomorrow at 8am local.
function tomorrow8am(): string { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString() }

export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // True once snooze/archive columns exist (migration applied). Until then those
  // controls are hidden and Dismiss falls back to "mark read".
  const [supportsManage, setSupportsManage] = useState(false)

  async function load(userId: string) {
    setUid(userId)
    // Prefer the managed query (active = not archived). Fall back to the legacy
    // columns if the migration hasn't run yet, so the page never breaks.
    let supports = true
    const managed = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read, snoozed_until, archived_at')
      .eq('user_id', userId).is('archived_at', null).order('created_at', { ascending: false }).limit(100)
    let data = managed.data as AppNotification[] | null
    let error = managed.error as { message: string } | null
    if (error && /archived_at|snoozed_until|column/i.test(error.message)) {
      supports = false
      const legacy = await supabase.from('notifications')
        .select('id, created_at, type, title, body, href, read')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(100)
      data = legacy.data as AppNotification[] | null
      error = legacy.error as { message: string } | null
    }
    if (error) { setLoadError('Could not load notifications: ' + error.message); setLoading(false); return }
    setLoadError(null)
    setSupportsManage(supports)
    setItems(data || [])
    setLoading(false)
  }
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

  // Snoozed items (still active) drop out of the feed until their time passes.
  const nowMs = Date.now()
  const visible = useMemo(() => items.filter(n => !n.snoozed_until || new Date(n.snoozed_until).getTime() <= nowMs), [items, nowMs])
  const snoozedCount = items.length - visible.length
  const { actionNeeded, activity, totalUnread } = useMemo(() => groupNotifications(visible), [visible])

  // These three act optimistically and the realtime channel only fires on SUCCESSFUL
  // changes — so a failed write produces no correction event at all. Unchecked, items
  // vanished on tap and silently resurrected on the next visit. Roll the list back to what
  // the server actually holds rather than leave a cleared inbox that isn't cleared.
  async function markRead(ids: string[]) {
    if (!ids.length) return
    const prevItems = items
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n))
    const { error } = await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
    if (error) { setItems(prevItems); toast.error('Could not mark these as read — please try again.') }
  }
  async function snooze(ids: string[]) {
    if (!supportsManage || !ids.length) return
    const until = tomorrow8am()
    const prevItems = items
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, snoozed_until: until } : n))
    const { error } = await supabase.from('notifications').update({ snoozed_until: until }).in('id', ids)
    if (error) { setItems(prevItems); toast.error('Could not snooze these — please try again.') }
  }
  async function dismiss(ids: string[]) {
    if (!ids.length) return
    if (!supportsManage) { await markRead(ids); return } // pre-migration: dismiss = mark read
    const prevItems = items
    setItems(prev => prev.filter(n => !ids.includes(n.id)))
    const { error } = await supabase.from('notifications').update({ archived_at: new Date().toISOString() }).in('id', ids)
    if (error) { setItems(prevItems); toast.error('Could not archive these — please try again.') }
  }
  function openItem(n: AppNotification) { markRead([n.id]); if (n.href) router.push(n.href) }
  function toggle(key: string) { setExpanded(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s }) }

  const readVisible = visible.filter(n => n.read)

  // Per-row action cluster: one-click action (navigate) + snooze + dismiss.
  function Controls({ g, actionLabel }: { g: NotifGroup; actionLabel?: string; compact?: boolean }) {
    return (
      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        {g.count === 1 && g.href && (
          <button onClick={() => openItem(g.items[0])}
            className="text-[11px] font-semibold text-accent-text hover:underline px-1.5 py-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 tap-target-y">{actionLabel ?? notificationActionLabel(g.type)}</button>
        )}
        {supportsManage && (
          <button onClick={() => snooze(g.ids)} title="Remind me tomorrow" aria-label="Snooze"
            className="h-7 w-7 rounded-lg text-ink-faint hover:text-ink hover:bg-surface flex items-center justify-center tap-target"><Clock className="w-3.5 h-3.5" /></button>
        )}
        <button onClick={() => dismiss(g.ids)} title={supportsManage ? 'Dismiss' : 'Mark read'} aria-label="Dismiss"
          className="h-7 w-7 rounded-lg text-ink-faint hover:text-ink hover:bg-surface flex items-center justify-center tap-target">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader title="Notifications" description="Grouped and prioritized — only what needs you."
        action={(totalUnread > 0 || readVisible.length > 0) ? (
          <div className="flex items-center gap-2">
            {totalUnread > 0 && <Button variant="secondary" size="sm" onClick={() => markRead(visible.filter(n => !n.read).map(n => n.id))}><Check className="w-3.5 h-3.5" /> Mark all read</Button>}
            {supportsManage && readVisible.length > 0 && <Button variant="ghost" size="sm" onClick={() => dismiss(readVisible.map(n => n.id))}><Archive className="w-3.5 h-3.5" /> Archive read</Button>}
          </div>
        ) : undefined} />

      {/* The morning briefing that used to sit here now IS the dashboard (money,
          weather, priorities) — one morning digest, not two competing ones. */}

      {loadError && (
        <Banner tone="danger">
          {loadError} <button onClick={() => { setLoading(true); if (uid) load(uid) }} className="underline font-medium ml-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">Retry</button>
        </Banner>
      )}

      {loading ? (
        <SkeletonRows count={5} />
      ) : loadError ? null : visible.length === 0 ? (
        <EmptyState icon={Bell} tone="positive" className="py-16" title="You're all caught up"
          description={<>New website leads, quotes accepted, invoices paid, customer replies and alerts will appear here — grouped.
            {snoozedCount > 0 && <span className="block text-[11px] text-ink-faint mt-2">{snoozedCount} snoozed for later</span>}</>} />
      ) : (
        <div className="space-y-4">
          {/* Needs attention — money/trust problems, never grouped, never buried */}
          {actionNeeded.length > 0 && (
            <section className="space-y-1.5 animate-rise">
              <SectionHeading eyebrow icon={AlertTriangle} title="Needs attention" />
              <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.04] divide-y divide-border overflow-hidden">
                {actionNeeded.map(g => {
                  const Icon = ICON[g.type] || Bell
                  return (
                    <div key={g.key} className={cn('px-4 py-3 flex items-start gap-3', g.unread && 'bg-amber-500/[0.06]')}>
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border border-amber-500/30 bg-amber-500/10 text-amber-300"><Icon className="w-4 h-4" /></div>
                      <button onClick={() => openItem(g.items[0])} className="min-w-0 flex-1 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                        <p className={cn('text-sm', g.unread ? 'font-semibold text-ink' : 'text-ink-muted')}>{g.title}</p>
                        {g.body && <p className="text-xs text-ink-muted mt-0.5">{g.body}</p>}
                        <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(g.latestAt)}</p>
                      </button>
                      <Controls g={g} />
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* Recent activity — wins & chatter, grouped by type, expandable */}
          {activity.length > 0 && (
            <section className="space-y-1.5 animate-rise stagger-1">
              <SectionHeading eyebrow title="Recent activity"
                action={snoozedCount > 0 ? <span className="text-[10px] text-ink-faint flex items-center gap-1"><Clock className="w-3 h-3" /> {snoozedCount} snoozed</span> : undefined} />
              <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
                {activity.map(g => {
                  const lead = isLeadNotif(g.items[0])
                  const Icon = lead ? Globe : (ICON[g.type] || Bell)
                  const isOpen = expanded.has(g.key)
                  const onMain = () => g.count === 1 ? openItem(g.items[0]) : toggle(g.key)
                  const title = lead ? (g.count > 1 ? `${g.count} new website leads` : 'New website lead') : g.title
                  const emphasise = lead || g.unread
                  return (
                    <div key={g.key}>
                      <div className={cn('px-4 py-3.5 flex items-start gap-3', lead ? 'bg-accent/[0.06]' : g.unread && 'bg-accent/[0.04]')}>
                        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border', emphasise ? 'border-accent/30 bg-accent/10 text-accent-text' : 'border-border text-ink-muted')}><Icon className="w-4 h-4" /></div>
                        <button onClick={onMain} className="min-w-0 flex-1 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                          <p className={cn('text-sm flex items-center gap-2', emphasise ? 'font-semibold text-ink' : 'text-ink-muted')}>
                            {title}
                            {lead && <span className="text-[9px] font-bold text-black bg-accent rounded-full px-1.5 py-px leading-none tracking-wider shrink-0">NEW</span>}
                            {g.count > 1 && <span className="text-[10px] font-semibold text-ink-faint border border-border rounded-full px-1.5 py-0.5">{g.count}</span>}
                          </p>
                          {g.body && <p className="text-xs text-ink-muted mt-0.5 truncate">{g.body}</p>}
                          <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(g.latestAt)}</p>
                        </button>
                        {g.count > 1 && <ChevronDown aria-hidden="true" className={cn('w-4 h-4 text-ink-faint shrink-0 mt-1.5 transition-transform', isOpen && 'rotate-180')} />}
                        <Controls g={g} actionLabel={lead ? 'Build quote' : undefined} compact />
                      </div>
                      {isOpen && g.count > 1 && (
                        <div className="bg-bg-tertiary/40 divide-y divide-border/60 border-t border-border">
                          {g.items.map(n => {
                            const nLead = isLeadNotif(n)
                            return (
                            <div key={n.id} className="pl-16 pr-3 py-2.5 flex items-start gap-2">
                              <button onClick={() => openItem(n)} className="min-w-0 flex-1 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                                <p className="text-xs text-ink">{nLead ? 'New website lead' : n.title}</p>
                                {n.body && <p className="text-[11px] text-ink-muted truncate">{n.body}</p>}
                                <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(n.created_at)}</p>
                              </button>
                              <div className="flex items-center gap-1 shrink-0">
                                {n.href && <button onClick={() => openItem(n)} className="text-[11px] font-semibold text-accent-text hover:underline px-1.5 py-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 tap-target-y">{nLead ? 'Build quote' : notificationActionLabel(n.type)}</button>}
                                {supportsManage && <button onClick={() => snooze([n.id])} title="Remind me tomorrow" aria-label="Snooze" className="h-6 w-6 rounded-lg text-ink-faint hover:text-ink hover:bg-surface flex items-center justify-center tap-target"><Clock className="w-3 h-3" /></button>}
                                <button onClick={() => dismiss([n.id])} title={supportsManage ? 'Dismiss' : 'Mark read'} aria-label="Dismiss" className="h-6 w-6 rounded-lg text-ink-faint hover:text-ink hover:bg-surface flex items-center justify-center tap-target"><X className="w-3 h-3" /></button>
                              </div>
                            </div>
                            )})}
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
