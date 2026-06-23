'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { MSG_LABELS, MsgType } from '@/lib/comms/templates'
import { Send, StickyNote, Loader2, Mail, MessageSquare } from 'lucide-react'
import { format } from 'date-fns'

interface Msg { id: string; created_at: string; direction: string; channel: string; body: string; status: string | null }
interface Log { id: string; created_at: string; channel: string; template: string; status: string }
type Item = { id: string; at: string; kind: 'in' | 'out' | 'note' | 'event'; channel: string; body: string; status?: string | null }

// One customer's unified timeline: inbound SMS + portal requests, outbound
// replies, internal notes, and templated sends (from notification_log). Reply by
// SMS through the one comms sender, or leave an internal note.
export function ConversationThread({ customerId, onRead }: { customerId: string; onRead?: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [note, setNote] = useState(false)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const [mRes, lRes] = await Promise.all([
      supabase.from('messages').select('id, created_at, direction, channel, body, status').eq('customer_id', customerId).eq('user_id', user.id).order('created_at'),
      supabase.from('notification_log').select('id, created_at, channel, template, status').eq('customer_id', customerId).eq('user_id', user.id).neq('template', 'reply').order('created_at'),
    ])
    const msgs: Item[] = (mRes.data as Msg[] || []).map(m => ({
      id: 'm' + m.id, at: m.created_at, channel: m.channel, body: m.body, status: m.status,
      kind: m.direction === 'inbound' ? 'in' : m.direction === 'internal' ? 'note' : 'out',
    }))
    const logs: Item[] = (lRes.data as Log[] || []).map(l => ({
      id: 'l' + l.id, at: l.created_at, channel: l.channel, kind: 'event',
      body: `Sent ${MSG_LABELS[l.template as MsgType] || l.template} · ${l.channel}`, status: l.status,
    }))
    setItems([...msgs, ...logs].sort((a, b) => a.at.localeCompare(b.at)))
    setLoading(false)
    await supabase.from('conversations').update({ unread: 0 }).eq('user_id', user.id).eq('customer_id', customerId)
    onRead?.()
  }
  useEffect(() => { load() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [items.length])

  async function send() {
    const t = text.trim()
    if (!t) return
    setSending(true); setErr(null)
    try {
      const res = await fetch('/api/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId, body: t, internal: note }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || (d.ok === false && !d.internal)) { setErr(d.error || 'Could not send. Please try again.'); return }
      setText(''); await load()
    } catch { setErr('Could not reach the server. Please try again.') } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-1 py-2 space-y-2 min-h-[220px]">
        {loading ? (
          <div className="h-full flex items-center justify-center text-ink-muted"><Loader2 className="w-4 h-4 animate-spin" /></div>
        ) : items.length === 0 ? (
          <p className="text-center text-sm text-ink-muted py-10">No messages yet. Send the first one below.</p>
        ) : items.map(it => <Bubble key={it.id} it={it} />)}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border pt-2 mt-1">
        {err && <p className="text-xs text-red-400 mb-1">{err}</p>}
        <div className="flex items-end gap-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            placeholder={note ? 'Internal note (not sent to the customer)…' : 'Reply by SMS…'}
            className={cn('flex-1 rounded-lg border px-3 py-2 text-sm text-ink outline-none focus:border-accent resize-none',
              note ? 'bg-amber-500/5 border-amber-500/30' : 'bg-bg-tertiary border-border-strong')} />
          <div className="flex flex-col gap-1.5 shrink-0">
            <button type="button" onClick={() => setNote(n => !n)} title="Toggle internal note"
              className={cn('h-8 w-9 rounded-lg border flex items-center justify-center', note ? 'text-amber-400 border-amber-500/40 bg-amber-500/10' : 'text-ink-faint border-border hover:text-ink')}>
              <StickyNote className="w-4 h-4" />
            </button>
            <Button size="sm" onClick={send} loading={sending} disabled={!text.trim()}>{note ? 'Save' : <Send className="w-4 h-4" />}</Button>
          </div>
        </div>
        <p className="text-[10px] text-ink-faint mt-1">{note ? 'Internal note — only you see this.' : 'Sends an SMS via your number. ⌘/Ctrl+Enter to send.'}</p>
      </div>
    </div>
  )
}

function Bubble({ it }: { it: Item }) {
  const time = (() => { try { return format(new Date(it.at), 'MMM d, h:mm a') } catch { return '' } })()
  if (it.kind === 'event') {
    return <div className="text-center"><span className="inline-block text-[10px] text-ink-faint bg-bg-tertiary border border-border rounded-full px-2.5 py-0.5">{it.body} · {time}</span></div>
  }
  if (it.kind === 'note') {
    return (
      <div className="ml-auto max-w-[82%] rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2">
        <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wide flex items-center gap-1"><StickyNote className="w-3 h-3" /> Internal note</p>
        <p className="text-sm text-ink whitespace-pre-wrap mt-0.5">{it.body}</p>
        <p className="text-[10px] text-ink-faint mt-0.5">{time}</p>
      </div>
    )
  }
  const inbound = it.kind === 'in'
  const Icon = it.channel === 'email' ? Mail : MessageSquare
  return (
    <div className={cn('max-w-[82%] rounded-xl px-3 py-2', inbound ? 'bg-bg-tertiary border border-border' : 'ml-auto bg-accent/15 border border-accent/25')}>
      <p className="text-sm text-ink whitespace-pre-wrap">{it.body}</p>
      <p className="text-[10px] text-ink-faint mt-0.5 flex items-center gap-1">
        <Icon className="w-3 h-3" /> {inbound ? (it.channel === 'portal' ? 'Portal' : 'Received') : 'Sent'} · {time}
        {!inbound && it.status && it.status !== 'sent' && <span className="text-amber-400">· {it.status}</span>}
      </p>
    </div>
  )
}
