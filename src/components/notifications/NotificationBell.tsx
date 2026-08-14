'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { cn, timeAgo } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { scheduleQuoteAsJob } from '@/lib/scheduleQuote'
import type { Quote } from '@/types'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Bell, Check, FileText, DollarSign, MessageSquare, MessagesSquare, Globe, Star, CreditCard, AlertTriangle, RotateCcw, ShieldAlert, ShieldCheck, CalendarPlus, Loader2 } from 'lucide-react'

export interface AppNotification {
  id: string
  created_at: string
  type: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  customer_id?: string | null
  // For one-click actions on the alert itself (e.g. quote_accepted → Schedule now).
  entity_type?: string | null
  entity_id?: string | null
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
  payment_dispute_lost: ShieldAlert, payment_dispute_won: ShieldCheck,
  // ⚠️ Deliberately a DIFFERENT icon from new_message (MessageSquare, singular).
  // That one is a CUSTOMER writing in; this one is the crew, internal to the
  // business. Same glyph for both would make the bell's two most similar-looking
  // rows mean opposite audiences.
  crew_message: MessagesSquare,
}

// Fixed-position coordinates for the dropdown panel, measured from the bell.
interface PanelPos { top: number; left: number; width: number; maxHeight: number }

// In-app notification bell — quote-accepted / invoice-paid / message / portal /
// review alerts with a live unread badge. Self-contained (own fetch + Realtime).
// The dropdown is rendered in a portal with fixed, viewport-clamped coordinates so
// it's ALWAYS fully visible (GitHub/Slack style) regardless of where the bell sits
// or how narrow the screen is — never clipped by the sidebar or the viewport edge.
// ── Shared feed: ONE fetch, ONE realtime channel, however many bells ─────────
// The Sidebar mounts a bell TWICE — the mobile top bar and the desktop rail —
// and hides one with CSS. Both used to run this effect, and both used to open
// `notif:<uid>`: supabase-js reuses the topic, and RealtimeChannel THROWS when
// you add a postgres_changes binding to a channel that has already subscribed.
// So the second bell's chain threw inside an unawaited async IIFE — an uncaught
// rejection on every dashboard load, and that bell held NO subscription for the
// whole session. Effects run in document order, so the mobile bell won and the
// desktop rail's bell — the VISIBLE one on a laptop — was typically the dead
// one: its badge only updated on a full page reload.
//
// A module-level store fixes the defect and the duplication together (same
// shape as useBusinessData/useModules). Deliberately NOT folded into useUnread:
// that hook documents its two-channel choice, and the notifications PAGE runs a
// different query (limit 100, keeps snoozed rows) — merging them would change
// what each surface shows.
let feedStore: AppNotification[] = []
const feedListeners = new Set<() => void>()
let feedChannel: ReturnType<ReturnType<typeof createClient>['channel']> | null = null
let feedRefs = 0
let feedLoaded = false
let feedTimer: ReturnType<typeof setTimeout> | null = null

function emitFeed() { for (const l of Array.from(feedListeners)) l() }
function subscribeFeed(cb: () => void) { feedListeners.add(cb); return () => { feedListeners.delete(cb) } }
function getFeed() { return feedStore }
function getServerFeed(): AppNotification[] { return EMPTY_FEED }
const EMPTY_FEED: AppNotification[] = []

/** Optimistic local patch (mark-read + its revert) — every bell re-renders. */
function patchFeed(fn: (prev: AppNotification[]) => AppNotification[]): void {
  feedStore = fn(feedStore)
  emitFeed()
}

