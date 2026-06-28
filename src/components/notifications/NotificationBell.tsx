'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Bell, Check, FileText, DollarSign, MessageSquare, Globe, Star, CreditCard, AlertTriangle, RotateCcw, ShieldAlert } from 'lucide-react'

export interface AppNotification {
  id: string
  created_at: string
  type: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  // Optional management fields (present once RUN-2026-06-27-notification-manage.sql
  // is applied; undefined before that — callers degrade gracefully).
  snoozed_until?: string | null
  archived_at?: string | null
}

const ICON: Record<string, typeof FileText> = {
  quote_accepted: FileText, invoice_paid: DollarSign,
  new_message: MessageSquare, portal_request: Globe, review_received: Star,
  payment_failed: CreditCard, autopay_review: AlertTriangle, website_lead: Globe,
  payment_refunded: RotateCcw, payment_disputed: ShieldAlert,
}
const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }

// Fixed-position coordinates for the dropdown panel, measured from the bell.
interface PanelPos { top: number; left: number; width: number; maxHeight: number }

// In-app notification bell — quote-accepted / invoice-paid / message / portal /
// review alerts with a live unread badge. Self-contained (own fetch + Realtime).
// The dropdown is rendered in a portal with fixed, viewport-clamped coordinates so
// it's ALWAYS fully visible (GitHub/Slack style) regardless of where the bell sits
// or how narrow the screen is — never clipped by the sidebar or the viewport edge.
export function NotificationBell() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PanelPos | null>(null)
  const [mounted, setMounted] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  async function load(userId: string) {
    // Active feed only — hide archived/snoozed so the bell matches the page. Falls
    // back to the legacy columns if the manage migration hasn't run yet.
    const managed = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read, snoozed_until, archived_at')
      .eq('user_id', userId).is('archived_at', null).order('created_at', { ascending: false }).limit(30)
    let data = managed.data as AppNotification[] | null
    if (managed.error && /archived_at|snoozed_until|column/i.test(managed.error.message)) {
      const legacy = await supabase.from('notifications')
        .select('id, created_at, type, title, body, href, read')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(30)
      data = legacy.data as AppNotification[] | null
    }
    const now = Date.now()
    const rows = (data || []).filter(n => !n.snoozed_until || new Date(n.snoozed_until).getTime() <= now).slice(0, 20)
    setItems(rows)
  }

  useEffect(() => {
    let active = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid || !active) return
      await load(uid)
      channel = supabase.channel(`notif:${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, () => load(uid))
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const unread = items.filter(n => !n.read).length

  // App-icon badge (installed PWA) mirrors the unread count; cleared at zero.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (typeof navigator === 'undefined' || !nav.setAppBadge) return
    if (unread > 0) nav.setAppBadge(unread).catch(() => {})
    else nav.clearAppBadge?.().catch(() => {})
  }, [unread])

  // Measure the bell and clamp the panel fully inside the viewport. Right-aligned
  // to the bell on wide screens; shifts inward (and shrinks) as space runs out.
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(360, vw - margin * 2)
    let left = b.right - width                       // align panel's right edge to the bell
    left = Math.min(left, vw - width - margin)        // keep inside the right edge
    left = Math.max(margin, left)                     // keep inside the left edge
    const top = Math.min(b.bottom + 8, vh - 160)      // never push the panel off the bottom
    const maxHeight = Math.max(200, vh - top - margin)
    setPos({ top, left, width, maxHeight })
  }, [])

  function toggle() {
    if (open) { setOpen(false); return }
    place()
    setOpen(true)
  }

  // Keep it pinned while open: reposition on resize/scroll, close on Escape or an
  // outside click (accounting for the portaled panel living outside this subtree).
  useLayoutEffect(() => { if (open) place() }, [open, place])
  useEffect(() => {
    if (!open) return
    const reposition = () => place()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, place])

  async function markRead(ids: string[]) {
    if (!ids.length) return
    setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n))
    await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
  }
  function openItem(n: AppNotification) {
    markRead([n.id]); setOpen(false)
    if (n.href) router.push(n.href)
  }

  const panel = open && pos && (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
      className="z-[100] flex flex-col rounded-card border border-border bg-bg-secondary shadow-2xl overflow-hidden origin-top-right animate-[popIn_0.12s_ease-out]">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between shrink-0">
        <p className="text-sm font-bold text-ink">Notifications</p>
        {unread > 0 && (
          <button onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}
            className="text-[11px] font-medium text-accent hover:underline flex items-center gap-1"><Check className="w-3 h-3" /> Mark all read</button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-border overscroll-contain">
        {items.length === 0 ? (
          <InlineEmpty icon={Bell}>You&apos;re all caught up — no notifications.</InlineEmpty>
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
        className="block px-4 py-2.5 text-center text-xs font-medium text-accent hover:underline border-t border-border shrink-0">
        See all notifications
      </Link>
    </div>
  )

  return (
    <div className="relative shrink-0">
      <button ref={btnRef} onClick={toggle} aria-label="Notifications" aria-expanded={open}
        className="relative h-9 w-9 rounded-lg border border-border text-ink-muted hover:text-ink hover:bg-surface flex items-center justify-center">
        <Bell className="w-4.5 h-4.5" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent text-black text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </div>
  )
}
