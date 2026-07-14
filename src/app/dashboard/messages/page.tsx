'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { confirm as confirmDialog } from '@/lib/confirm'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConversationThread } from '@/components/messages/ConversationThread'
import { ConversationInfo } from '@/components/messages/ConversationInfo'
import { LeadCard } from '@/components/messages/LeadCard'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import type { Customer } from '@/types'
import { Button } from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  Loader2, Inbox, User, ArrowLeft, MessageSquare, FileText, X, Plus,
  Archive, ArchiveRestore, Pin, PinOff, BellOff, Bell, MailOpen, Trash2, MoreVertical, Reply,
  MapPin, Wrench, Receipt, Globe, Sparkles,
} from 'lucide-react'

// Apple-Messages-style inbox that stays a CRM. Archive is a FLAG — nothing is
// deleted, and archived conversations still appear on the customer profile/timeline
// and in search. The list is server-paginated per filter and virtualized, so it
// stays instant at thousands of conversations. One conversation system.
interface Convo {
  id: string; customer_id: string; last_message_at: string; last_preview: string | null
  last_direction: string | null; unread: number
  archived_at: string | null; pinned_at: string | null; muted: boolean
  lead_status: string | null; last_channel: string | null
  customers?: { id: string; name: string; phone: string | null } | null
  customer_name?: string; customer_phone?: string | null   // search-result shape
  message_snippet?: string | null; match_type?: string     // search-result extras
}

// Type axis (one hub): All / SMS / Portal / Website Leads / Archived. Per-row
// affordances (unread badge, Needs-reply pill, pin/mute) and the action menu carry
// the status dimension.
type Filter = 'all' | 'sms' | 'portal' | 'website_lead' | 'archived'
const FILTERS: { key: Filter; label: string; icon: typeof Inbox }[] = [
  { key: 'all', label: 'All', icon: Inbox },
  { key: 'sms', label: 'SMS', icon: MessageSquare },
  { key: 'portal', label: 'Portal', icon: Globe },
  { key: 'website_lead', label: 'Website Leads', icon: Sparkles },
  { key: 'archived', label: 'Archived', icon: Archive },
]
const SELECT_COLS = 'id, customer_id, last_message_at, last_preview, last_direction, unread, archived_at, pinned_at, muted, lead_status, last_channel, customers(id, name, phone)'
const PAGE = 40
const ROW_H = 76

const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }
const nameOf = (c: Convo) => c.customers?.name || c.customer_name || 'Unknown'
const phoneOf = (c: Convo) => c.customers?.phone ?? c.customer_phone ?? null

// Does a conversation still belong in this filter after a change? (optimistic removal)
function inFilter(c: Convo, f: Filter): boolean {
  if (f === 'archived') return !!c.archived_at
  if (c.archived_at) return false
  if (f === 'all') return true
  if (f === 'website_lead') return c.lead_status === 'new'
  if (c.lead_status === 'new') return false   // open leads live only under their own chip
  if (f === 'sms') return c.last_channel === 'sms' || c.last_channel == null
  if (f === 'portal') return c.last_channel === 'portal'
  return false
}

// Keep the client list in the SAME order the server returns (pinned first by pin
// time, then most-recent activity) so optimistic pin/unpin/bump never desyncs the
// row order from what a refetch would produce.
function sortConvos(arr: Convo[]): Convo[] {
  return [...arr].sort((a, b) => {
    const ap = a.pinned_at ? 1 : 0, bp = b.pinned_at ? 1 : 0
    if (ap !== bp) return bp - ap
    if (a.pinned_at && b.pinned_at && a.pinned_at !== b.pinned_at) return a.pinned_at < b.pinned_at ? 1 : -1
    return (a.last_message_at || '') < (b.last_message_at || '') ? 1 : -1
  })
}
// Append a page without ever introducing a duplicate id (guards a double-fired
// infinite-scroll or an append that overlaps a realtime refetch).
function mergeUnique(prev: Convo[], next: Convo[]): Convo[] {
  const seen = new Set(prev.map(c => c.id))
  return [...prev, ...next.filter(c => !seen.has(c.id))]
}