export function NotificationBell() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const items = useSyncExternalStore(subscribeFeed, getFeed, getServerFeed)
  const setItems = patchFeed
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PanelPos | null>(null)
  const [mounted, setMounted] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  async function load(userId: string) {
    // Active feed only — hide archived/snoozed so the bell matches the page. Falls
    // back to the legacy columns if the manage migration hasn't run yet. Both
    // selects carry entity_type/entity_id for the one-click Schedule-now action.
    const managed = await supabase.from('notifications')
      .select('id, created_at, type, title, body, href, read, customer_id, entity_type, entity_id, snoozed_until, archived_at')
      .eq('user_id', userId).is('archived_at', null).order('created_at', { ascending: false }).limit(30)
    let data = managed.data as AppNotification[] | null
    if (managed.error && /archived_at|snoozed_until|column/i.test(managed.error.message)) {
      const legacy = await supabase.from('notifications')
        .select('id, created_at, type, title, body, href, read, customer_id, entity_type, entity_id')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(30)
      data = legacy.data as AppNotification[] | null
    }
    const now = Date.now()
    const rows = (data || []).filter(n => !n.snoozed_until || new Date(n.snoozed_until).getTime() <= now).slice(0, 20)
    feedStore = rows
    emitFeed()
  }

  // Ref-counted: the FIRST bell to mount loads the feed and opens the single
  // channel; the last to unmount closes it. A second bell just joins the store.
  useEffect(() => {
    let active = true
    feedRefs++
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid || !active) return
      if (!feedLoaded) { feedLoaded = true; await load(uid) }
      if (!feedChannel) {
        feedChannel = supabase.channel(`notif:${uid}`)
          // Trailing debounce, matching useRealtimeRefresh's 250ms. Postgres
          // emits ONE row event per id, so a bulk "Mark all read" over 99
          // notifications used to fire 99 identical refetches from this
          // always-mounted bell — on top of the page's own. All N responses
          // are the same (logical decoding only emits post-commit), so
          // collapsing them cannot change what is displayed.
          .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, () => {
            if (feedTimer) clearTimeout(feedTimer)
            feedTimer = setTimeout(() => { feedTimer = null; load(uid) }, 250)
          })
          .subscribe()
      }
    })()
    return () => {
      active = false
      feedRefs--
      if (feedRefs <= 0 && feedChannel) {
        if (feedTimer) { clearTimeout(feedTimer); feedTimer = null }
        supabase.removeChannel(feedChannel)
        feedChannel = null
        feedLoaded = false
      }
    }
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
    const { error } = await supabase.from('notifications').update({ read: true, read_at: new Date().toISOString() }).in('id', ids)
    if (error) setItems(prev => prev.map(n => ids.includes(n.id) ? { ...n, read: false } : n))   // revert unread state + badge
  }
  function openItem(n: AppNotification) {
    markRead([n.id]); setOpen(false)
    // A message notification opens THE conversation, not the bare inbox — built
    // from customer_id so it also fixes rows written before hrefs carried ?c=.
    if ((n.type === 'new_message' || n.type === 'portal_request') && n.customer_id) {
      router.push(`/dashboard/messages?c=${n.customer_id}`)
    } else if (n.href) router.push(n.href)
  }

  // One-click "Schedule now" on a quote-accepted alert — THE shared quote→job
  // engine (lib/scheduleQuote), exactly the same job the quote page and the
  // dashboard card create. Guards on the LIVE quote status, so a stale alert
  // can never double-book.
  const [schedulingId, setSchedulingId] = useState<string | null>(null)
  async function scheduleFromNotification(n: AppNotification) {
    if (schedulingId || !n.entity_id) return
    setSchedulingId(n.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: q } = await supabase.from('quotes').select('*').eq('id', n.entity_id).eq('user_id', user!.id).maybeSingle()
      const quote = q as Quote | null
      if (!quote) { toast.error('This quote no longer exists.'); markRead([n.id]); return }
      if (quote.status !== 'accepted') {
        toast.info(quote.status === 'scheduled' ? 'Already scheduled.' : 'This quote is no longer accepted — open it to review.')
        markRead([n.id])
        return
      }
      const { error } = await scheduleQuoteAsJob(supabase, user!.id, quote)
      if (error) toast.error('Could not create job: ' + error)
      else {
        markRead([n.id])
        // Same honesty as the quote page's Schedule button: ONE visit was booked,
        // never a repeating schedule — a quote with an approved recurring plan
        // still needs its recurrence set on the job, and "Job added" hid that.
        const cad = quote.selected_cadence && quote.selected_cadence !== 'one_time'
          ? quote.selected_cadence
          : (Number(quote.weekly_price) > 0 || Number(quote.biweekly_price) > 0 || Number(quote.monthly_price) > 0) ? 'recurring' : null
        const cadLabel = cad === 'weekly' ? 'weekly plan' : cad === 'biweekly' ? 'bi-weekly plan' : cad === 'monthly' ? 'monthly plan' : cad === 'recurring' ? 'recurring plan' : null
        toast(cadLabel
          ? `First visit added to today’s schedule. The ${cadLabel} isn’t a repeating schedule yet — open the job to set its recurrence.`
          : 'Job added to today’s schedule.', {
          tone: 'success',
          action: { label: 'View job', run: () => { setOpen(false); router.push('/dashboard/schedule') } },
        })
      }
    } finally { setSchedulingId(null) }
  }

  const panel = open && pos && (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
      className="z-toast flex flex-col rounded-card border border-border bg-bg-secondary shadow-2xl overflow-hidden origin-top-right animate-pop">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between shrink-0">
        <p className="text-sm font-bold text-ink">Notifications</p>
        {unread > 0 && (
          <button onClick={() => markRead(items.filter(n => !n.read).map(n => n.id))}
            className="text-[11px] font-medium text-accent-text hover:underline flex items-center gap-1"><Check className="w-3 h-3" /> Mark all read</button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto divide-y divide-border overscroll-contain">
        {items.length === 0 ? (
          <InlineEmpty icon={Bell}>You&apos;re all caught up.</InlineEmpty>
        ) : items.map(n => {
          const Icon = ICON[n.type] || Bell
          const canScheduleNow = n.type === 'quote_accepted' && !!n.entity_id
          // A div-with-role row (not <button>) so the inline "Schedule now"
          // action can be a real button without invalid nesting.
          return (
            <div key={n.id} role="button" tabIndex={0} onClick={() => openItem(n)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(n) } }}
              className={cn('w-full cursor-pointer text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-raised/40 transition-colors', !n.read && 'bg-accent/[0.04]')}>
              <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border', !n.read ? 'border-accent/30 bg-accent/10 text-accent-text' : 'border-border text-ink-muted')}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm truncate', !n.read ? 'font-semibold text-ink' : 'text-ink-muted')}>{n.title}</p>
                {n.body && <p className="text-[11px] text-ink-muted truncate">{n.body}</p>}
                <p className="text-[10px] text-ink-faint mt-0.5">{timeAgo(n.created_at)}</p>
                {canScheduleNow && (
                  <button type="button"
                    onClick={e => { e.stopPropagation(); scheduleFromNotification(n) }}
                    disabled={schedulingId !== null}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold rounded-lg px-2 py-1 border border-accent/30 bg-accent/10 text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    {schedulingId === n.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarPlus className="w-3 h-3" />} Schedule now
                  </button>
                )}
              </div>
              {!n.read && <span className="w-2 h-2 rounded-full bg-accent shrink-0 mt-1.5" />}
            </div>
          )
        })}
      </div>
      <Link href="/dashboard/notifications" onClick={() => setOpen(false)}
        className="block px-4 py-2.5 text-center text-xs font-medium text-accent-text hover:underline border-t border-border shrink-0">
        See all notifications
      </Link>
    </div>
  )

  return (
    <div className="relative shrink-0">
      <button ref={btnRef} onClick={toggle} aria-label="Notifications" aria-haspopup="dialog" aria-expanded={open}
        className="relative h-9 w-9 rounded-lg border border-border text-ink-muted hover:text-ink hover:bg-surface-raised flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </div>
  )
}
