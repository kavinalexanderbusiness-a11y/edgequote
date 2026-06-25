'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { ConversationThread } from '@/components/messages/ConversationThread'
import { ConversationInfo } from '@/components/messages/ConversationInfo'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import {
  Loader2, Inbox, User, ArrowLeft, MessageSquare, FileText, Search, X,
  Archive, ArchiveRestore, Pin, PinOff, BellOff, Bell, MailOpen, Trash2, MoreVertical, Reply,
} from 'lucide-react'

// Apple-Messages-style inbox that stays a CRM. Archive is a FLAG (archived_at) —
// nothing is deleted, and archived conversations still appear on the customer
// profile/timeline and in search. A new inbound/outbound message auto-returns an
// archived conversation to the inbox (handled DB-side by bump_conversation). One
// conversation system — this just adds organisation on top.
interface Convo {
  id: string; customer_id: string; last_message_at: string; last_preview: string | null
  last_direction: string | null; unread: number
  archived_at: string | null; pinned_at: string | null; muted: boolean
  customers?: { id: string; name: string; phone: string | null } | null
  customer_name?: string; customer_phone?: string | null   // search-result shape
}

type Filter = 'inbox' | 'unread' | 'needs_reply' | 'pinned' | 'archived'
const FILTERS: { key: Filter; label: string; icon: typeof Inbox }[] = [
  { key: 'inbox', label: 'Inbox', icon: Inbox },
  { key: 'unread', label: 'Unread', icon: MessageSquare },
  { key: 'needs_reply', label: 'Needs reply', icon: Reply },
  { key: 'pinned', label: 'Pinned', icon: Pin },
  { key: 'archived', label: 'Archived', icon: Archive },
]