export default function MessagesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [rows, setRows] = useState<Convo[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<Record<Filter, number>>({ all: 0, sms: 0, portal: 0, website_lead: 0, archived: 0 })
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<Convo | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Convo[] | null>(null)
  const [searching, setSearching] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(640)
  // Concurrency / ordering guards: loadingRef blocks overlapping page appends;
  // loadSeq invalidates a page load that a newer one (filter switch / refetch) has
  // superseded; searchSeq drops out-of-order search responses. filterRef/uidRef let
  // the realtime subscription read the latest values without re-subscribing.
  const loadingRef = useRef(false)
  const loadSeq = useRef(0)
  const searchSeq = useRef(0)
  const filterRef = useRef(filter); filterRef.current = filter
  const uidRef = useRef<string | null>(null)

  async function loadCounts(u: string) {
    async function countFor(f: Filter): Promise<number> {
      let qb = supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('user_id', u)
      if (f === 'all') qb = qb.is('archived_at', null)
      else if (f === 'sms') qb = qb.is('archived_at', null).is('lead_status', null).or('last_channel.eq.sms,last_channel.is.null')
      else if (f === 'portal') qb = qb.is('archived_at', null).is('lead_status', null).eq('last_channel', 'portal')
      else if (f === 'website_lead') qb = qb.is('archived_at', null).eq('lead_status', 'new')
      else qb = qb.not('archived_at', 'is', null)
      const { count } = await qb
      return count || 0
    }
    const [a, b, c, d, e] = await Promise.all([countFor('all'), countFor('sms'), countFor('portal'), countFor('website_lead'), countFor('archived')])
    setCounts({ all: a, sms: b, portal: c, website_lead: d, archived: e })
  }

  async function loadPage(u: string, f: Filter, reset: boolean) {
    // Never run two appends at once (a double-fired infinite-scroll); a reset always
    // proceeds and supersedes anything in flight via loadSeq.
    if (!reset && loadingRef.current) return
    loadingRef.current = true
    const mySeq = ++loadSeq.current
    if (reset) setLoading(true); else setLoadingMore(true)
    const from = reset ? 0 : rows.length
    let qb = supabase.from('conversations').select(SELECT_COLS).eq('user_id', u)
    if (f === 'all') qb = qb.is('archived_at', null)
    else if (f === 'sms') qb = qb.is('archived_at', null).is('lead_status', null).or('last_channel.eq.sms,last_channel.is.null')
    else if (f === 'portal') qb = qb.is('archived_at', null).is('lead_status', null).eq('last_channel', 'portal')
    else if (f === 'website_lead') qb = qb.is('archived_at', null).eq('lead_status', 'new')
    else qb = qb.not('archived_at', 'is', null)
    const { data } = await qb
      .order('pinned_at', { ascending: false, nullsFirst: false }).order('last_message_at', { ascending: false })
      .range(from, from + PAGE - 1)
    loadingRef.current = false
    if (mySeq !== loadSeq.current) return // a newer load (filter switch / refetch) won — discard this one, it owns the flags
    const got = (data as unknown as Convo[]) || []
    setRows(prev => reset ? got : mergeUnique(prev, got))
    setHasMore(got.length === PAGE)
    setLoading(false); setLoadingMore(false)
  }

  // Initial + filter changes.
  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const u = session?.user?.id
      if (!u || !active) { setLoading(false); return }
      setUid(u); uidRef.current = u
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      setScrollTop(0)
      await Promise.all([loadPage(u, filter, true), loadCounts(u)])
    })()
    return () => { active = false }
  }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: subscribe ONCE (reads the live filter via filterRef so a filter switch
  // never tears down the channel). Always refresh counts. Patch the changed row in
  // place from the payload so deep-scrolled rows stay fresh (unread/preview/order)
  // without a refetch; only refetch the top page when near the top, which also picks
  // up brand-new conversations.
  useEffect(() => {
    let active = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const u = session?.user?.id
      if (!u || !active) return
      uidRef.current = u
      channel = supabase.channel(`conv-list:${u}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${u}` }, (payload) => {
          const f = filterRef.current
          loadCounts(u)
          if (payload.eventType === 'UPDATE') {
            const r = payload.new as Pick<Convo, 'id' | 'unread' | 'last_preview' | 'last_direction' | 'last_message_at' | 'archived_at' | 'pinned_at' | 'muted' | 'lead_status' | 'last_channel'>
            const fields = { unread: r.unread, last_preview: r.last_preview, last_direction: r.last_direction, last_message_at: r.last_message_at, archived_at: r.archived_at, pinned_at: r.pinned_at, muted: r.muted, lead_status: r.lead_status, last_channel: r.last_channel }
            setRows(cs => cs.some(x => x.id === r.id)
              ? sortConvos(cs.map(x => x.id === r.id ? { ...x, ...fields } : x).filter(x => x.id !== r.id || inFilter({ ...x, ...fields }, f)))
              : cs)
            setSel(s => s && s.id === r.id ? { ...s, ...fields } : s)
          } else if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string })?.id
            if (oldId) { setRows(cs => cs.filter(x => x.id !== oldId)); setSel(s => s && s.id === oldId ? null : s) }
          }
          if ((scrollRef.current?.scrollTop ?? 0) < 200) loadPage(u, filterRef.current, true)
        })
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced Spotlight search. A seq guard drops out-of-order responses so a slow
  // earlier query can never overwrite the results of a newer one.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setSearchResults(null); setSearching(false); searchSeq.current++; return }
    setSearching(true)
    const seq = ++searchSeq.current
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('search_conversations', { p_query: q })
      if (seq !== searchSeq.current) return
      setSearchResults((data as Convo[]) || [])
      setSearching(false)
    }, 250)
    return () => clearTimeout(t)
  }, [query, supabase])

  // If optimistic removals (archiving/deleting a whole page) emptied the list but the
  // server still has more, pull the next page so it never looks empty by mistake.
  useEffect(() => {
    if (!loading && !loadingMore && !searchResults && hasMore && rows.length === 0 && uid) loadPage(uid, filter, true)
  }, [rows.length, hasMore, loading, loadingMore, searchResults, uid, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = searchResults ?? rows

  function patch(id: string, p: Partial<Convo>) {
    setRows(cs => cs.map(c => c.id === id ? { ...c, ...p } : c))
    setSearchResults(rs => rs ? rs.map(c => c.id === id ? { ...c, ...p } : c) : rs)
    setSel(s => s && s.id === id ? { ...s, ...p } : s)
  }
  // Optimistic update. Always keep `rows` (the filter's list) correct — drop the row
  // if it left the filter, else patch + re-sort — even while a search overlays the
  // list, so clearing search reveals an accurate inbox. Patch the search overlay and
  // the open thread separately.
  function mutate(c: Convo, p: Partial<Convo>) {
    const next = { ...c, ...p }
    setRows(cs => cs.some(x => x.id === c.id)
      ? sortConvos(inFilter(next, filter) ? cs.map(x => x.id === c.id ? next : x) : cs.filter(x => x.id !== c.id))
      : cs)
    setSearchResults(rs => rs ? rs.map(x => x.id === c.id ? next : x) : rs)
    setSel(s => s && s.id === c.id ? next : s)
    if (uid) loadCounts(uid)
  }
  function removeLocal(id: string) {
    setRows(cs => cs.filter(c => c.id !== id))
    setSearchResults(rs => rs ? rs.filter(c => c.id !== id) : rs)
    setSel(s => s && s.id === id ? null : s)
    if (uid) loadCounts(uid)
  }

  const actions = {
    // Archive acts instantly but is fully reversible — the shared Undo toast restores
    // it in one tap (recovering from the Archived filter costs 4+ clicks otherwise).
    archive: async (c: Convo) => {
      const now = new Date().toISOString(); mutate(c, { archived_at: now })
      await supabase.from('conversations').update({ archived_at: now }).eq('id', c.id)
      toast.undo(`Archived conversation with ${nameOf(c)}`, async () => {
        await supabase.from('conversations').update({ archived_at: null }).eq('id', c.id)
        if (uid) loadPage(uid, filterRef.current, true)
      })
    },
    unarchive: async (c: Convo) => { mutate(c, { archived_at: null }); await supabase.from('conversations').update({ archived_at: null }).eq('id', c.id) },
    pin: async (c: Convo) => { const now = new Date().toISOString(); mutate(c, { pinned_at: now }); await supabase.from('conversations').update({ pinned_at: now }).eq('id', c.id) },
    unpin: async (c: Convo) => { mutate(c, { pinned_at: null }); await supabase.from('conversations').update({ pinned_at: null }).eq('id', c.id) },
    markUnread: async (c: Convo) => { const u = Math.max(c.unread, 1); patch(c.id, { unread: u }); if (uid) loadCounts(uid); await supabase.from('conversations').update({ unread: u }).eq('id', c.id) },
    toggleMute: async (c: Convo) => { patch(c.id, { muted: !c.muted }); await supabase.from('conversations').update({ muted: !c.muted }).eq('id', c.id) },
    del: async (c: Convo) => {
      const ok = await confirmDialog({
        title: `Delete conversation with ${nameOf(c)}?`,
        message: 'This erases the entire message history and cannot be undone. Archiving keeps everything instead.',
        confirmLabel: 'Delete permanently', destructive: true,
      })
      if (!ok) return
      removeLocal(c.id)
      await supabase.from('conversations').delete().eq('id', c.id)
    },
    select: (c: Convo) => { setSel(c); if (c.unread > 0) { patch(c.id, { unread: 0 }); if (uid) loadCounts(uid) } },
  }

  // ── New message (compose without leaving the inbox) ──
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeCustomers, setComposeCustomers] = useState<Customer[]>([])
  const [composeTo, setComposeTo] = useState<{ id: string; name: string } | null>(null)
  async function openCompose() {
    setComposeOpen(true)
    if (composeCustomers.length === 0) {
      const { data } = await supabase.from('customers').select('*').is('archived_at', null).order('name')
      setComposeCustomers((data as Customer[]) || [])
    }
  }

  // ── Bulk actions ──
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelect = (id: string) => setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()) }
  async function bulk(op: 'archive' | 'unarchive' | 'read' | 'unread' | 'mute' | 'unmute' | 'pin' | 'delete') {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (op === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${ids.length} conversation${ids.length !== 1 ? 's' : ''}?`,
        message: 'This erases their message history and cannot be undone.',
        confirmLabel: 'Delete permanently', destructive: true,
      })
      if (!ok) return
      setRows(cs => cs.filter(c => !selectedIds.has(c.id)))
      setSearchResults(rs => rs ? rs.filter(c => !selectedIds.has(c.id)) : rs)
      await supabase.from('conversations').delete().in('id', ids)
    } else {
      const now = new Date().toISOString()
      const p: Partial<Convo> = op === 'archive' ? { archived_at: now } : op === 'unarchive' ? { archived_at: null }
        : op === 'read' ? { unread: 0 } : op === 'unread' ? { unread: 1 } : op === 'mute' ? { muted: true } : op === 'unmute' ? { muted: false } : { pinned_at: now }
      setRows(cs => sortConvos(cs.map(c => selectedIds.has(c.id) ? { ...c, ...p } : c).filter(c => inFilter(c, filter))))
      setSearchResults(rs => rs ? rs.map(c => selectedIds.has(c.id) ? { ...c, ...p } : c) : rs)
      await supabase.from('conversations').update(p).in('id', ids)
    }
    if (uid) loadCounts(uid)
    exitSelect()
  }

  // ── Virtualization ──
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    setScrollTop(el.scrollTop); setViewport(el.clientHeight)
    if (!searchResults && hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < 400 && uid) loadPage(uid, filter, false)
  }
  const BUF = 6
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUF)
  const end = Math.min(list.length, Math.ceil((scrollTop + viewport) / ROW_H) + BUF)
  const visible = list.slice(start, end)

  // Measure the real list height so virtualization fills a tall screen on first paint
  // (before any scroll sets the viewport) and re-measures on resize / layout change.
  useEffect(() => {
    function measure() { const el = scrollRef.current; if (el && el.clientHeight) setViewport(el.clientHeight) }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [loading, sel])

  // Keyboard: "/" focuses search, Esc clears search / closes the thread / exits
  // select mode, and ↑/↓ move through the list (opening as you go) — Spotlight feel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus() }
      else if (e.key === 'Escape') {
        if (query) { setQuery(''); searchRef.current?.blur() }
        else if (selectMode) exitSelect()
        else if (sel) setSel(null)
      } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
        e.preventDefault()
        const cur = sel ? list.findIndex(c => c.id === sel.id) : -1
        const idx = e.key === 'ArrowDown' ? Math.min(list.length - 1, cur + 1) : Math.max(0, cur <= 0 ? 0 : cur - 1)
        if (list[idx]) actions.select(list[idx])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, selectMode, sel, list]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Messages" description="Two-way SMS + portal conversations — archived chats stay in CRM history forever."
        action={
          <Button variant="secondary" onClick={openCompose}>
            <Plus className="w-4 h-4" /> New message
          </Button>
        } />

      {/* Start a conversation without leaving the inbox: pick a customer → THE shared
          Send-Message dialog (same engine; the sent message threads into this list). */}
      {composeOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 pt-24" onClick={() => setComposeOpen(false)}>
          <div className="bg-bg-secondary border border-border-strong rounded-card max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-ink">Who do you want to message?</p>
            <CustomerPicker customers={composeCustomers} value={''} allowManual={false}
              onChange={id => {
                const c = composeCustomers.find(x => x.id === id)
                if (c) { setComposeOpen(false); setComposeTo({ id: c.id, name: c.name }) }
              }} />
            <button onClick={() => setComposeOpen(false)} className="text-xs text-ink-faint hover:text-ink">Cancel</button>
          </div>
        </div>
      )}
      {composeTo && (
        <SendMessageDialog open onClose={() => { setComposeTo(null); if (uid) loadPage(uid, filterRef.current, true) }}
          customerId={composeTo.id} customerName={composeTo.name} />
      )}

      {/* Spotlight search */}
      <div className="relative">
        <SearchInput ref={searchRef} fieldSize="sm" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search conversations"
          placeholder="Search name, phone, address, property, service, message, quote #, invoice #…"
          className="[&>input]:pr-9" />
        {query
          ? <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
          : <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-faint border border-border rounded px-1 leading-4 pointer-events-none hidden sm:block">/</kbd>}
      </div>

      {!searchResults && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => { setFilter(f.key); setSel(null) }}
                className={cn('flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 border transition-colors',
                  filter === f.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                <f.icon className="w-3.5 h-3.5" /> {f.label}
                {counts[f.key] > 0 && <span className={cn('text-[10px] font-bold', filter === f.key ? 'text-black/70' : 'text-ink-faint')}>{counts[f.key]}</span>}
              </button>
            ))}
          </div>
          <button onClick={() => selectMode ? exitSelect() : setSelectMode(true)} className="text-xs font-medium text-ink-muted hover:text-ink shrink-0">
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        </div>
      )}

      {selectMode && (
        <div className="flex items-center gap-1.5 flex-wrap rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2 animate-[popIn_0.12s_ease-out]">
          <span className="text-xs font-semibold text-ink mr-1">{selectedIds.size} selected</span>
          {/* Context-gated: only actions that can DO something here are offered —
              Archive outside Archived, Unarchive inside it, Mute/Unmute per what's
              actually selected, permanent Delete only inside Archived. */}
          {filter !== 'archived' && <BulkBtn icon={Archive} label="Archive" onClick={() => bulk('archive')} />}
          {filter === 'archived' && <BulkBtn icon={ArchiveRestore} label="Unarchive" onClick={() => bulk('unarchive')} />}
          <BulkBtn icon={MailOpen} label="Read" onClick={() => bulk('read')} />
          <BulkBtn icon={MessageSquare} label="Unread" onClick={() => bulk('unread')} />
          <BulkBtn icon={Pin} label="Pin" onClick={() => bulk('pin')} />
          {(searchResults ?? rows).some(c => selectedIds.has(c.id) && !c.muted) && <BulkBtn icon={BellOff} label="Mute" onClick={() => bulk('mute')} />}
          {(searchResults ?? rows).some(c => selectedIds.has(c.id) && c.muted) && <BulkBtn icon={Bell} label="Unmute" onClick={() => bulk('unmute')} />}
          {filter === 'archived' && <BulkBtn icon={Trash2} label="Delete" onClick={() => bulk('delete')} danger />}
        </div>
      )}

      <div className="grid lg:grid-cols-[340px_1fr] gap-4" style={{ minHeight: '62vh' }}>
        {/* List */}
        <div className={cn('rounded-card border border-border bg-bg-secondary overflow-hidden flex flex-col', sel && 'hidden lg:flex')}>
          {searchResults && (
            <p className="px-4 py-2 text-[11px] text-ink-faint border-b border-border flex items-center gap-1.5 shrink-0">
              {searching ? <><Loader2 className="w-3 h-3 animate-spin" /> Searching…</> : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} (incl. archived)`}
            </p>
          )}
          {loading ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="px-4 flex items-center gap-3" style={{ height: ROW_H }}>
                  <Skeleton className="w-9 h-9 rounded-full shrink-0" />
                  <div className="flex-1 min-w-0">
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-2.5 w-3/4 mt-2" />
                    <Skeleton className="h-2 w-16 mt-2" />
                  </div>
                </div>
              ))}
            </div>
          ) : list.length === 0 ? (
            <EmptyState icon={Inbox} className="py-16"
              title={searchResults ? 'No matches'
                : filter === 'archived' ? 'No archived chats'
                : filter === 'website_lead' ? 'No new website leads'
                : filter === 'portal' ? 'No portal messages yet'
                : filter === 'sms' ? 'No text conversations yet'
                : 'No conversations yet'}
              description={searchResults ? 'Try a name, address, service, or quote/invoice #.'
                : filter === 'website_lead' ? 'Leads land here the moment your website form is submitted.'
                : filter === 'portal' ? 'Requests customers send from their portal show up here.'
                : 'Inbound texts, portal requests and website leads all land here — replies go out from your business number.'} />
          ) : (
            <div ref={scrollRef} onScroll={onScroll} className="overflow-y-auto" style={{ maxHeight: '72vh' }}>
              <div style={{ height: list.length * ROW_H, position: 'relative' }}>
                <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
                  {visible.map(c => (
                    <ConversationRow key={c.id} c={c} selected={sel?.id === c.id} actions={actions} query={searchResults ? query.trim() : ''}
                      selectMode={selectMode} checked={selectedIds.has(c.id)} onToggleSelect={() => toggleSelect(c.id)} />
                  ))}
                </div>
              </div>
              {loadingMore && <div className="py-3 flex justify-center"><Loader2 className="w-3.5 h-3.5 animate-spin text-ink-faint" /></div>}
            </div>
          )}
        </div>

        {/* Thread */}
        <div className={cn('rounded-card border border-border bg-bg-secondary p-4 flex-col', sel ? 'flex' : 'hidden lg:flex')}>
          {sel ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border pb-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button className="lg:hidden text-ink-muted hover:text-ink" onClick={() => setSel(null)} aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink truncate flex items-center gap-1.5">
                      {sel.pinned_at && <Pin className="w-3 h-3 text-accent shrink-0" />}{nameOf(sel)}
                      {sel.lead_status === 'new' && <span className="text-[10px] font-bold uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 flex items-center gap-0.5"><Globe className="w-3 h-3" /> Website Lead</span>}
                      {sel.archived_at && <span className="text-[10px] font-semibold uppercase text-ink-faint border border-border rounded px-1 py-0.5">Archived</span>}
                      {sel.muted && <BellOff className="w-3 h-3 text-ink-faint shrink-0" />}
                    </p>
                    {phoneOf(sel) && <p className="text-[11px] text-ink-faint">{phoneOf(sel)}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {sel.archived_at
                    ? <Button size="sm" variant="secondary" onClick={() => actions.unarchive(sel)} title="Unarchive"><ArchiveRestore className="w-3.5 h-3.5" /><span className="hidden sm:inline">Unarchive</span></Button>
                    : <Button size="sm" variant="ghost" onClick={() => actions.archive(sel)} title="Archive"><Archive className="w-3.5 h-3.5" /><span className="hidden sm:inline">Archive</span></Button>}
                  <Link href={`/dashboard/quotes/new?customer=${sel.customer_id}`}><Button size="sm" variant="secondary" title="New quote"><FileText className="w-3.5 h-3.5" /><span className="hidden sm:inline">Quote</span></Button></Link>
                  <Link href={`/dashboard/customers/${sel.customer_id}`}><Button size="sm" variant="ghost" title="Customer profile"><User className="w-3.5 h-3.5" /><span className="hidden sm:inline">Profile</span></Button></Link>
                </div>
              </div>
              {/* Website-lead context + Build Quote, shown only while the lead is open. */}
              {sel.lead_status === 'new' && <LeadCard customerId={sel.customer_id} />}
              <ConversationInfo customerId={sel.customer_id} />
              <div className="flex-1 min-h-0">
                <ConversationThread customerId={sel.customer_id} onRead={() => uid && loadCounts(uid)} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center py-16">
              <InlineEmpty icon={MessageSquare}>Select a conversation</InlineEmpty>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BulkBtn({ icon: Icon, label, onClick, danger }: { icon: typeof Archive; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} title={label}
      className={cn('h-7 px-2 rounded-lg border text-[11px] font-medium flex items-center gap-1 hover:bg-black/10 active:scale-95 transition-transform',
        danger ? 'border-red-500/30 text-red-400' : 'border-border text-ink-muted hover:text-ink')}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}

// Highlight every occurrence of `q` in `text` (case-insensitive) — Spotlight-style.
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q || !text) return <>{text}</>
  const out: React.ReactNode[] = []
  const lower = text.toLowerCase(), ql = q.toLowerCase()
  let i = 0, k = 0
  while (i < text.length) {
    const idx = lower.indexOf(ql, i)
    if (idx < 0) { out.push(text.slice(i)); break }
    if (idx > i) out.push(text.slice(i, idx))
    out.push(<mark key={k++} className="bg-accent/30 text-ink rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  return <>{out}</>
}

const MATCH_META: Record<string, { icon: typeof MapPin; label: string }> = {
  property: { icon: MapPin, label: 'Property' }, service: { icon: Wrench, label: 'Service' },
  quote: { icon: FileText, label: 'Quote' }, invoice: { icon: Receipt, label: 'Invoice' },
  message: { icon: MessageSquare, label: 'Message' }, address: { icon: MapPin, label: 'Address' },
  phone: { icon: User, label: 'Phone' }, name: { icon: User, label: 'Name' },
}

interface RowActions {
  archive: (c: Convo) => void; unarchive: (c: Convo) => void
  pin: (c: Convo) => void; unpin: (c: Convo) => void
  markUnread: (c: Convo) => void; toggleMute: (c: Convo) => void
  del: (c: Convo) => void; select: (c: Convo) => void
}

function ConversationRow({ c, selected, actions, query, selectMode, checked, onToggleSelect }: { c: Convo; selected: boolean; actions: RowActions; query: string; selectMode: boolean; checked: boolean; onToggleSelect: () => void }) {
  const router = useRouter()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dx, setDx] = useState(0)

  useEffect(() => {
    if (!menu) return
    const h = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menu])

  function onTouchStart(e: React.TouchEvent) { startX.current = e.touches[0].clientX; longTimer.current = setTimeout(() => setMenu(true), 500) }
  function onTouchMove(e: React.TouchEvent) {
    const d = e.touches[0].clientX - startX.current
    if (Math.abs(d) > 8 && longTimer.current) { clearTimeout(longTimer.current); longTimer.current = null }
    setDx(Math.max(-96, Math.min(96, d)))
  }
  function onTouchEnd() {
    if (longTimer.current) { clearTimeout(longTimer.current); longTimer.current = null }
    if (dx <= -64) { c.archived_at ? actions.unarchive(c) : actions.archive(c) }
    else if (dx >= 64) actions.markUnread(c)
    setDx(0)
  }

  const isSearch = !!query
  const match = c.match_type ? MATCH_META[c.match_type] : null
  const preview = isSearch && c.match_type === 'message' && c.message_snippet ? c.message_snippet : (c.last_preview || '…')
  const needsReply = !c.archived_at && c.last_direction === 'inbound'
  const Item = ({ icon: Icon, label, onClick, danger }: { icon: typeof Pin; label: string; onClick: () => void; danger?: boolean }) => (
    <button onClick={() => { setMenu(false); onClick() }}
      className={cn('w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-surface transition-colors', danger ? 'text-red-400' : 'text-ink')}>
      <Icon className="w-3.5 h-3.5 shrink-0" /> {label}
    </button>
  )

  return (
    <div className="relative overflow-hidden border-b border-border" style={{ height: ROW_H }}>
      <div className="absolute inset-y-0 left-0 w-24 bg-emerald-500/20 flex items-center pl-4 text-emerald-400" style={{ opacity: dx < 0 ? 1 : 0 }}><Archive className="w-4 h-4" /></div>
      <div className="absolute inset-y-0 right-0 w-24 bg-sky-500/20 flex items-center justify-end pr-4 text-sky-400" style={{ opacity: dx > 0 ? 1 : 0 }}><MailOpen className="w-4 h-4" /></div>

      <div
        role="button" tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${nameOf(c)}${c.unread > 0 ? `, ${c.unread} unread` : ''}${c.archived_at ? ', archived' : ''}`}
        onClick={() => selectMode ? onToggleSelect() : actions.select(c)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMode ? onToggleSelect() : actions.select(c) } }}
        onContextMenu={selectMode ? undefined : (e) => { e.preventDefault(); setMenu(true) }}
        onTouchStart={selectMode ? undefined : onTouchStart} onTouchMove={selectMode ? undefined : onTouchMove} onTouchEnd={selectMode ? undefined : onTouchEnd}
        style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 0.15s' : 'none', height: ROW_H }}
        className={cn('relative bg-bg-secondary w-full text-left px-4 flex items-center gap-3 cursor-pointer hover:bg-surface/40 transition-colors outline-none focus-visible:bg-surface/60 focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset', selected && 'bg-accent/5', checked && 'bg-accent/10')}
      >
        {selectMode && <input type="checkbox" readOnly checked={checked} className="accent-accent w-4 h-4 shrink-0 pointer-events-none" />}
        <div className="w-9 h-9 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 text-xs font-bold text-accent">
          {nameOf(c).slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {c.pinned_at && <Pin className="w-3 h-3 text-accent shrink-0" />}
            <p className={cn('text-sm truncate flex-1', c.unread > 0 ? 'font-bold text-ink' : 'font-semibold text-ink')}><Highlight text={nameOf(c)} q={query} /></p>
            {c.lead_status === 'new' && <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1 leading-4">Lead</span>}
            {c.muted && <BellOff className="w-3 h-3 text-ink-faint shrink-0" />}
            {c.archived_at && <Archive className="w-3 h-3 text-ink-faint shrink-0" />}
            {c.unread > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">{c.unread > 9 ? '9+' : c.unread}</span>}
          </div>
          <p className={cn('text-xs truncate mt-0.5', c.unread > 0 ? 'text-ink font-medium' : 'text-ink-muted')}>
            {!isSearch && (c.last_direction === 'internal' ? 'Note: ' : c.last_direction && c.last_direction !== 'inbound' ? 'You: ' : '')}<Highlight text={preview} q={query} />
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[10px] text-ink-faint">{timeAgo(c.last_message_at)}</p>
            {isSearch && match
              ? <span className="text-[10px] font-semibold text-accent flex items-center gap-0.5"><match.icon className="w-3 h-3" /> {match.label}</span>
              : needsReply && <span className="text-[10px] font-semibold text-amber-400 flex items-center gap-0.5"><Reply className="w-3 h-3" /> Needs reply</span>}
          </div>
        </div>

        {!selectMode && (
          <button onClick={(e) => { e.stopPropagation(); setMenu(m => !m) }} aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={menu}
            className="shrink-0 -mr-1 h-7 w-7 rounded-lg text-ink-faint hover:text-ink hover:bg-black/10 flex items-center justify-center active:scale-90 transition-transform">
            <MoreVertical className="w-4 h-4" />
          </button>
        )}
      </div>

      {menu && !selectMode && (
        <div ref={menuRef} role="menu" onClick={e => e.stopPropagation()} className="absolute right-2 top-9 z-20 w-48 rounded-xl border border-border bg-bg-secondary shadow-xl overflow-hidden py-1 origin-top-right animate-[popIn_0.12s_ease-out]">
          {c.archived_at
            ? <Item icon={ArchiveRestore} label="Unarchive" onClick={() => actions.unarchive(c)} />
            : <Item icon={Archive} label="Archive" onClick={() => actions.archive(c)} />}
          {c.pinned_at
            ? <Item icon={PinOff} label="Unpin" onClick={() => actions.unpin(c)} />
            : <Item icon={Pin} label="Pin to top" onClick={() => actions.pin(c)} />}
          <Item icon={MailOpen} label="Mark unread" onClick={() => actions.markUnread(c)} />
          <Item icon={c.muted ? Bell : BellOff} label={c.muted ? 'Unmute' : 'Mute notifications'} onClick={() => actions.toggleMute(c)} />
          <Item icon={User} label="View customer" onClick={() => router.push(`/dashboard/customers/${c.customer_id}`)} />
          {/* Permanent delete only for ARCHIVED conversations — archive is the safe default. */}
          {c.archived_at && (
            <>
              <div className="border-t border-border my-1" />
              <Item icon={Trash2} label="Delete permanently" onClick={() => actions.del(c)} danger />
            </>
          )}
        </div>
      )}
    </div>
  )
}
