'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { newClientMessageId } from '@/lib/comms/idempotency'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { MSG_LABELS, MsgType } from '@/lib/comms/templates'
import { describeSkip } from '@/lib/comms/skipReasons'
import { statusMeta, TONE_CLASS } from '@/lib/comms/logStatus'
import { SmsCost } from '@/components/comms/SmsCost'
import { thumbUrl } from '@/lib/photos'
import { extractBookingPhotos } from '@/lib/bookingPhotos'
import { Send, StickyNote, Clock, Mail, MessageSquare, Camera } from 'lucide-react'
import { format } from 'date-fns'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'

interface Msg { id: string; created_at: string; direction: string; channel: string; body: string; status: string | null }
interface Log { id: string; created_at: string; channel: string; template: string; status: string; message_id: string | null; detail: string | null }
type Photo = { thumb: string; full: string }
type Item = { id: string; at: string; kind: 'in' | 'out' | 'note' | 'event'; channel: string; body: string; status?: string | null; template?: string; detail?: string | null; photos?: Photo[] }

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
  // Guards a fast conversation switch: a slow load for an earlier customer must never
  // overwrite the thread you've since opened (the component is reused across both).
  const reqSeq = useRef(0)
  // Coalesce reload bursts into ONE fetch. A send triggers an explicit refresh AND a
  // realtime INSERT echo for the same row — without this that's two identical 2-query
  // reloads (and two repaints). A latest-ref keeps the debounced call bound to the
  // current customer's load; the mount/switch load still runs immediately.
  const loadRef = useRef<() => void>(() => {})
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleLoad = useCallback(() => {
    if (loadTimer.current) clearTimeout(loadTimer.current)
    loadTimer.current = setTimeout(() => { loadTimer.current = null; loadRef.current() }, 160)
  }, [])
  useEffect(() => () => { if (loadTimer.current) clearTimeout(loadTimer.current) }, [])

  async function load() {
    const mySeq = ++reqSeq.current
    const cid = customerId
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { if (mySeq === reqSeq.current) setLoading(false); return }
    const [mRes, lRes, qRes] = await Promise.all([
      supabase.from('messages').select('id, created_at, direction, channel, body, status').eq('customer_id', cid).eq('user_id', uid).order('created_at'),
      supabase.from('notification_log').select('id, created_at, channel, template, status, message_id, detail').eq('customer_id', cid).eq('user_id', uid).neq('template', 'reply').order('created_at'),
      // Photos the customer attached during online booking live on the draft quote's
      // lead_meta.photos (booking-uploads bucket) — surface them ON the booking event.
      supabase.from('quotes').select('lead_meta').eq('customer_id', cid).eq('user_id', uid),
    ])
    const bookingPhotos: Photo[] = []
    for (const q of (qRes.data as { lead_meta?: unknown }[] || [])) {
      for (const u of extractBookingPhotos(q.lead_meta)) bookingPhotos.push({ thumb: thumbUrl(u, 160, 160), full: u })
    }
    // Mark THIS conversation read (you opened it) regardless of a later switch; only
    // the latest load is allowed to repaint the visible thread + refresh inbox counts.
    supabase.from('conversations').update({ unread: 0 }).eq('user_id', uid).eq('customer_id', cid).then(() => { if (mySeq === reqSeq.current) onRead?.() })
    if (mySeq !== reqSeq.current) return
    // Attach the booking photos to the online-booking event (its message body starts
    // "New online booking") so the thread shows a "Customer attached N photos" strip.
    let bookingAttached = false
    const msgs: Item[] = (mRes.data as Msg[] || []).map(m => {
      const isBooking = m.direction === 'inbound' && /^New online booking/i.test(m.body || '')
      const photos = isBooking && !bookingAttached && bookingPhotos.length ? (bookingAttached = true, bookingPhotos) : undefined
      return {
        id: 'm' + m.id, at: m.created_at, channel: m.channel, body: m.body, status: m.status,
        kind: m.direction === 'inbound' ? 'in' : m.direction === 'internal' ? 'note' : 'out',
        photos,
      }
    })
    // A log row linked to a thread message is already shown as the full bubble —
    // skip its event pill so a sent message isn't displayed twice.
    // Carry the raw log fields; the timeline badge + TRUTHFUL skip reason are derived
    // at render from status + detail (never a hardcoded "no opt-in").
    const logs: Item[] = (lRes.data as Log[] || []).filter(l => !l.message_id).map(l => ({
      id: 'l' + l.id, at: l.created_at, channel: l.channel, kind: 'event',
      status: l.status, template: l.template, detail: l.detail, body: '',
    }))
    setItems([...msgs, ...logs].sort((a, b) => a.at.localeCompare(b.at)))
    setLoading(false)
  }
  loadRef.current = load // keep the debounced reload pointed at the current closure
  // On switch: show the skeleton and load fresh (the seq guard drops any stale load).
  useEffect(() => { setLoading(true); setErr(null); load() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [items.length])

  // Drafts: restore an unsent message when (re)opening a conversation, and auto-save
  // as you type so closing/switching mid-message never loses it. Sending clears it.
  useEffect(() => { try { setText(localStorage.getItem('eq-draft-' + customerId) || '') } catch { setText('') } }, [customerId])
  useEffect(() => {
    try { if (text.trim()) localStorage.setItem('eq-draft-' + customerId, text); else localStorage.removeItem('eq-draft-' + customerId) } catch { /* private mode */ }
  }, [text, customerId])

  // Realtime: a new message for this customer (inbound SMS, or the owner's own
  // reply from another device) refreshes the thread live. Reloading also
  // re-marks the conversation read while it's open. RLS scopes the stream to us.
  useEffect(() => {
    const channel = supabase
      .channel(`thread:${customerId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `customer_id=eq.${customerId}` }, () => scheduleLoad())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const t = text.trim()
    if (!t) return
    const isNote = note
    // Optimistic: show the bubble instantly (status 'sending'), clear the box, then
    // reconcile with the server. Offline → the message is queued in the ONE outbox and
    // sent automatically on reconnect (through the same /api/messages/send engine); the
    // bubble stays as 'queued'. A real (non-network) failure rolls the bubble back.
    const pendId = 'pending-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(items.length))
    // ONE stable id for this logical send. Threaded into BOTH the immediate request and
    // the outbox payload, so a send that runs now and the SAME send replayed later carry
    // the same id → the server dispatches the SMS at most once (no duplicate on replay).
    const clientMessageId = newClientMessageId()
    setItems(prev => [...prev, { id: pendId, at: new Date().toISOString(), kind: isNote ? 'note' : 'out', channel: 'sms', body: t, status: 'sending' }])
    setText(''); setSending(true); setErr(null)
    let deliveryWarn: string | null = null
    try {
      const outcome = await queueOrRun(
        { kind: 'message.send', payload: { customerId, body: t, internal: isNote, clientMessageId }, label: `${isNote ? 'Note' : 'Message'}: ${t.slice(0, 40)}` },
        async () => {
          const res = await fetch('/api/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId, body: t, internal: isNote, clientMessageId }) })
          const d = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(d.error || 'send failed')
          // Saved server-side but SMS not delivered → surface a soft warning (don't roll back).
          if (d.ok === false && !d.internal) deliveryWarn = d.error || 'Message saved, but the text couldn’t be delivered.'
        },
        // A lost response after the server may have sent must NOT re-queue (→ no double SMS);
        // true offline still queues. See queueOrRun.
        { queueOnRunError: false },
      )
      if (outcome === 'queued') {
        setItems(prev => prev.map(i => i.id === pendId ? { ...i, status: 'queued' } : i))
      } else {
        if (deliveryWarn) setErr(deliveryWarn)
        scheduleLoad() // replaces the optimistic bubble with the saved message; coalesces with the realtime echo
      }
    } catch {
      setErr('Message could not be sent. Please try again.')
      setItems(prev => prev.filter(i => i.id !== pendId))
      setText(t)
    } finally { setSending(false) }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-1 py-2 space-y-2 min-h-[220px]">
        {loading ? (
          <div className="space-y-2.5 py-2">
            {[0, 1, 2, 3, 4].map(i => (
              <Skeleton key={i} className={cn('rounded-xl', i % 3 === 0 ? 'h-12' : 'h-8', i % 2 ? 'w-40 ml-auto' : 'w-48')} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <EmptyState icon={MessageSquare} className="py-10" title="No messages yet"
              description="Send the first message below — it’ll save to this customer’s history." />
          </div>
        ) : items.map(it => <Bubble key={it.id} it={it} customerId={customerId} />)}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border pt-2 mt-1">
        {err && <p className="text-xs text-red-400 mb-1">{err}</p>}
        <div className="flex items-end gap-2">
          <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
              else if (e.key === 'Escape') e.currentTarget.blur()
            }}
            placeholder={note ? 'Internal note (not sent to the customer)…' : 'Reply by SMS…'}
            className={cn('flex-1 rounded-lg border px-3 py-2 text-sm text-ink outline-none focus:border-accent resize-none',
              note ? 'bg-amber-500/5 border-amber-500/30' : 'bg-bg-tertiary border-border-strong')} />
          <div className="flex flex-col gap-1.5 shrink-0">
            <button type="button" onClick={() => setNote(n => !n)} title="Toggle internal note"
              aria-pressed={note} aria-label="Internal note mode"
              className={cn('h-8 w-9 rounded-lg border flex items-center justify-center', note ? 'text-amber-400 border-amber-500/40 bg-amber-500/10' : 'text-ink-faint border-border hover:text-ink')}>
              <StickyNote className="w-4 h-4" />
            </button>
            <Button size="sm" onClick={send} loading={sending} disabled={!text.trim()}
              aria-label={note ? 'Save note' : 'Send message'} title={note ? 'Save note' : 'Send message'}>
              {note ? 'Save note' : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <p className="text-[10px] text-ink-faint mt-1">{note ? 'Internal note — only you see this.' : 'Sends an SMS via your number. ⌘/Ctrl+Enter to send.'}</p>
        {!note && <SmsCost text={text} className="mt-1.5" />}
      </div>
    </div>
  )
}

// Memoized: `it` refs are stable between reloads, so typing in the reply box no longer
// re-renders (and re-formats the date of) every bubble in a long thread.
const Bubble = memo(function Bubble({ it, customerId }: { it: Item; customerId: string }) {
  const time = (() => { try { return format(new Date(it.at), 'MMM d, h:mm a') } catch { return '' } })()
  if (it.kind === 'event') {
    // Badge from status (future-proof) + the TRUTHFUL skip reason from detail.
    const meta = statusMeta(it.status)
    const templateLabel = MSG_LABELS[it.template as MsgType] || it.template || ''
    const skip = it.status === 'skipped' ? describeSkip(it.detail) : null
    const reason = it.status === 'disabled' ? 'messaging not set up' : skip?.label   // never claim "no opt-in" unless that's the reason
    return (
      <div className="text-center space-y-0.5">
        <span className={cn('inline-flex items-center gap-1 text-[10px] rounded-full px-2.5 py-0.5 border', TONE_CLASS[meta.tone])}>
          <meta.Icon className="w-3 h-3 shrink-0" />
          {meta.label}{reason && it.status !== 'sent' ? ` (${reason})` : ''} · {templateLabel} · {it.channel} · {time}
        </span>
        {skip?.action && (
          <Link href={`/dashboard/customers/${customerId}`} className="block text-[10px] text-accent hover:underline">
            {skip.action === 'add_email' ? 'Add an email address →' : 'Add a phone number →'}
          </Link>
        )}
      </div>
    )
  }
  const sending = it.status === 'sending'
  const queued = it.status === 'queued'   // offline — held in the outbox, sends on reconnect
  if (it.kind === 'note') {
    return (
      <div className={cn('ml-auto max-w-[82%] rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2 transition-opacity', (sending || queued) && 'opacity-70')}>
        <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wide flex items-center gap-1"><StickyNote className="w-3 h-3" /> Internal note</p>
        <p className="text-sm text-ink whitespace-pre-wrap mt-0.5">{it.body}</p>
        <p className="text-[10px] text-ink-faint mt-0.5 flex items-center gap-1">{sending ? <><Clock className="w-3 h-3" /> Saving…</> : queued ? <><Clock className="w-3 h-3" /> Queued · saves when online</> : time}</p>
      </div>
    )
  }
  const inbound = it.kind === 'in'
  const Icon = it.channel === 'email' ? Mail : MessageSquare
  const photos = it.photos
  return (
    <div className={cn('max-w-[82%] rounded-xl px-3 py-2 transition-opacity', inbound ? 'bg-bg-tertiary border border-border' : 'ml-auto bg-accent/15 border border-accent/25', (sending || queued) && 'opacity-70')}>
      <p className="text-sm text-ink whitespace-pre-wrap">{it.body}</p>
      {photos && photos.length > 0 && (
        <>
          <p className="text-[11px] text-ink-muted mt-1.5 flex items-center gap-1.5"><Camera className="w-3.5 h-3.5 text-ink-faint" /> Customer attached {photos.length} photo{photos.length !== 1 ? 's' : ''}</p>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {photos.map((ph, i) => (
              <a key={i} href={ph.full} target="_blank" rel="noopener noreferrer"
                className="block w-16 h-16 rounded-lg overflow-hidden border border-border bg-bg-tertiary hover:border-accent transition-colors" title="Open full size">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ph.thumb} alt="Customer photo" loading="lazy" className="w-full h-full object-cover" />
              </a>
            ))}
          </div>
        </>
      )}
      <p className="text-[10px] text-ink-faint mt-0.5 flex items-center gap-1">
        {sending ? <><Clock className="w-3 h-3" /> Sending…</> : queued ? <><Clock className="w-3 h-3" /> Queued · sends when online</> : <><Icon className="w-3 h-3" /> {inbound ? (it.channel === 'portal' ? 'Portal' : 'Received') : 'Sent'} · {time}{!inbound && it.status && it.status !== 'sent' && <span className="text-amber-400">· {it.status}</span>}</>}
      </p>
    </div>
  )
})