const timeAgo = (iso: string) => { try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' } }
const nameOf = (c: Convo) => c.customers?.name || c.customer_name || 'Unknown'
const phoneOf = (c: Convo) => c.customers?.phone ?? c.customer_phone ?? null

export default function MessagesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [convos, setConvos] = useState<Convo[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('inbox')
  const [sel, setSel] = useState<Convo | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Convo[] | null>(null)
  const [searching, setSearching] = useState(false)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setLoading(false); return }
    const { data } = await supabase.from('conversations')
      .select('id, customer_id, last_message_at, last_preview, last_direction, unread, archived_at, pinned_at, muted, customers(id, name, phone)')
      .eq('user_id', uid).order('last_message_at', { ascending: false })
    setConvos((data as unknown as Convo[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: inbound SMS or an auto-unarchive bumps the list live.
  useEffect(() => {
    let active = true
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid || !active) return
      channel = supabase.channel(`conv-list:${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${uid}` }, () => load())
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search across customer / message / quote # / invoice # (incl archived).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setSearchResults(null); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('search_conversations', { p_query: q })
      setSearchResults((data as Convo[]) || [])
      setSearching(false)
    }, 300)
    return () => clearTimeout(t)
  }, [query, supabase])

  const counts = useMemo(() => ({
    inbox: convos.filter(c => !c.archived_at).length,
    unread: convos.filter(c => !c.archived_at && c.unread > 0).length,
    needs_reply: convos.filter(c => !c.archived_at && c.last_direction === 'inbound').length,
    pinned: convos.filter(c => !!c.pinned_at).length,
    archived: convos.filter(c => !!c.archived_at).length,
  }), [convos])

  const list = useMemo(() => {
    if (searchResults) return searchResults
    let l = convos
    if (filter === 'inbox') l = l.filter(c => !c.archived_at)
    else if (filter === 'unread') l = l.filter(c => !c.archived_at && c.unread > 0)
    else if (filter === 'needs_reply') l = l.filter(c => !c.archived_at && c.last_direction === 'inbound')
    else if (filter === 'pinned') l = l.filter(c => !!c.pinned_at)
    else if (filter === 'archived') l = l.filter(c => !!c.archived_at)
    return [...l].sort((a, b) => {
      const ap = a.pinned_at ? 1 : 0, bp = b.pinned_at ? 1 : 0
      if (ap !== bp) return bp - ap
      return (b.last_message_at || '').localeCompare(a.last_message_at || '')
    })
  }, [convos, filter, searchResults])

  function patch(id: string, p: Partial<Convo>) {
    setConvos(cs => cs.map(c => c.id === id ? { ...c, ...p } : c))
    setSearchResults(rs => rs ? rs.map(c => c.id === id ? { ...c, ...p } : c) : rs)
    setSel(s => s && s.id === id ? { ...s, ...p } : s)
  }
  function removeLocal(id: string) {
    setConvos(cs => cs.filter(c => c.id !== id))
    setSearchResults(rs => rs ? rs.filter(c => c.id !== id) : rs)
    setSel(s => s && s.id === id ? null : s)
  }

  const actions = {
    archive: async (c: Convo) => { const now = new Date().toISOString(); patch(c.id, { archived_at: now }); await supabase.from('conversations').update({ archived_at: now }).eq('id', c.id) },
    unarchive: async (c: Convo) => { patch(c.id, { archived_at: null }); await supabase.from('conversations').update({ archived_at: null }).eq('id', c.id) },
    pin: async (c: Convo) => { const now = new Date().toISOString(); patch(c.id, { pinned_at: now }); await supabase.from('conversations').update({ pinned_at: now }).eq('id', c.id) },
    unpin: async (c: Convo) => { patch(c.id, { pinned_at: null }); await supabase.from('conversations').update({ pinned_at: null }).eq('id', c.id) },
    markUnread: async (c: Convo) => { const u = Math.max(c.unread, 1); patch(c.id, { unread: u }); await supabase.from('conversations').update({ unread: u }).eq('id', c.id) },
    toggleMute: async (c: Convo) => { patch(c.id, { muted: !c.muted }); await supabase.from('conversations').update({ muted: !c.muted }).eq('id', c.id) },
    del: async (c: Convo) => {
      if (!confirm(`Permanently delete this conversation with ${nameOf(c)}?\n\nThis erases the entire message history and CANNOT be undone. Archiving keeps everything instead.`)) return
      if (!confirm('Are you absolutely sure? This is permanent.')) return
      removeLocal(c.id)
      await supabase.from('conversations').delete().eq('id', c.id)
    },
    select: (c: Convo) => { setSel(c); if (c.unread > 0) patch(c.id, { unread: 0 }) },
  }

  // ── Bulk actions (multi-select) ──
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const toggleSelect = (id: string) => setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()) }
  async function bulk(op: 'archive' | 'unarchive' | 'read' | 'unread' | 'mute' | 'unmute' | 'pin' | 'delete') {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (op === 'delete') {
      if (!confirm(`Permanently delete ${ids.length} conversation${ids.length !== 1 ? 's' : ''}? This erases their message history and cannot be undone.`)) return
      if (!confirm('Are you absolutely sure? This is permanent.')) return
      setConvos(cs => cs.filter(c => !selectedIds.has(c.id)))
      setSearchResults(rs => rs ? rs.filter(c => !selectedIds.has(c.id)) : rs)
      await supabase.from('conversations').delete().in('id', ids)
    } else {
      const now = new Date().toISOString()
      const p: Partial<Convo> = op === 'archive' ? { archived_at: now } : op === 'unarchive' ? { archived_at: null }
        : op === 'read' ? { unread: 0 } : op === 'unread' ? { unread: 1 } : op === 'mute' ? { muted: true } : op === 'unmute' ? { muted: false } : { pinned_at: now }
      setConvos(cs => cs.map(c => selectedIds.has(c.id) ? { ...c, ...p } : c))
      setSearchResults(rs => rs ? rs.map(c => selectedIds.has(c.id) ? { ...c, ...p } : c) : rs)
      await supabase.from('conversations').update(p).in('id', ids)
    }
    exitSelect()
  }

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Messages" description="Two-way SMS + portal conversations — archived chats stay in CRM history forever." />

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search name, phone, address, message, quote #, invoice #…"
          className="w-full h-10 pl-9 pr-9 rounded-xl bg-bg-tertiary border border-border text-sm text-ink outline-none focus:border-accent" />
        {query && <button onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>}
      </div>

      {/* Filters (hidden while searching) */}
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

      {/* Bulk action bar */}
      {selectMode && (
        <div className="flex items-center gap-1.5 flex-wrap rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2">
          <span className="text-xs font-semibold text-ink mr-1">{selectedIds.size} selected</span>
          <BulkBtn icon={Archive} label="Archive" onClick={() => bulk('archive')} />
          <BulkBtn icon={ArchiveRestore} label="Unarchive" onClick={() => bulk('unarchive')} />
          <BulkBtn icon={MailOpen} label="Read" onClick={() => bulk('read')} />
          <BulkBtn icon={MessageSquare} label="Unread" onClick={() => bulk('unread')} />
          <BulkBtn icon={Pin} label="Pin" onClick={() => bulk('pin')} />
          <BulkBtn icon={BellOff} label="Mute" onClick={() => bulk('mute')} />
          <BulkBtn icon={Bell} label="Unmute" onClick={() => bulk('unmute')} />
          <BulkBtn icon={Trash2} label="Delete" onClick={() => bulk('delete')} danger />
        </div>
      )}

      <div className="grid lg:grid-cols-[340px_1fr] gap-4" style={{ minHeight: '62vh' }}>
        {/* List */}
        <div className={cn('rounded-card border border-border bg-bg-secondary overflow-hidden', sel && 'hidden lg:block')}>
          {searchResults && (
            <p className="px-4 py-2 text-[11px] text-ink-faint border-b border-border flex items-center gap-1.5">
              {searching ? <><Loader2 className="w-3 h-3 animate-spin" /> Searching…</> : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} (incl. archived)`}
            </p>
          )}
          {loading ? (
            <div className="py-16 flex items-center justify-center text-ink-muted"><Loader2 className="w-4 h-4 animate-spin" /></div>
          ) : list.length === 0 ? (
            <div className="py-16 text-center px-4">
              <Inbox className="w-9 h-9 text-ink-faint mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">{searchResults ? 'No matches' : filter === 'archived' ? 'No archived chats' : 'Nothing here'}</p>
              <p className="text-xs text-ink-muted mt-1">{searchResults ? 'Try a name, number, or quote/invoice #.' : 'Inbound texts and portal requests appear here.'}</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[72vh] overflow-y-auto">
              {list.map(c => (
                <ConversationRow key={c.id} c={c} selected={sel?.id === c.id} actions={actions}
                  selectMode={selectMode} checked={selectedIds.has(c.id)} onToggleSelect={() => toggleSelect(c.id)} />
              ))}
            </div>
          )}
        </div>

        {/* Thread */}
        <div className={cn('rounded-card border border-border bg-bg-secondary p-4 flex-col', sel ? 'flex' : 'hidden lg:flex')}>
          {sel ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-border pb-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <button className="lg:hidden text-ink-muted hover:text-ink" onClick={() => setSel(null)} aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink truncate flex items-center gap-1.5">
                      {sel.pinned_at && <Pin className="w-3 h-3 text-accent shrink-0" />}{nameOf(sel)}
                      {sel.archived_at && <span className="text-[10px] font-semibold uppercase text-ink-faint border border-border rounded px-1 py-0.5">Archived</span>}
                      {sel.muted && <BellOff className="w-3 h-3 text-ink-faint shrink-0" />}
                    </p>
                    {phoneOf(sel) && <p className="text-[11px] text-ink-faint">{phoneOf(sel)}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {sel.archived_at
                    ? <Button size="sm" variant="secondary" onClick={() => actions.unarchive(sel)}><ArchiveRestore className="w-3.5 h-3.5" /> Unarchive</Button>
                    : <Button size="sm" variant="ghost" onClick={() => actions.archive(sel)}><Archive className="w-3.5 h-3.5" /> Archive</Button>}
                  <Link href={`/dashboard/quotes/new?customer=${sel.customer_id}`}><Button size="sm" variant="secondary"><FileText className="w-3.5 h-3.5" /> Quote</Button></Link>
                  <Link href={`/dashboard/customers/${sel.customer_id}`}><Button size="sm" variant="ghost"><User className="w-3.5 h-3.5" /> Profile</Button></Link>
                </div>
              </div>
              <ConversationInfo customerId={sel.customer_id} />
              <div className="flex-1 min-h-0">
                <ConversationThread customerId={sel.customer_id} onRead={load} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-sm text-ink-muted py-16">
              <MessageSquare className="w-8 h-8 text-ink-faint mb-2" /> Select a conversation
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

interface RowActions {
  archive: (c: Convo) => void; unarchive: (c: Convo) => void
  pin: (c: Convo) => void; unpin: (c: Convo) => void
  markUnread: (c: Convo) => void; toggleMute: (c: Convo) => void
  del: (c: Convo) => void; select: (c: Convo) => void
}

function ConversationRow({ c, selected, actions, selectMode, checked, onToggleSelect }: { c: Convo; selected: boolean; actions: RowActions; selectMode: boolean; checked: boolean; onToggleSelect: () => void }) {
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

  // Mobile: swipe left → archive, swipe right → mark unread, long-press → menu.
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

  const needsReply = !c.archived_at && c.last_direction === 'inbound'
  const Item = ({ icon: Icon, label, onClick, danger }: { icon: typeof Pin; label: string; onClick: () => void; danger?: boolean }) => (
    <button onClick={() => { setMenu(false); onClick() }}
      className={cn('w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-surface/60', danger ? 'text-red-400' : 'text-ink')}>
      <Icon className="w-3.5 h-3.5 shrink-0" /> {label}
    </button>
  )

  return (
    <div className="relative overflow-hidden">
      {/* Swipe action hints */}
      <div className="absolute inset-y-0 left-0 w-24 bg-emerald-500/20 flex items-center pl-4 text-emerald-400" style={{ opacity: dx < 0 ? 1 : 0 }}><Archive className="w-4 h-4" /></div>
      <div className="absolute inset-y-0 right-0 w-24 bg-sky-500/20 flex items-center justify-end pr-4 text-sky-400" style={{ opacity: dx > 0 ? 1 : 0 }}><MailOpen className="w-4 h-4" /></div>

      <div
        onClick={() => selectMode ? onToggleSelect() : actions.select(c)}
        onContextMenu={selectMode ? undefined : (e) => { e.preventDefault(); setMenu(true) }}
        onTouchStart={selectMode ? undefined : onTouchStart} onTouchMove={selectMode ? undefined : onTouchMove} onTouchEnd={selectMode ? undefined : onTouchEnd}
        style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 0.15s' : 'none' }}
        className={cn('relative bg-bg-secondary w-full text-left px-4 py-3 hover:bg-surface/40 transition-colors flex items-start gap-3 cursor-pointer', selected && 'bg-accent/5', checked && 'bg-accent/10')}
      >
        {selectMode && <input type="checkbox" readOnly checked={checked} className="accent-accent w-4 h-4 shrink-0 mt-2.5 pointer-events-none" />}
        <div className="w-9 h-9 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 text-xs font-bold text-accent">
          {nameOf(c).slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {c.pinned_at && <Pin className="w-3 h-3 text-accent shrink-0" />}
            <p className={cn('text-sm truncate flex-1', c.unread > 0 ? 'font-bold text-ink' : 'font-semibold text-ink')}>{nameOf(c)}</p>
            {c.muted && <BellOff className="w-3 h-3 text-ink-faint shrink-0" />}
            {c.archived_at && <Archive className="w-3 h-3 text-ink-faint shrink-0" />}
            {c.unread > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">{c.unread > 9 ? '9+' : c.unread}</span>}
          </div>
          <p className={cn('text-xs truncate mt-0.5', c.unread > 0 ? 'text-ink font-medium' : 'text-ink-muted')}>
            {c.last_direction === 'internal' ? 'Note: ' : c.last_direction && c.last_direction !== 'inbound' ? 'You: ' : ''}{c.last_preview || '…'}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[10px] text-ink-faint">{timeAgo(c.last_message_at)}</p>
            {needsReply && <span className="text-[10px] font-semibold text-amber-400 flex items-center gap-0.5"><Reply className="w-2.5 h-2.5" /> Needs reply</span>}
          </div>
        </div>

        {/* ⋯ menu (desktop) */}
        {!selectMode && (
          <button onClick={(e) => { e.stopPropagation(); setMenu(m => !m) }} className="shrink-0 -mr-1 h-7 w-7 rounded-lg text-ink-faint hover:text-ink hover:bg-black/10 flex items-center justify-center" aria-label="Actions">
            <MoreVertical className="w-4 h-4" />
          </button>
        )}
      </div>

      {menu && !selectMode && (
        <div ref={menuRef} onClick={e => e.stopPropagation()} className="absolute right-2 top-12 z-20 w-48 rounded-xl border border-border bg-bg-secondary shadow-xl overflow-hidden py-1">
          {c.archived_at
            ? <Item icon={ArchiveRestore} label="Unarchive" onClick={() => actions.unarchive(c)} />
            : <Item icon={Archive} label="Archive" onClick={() => actions.archive(c)} />}
          {c.pinned_at
            ? <Item icon={PinOff} label="Unpin" onClick={() => actions.unpin(c)} />
            : <Item icon={Pin} label="Pin to top" onClick={() => actions.pin(c)} />}
          <Item icon={MailOpen} label="Mark unread" onClick={() => actions.markUnread(c)} />
          <Item icon={c.muted ? Bell : BellOff} label={c.muted ? 'Unmute' : 'Mute notifications'} onClick={() => actions.toggleMute(c)} />
          <Item icon={User} label="View customer" onClick={() => router.push(`/dashboard/customers/${c.customer_id}`)} />
          <div className="border-t border-border my-1" />
          <Item icon={Trash2} label="Delete permanently" onClick={() => actions.del(c)} danger />
        </div>
      )}
    </div>
  )
}
