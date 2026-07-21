'use client'

// ── Messages tab (the customer's copy of the ONE conversation) ───────────────
// Reads the SAME messages table the owner's Messages hub writes — outbound texts
// the business sent, requests the customer made, and portal chat, one thread.
// Sending inserts an inbound 'portal' message; the existing triggers bump the
// owner's unread and raise their notification. Nothing here touches lib/comms —
// this tab never SENDS to a phone or inbox, it just writes the shared record.
//
// GRANTED EXCEPTION to the tabs-are-presentational rule: this tab keeps its
// direct supabase client (portal_get_messages / portal_send_message via
// actions.token) exactly as the original — the thread is lazily loaded and
// polled here, not part of the get_portal_data payload.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquare, Send } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn, formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import type { PortalMessage } from '../model'
import type { TabProps } from './shared'

export function MessagesTab({ view, actions }: TabProps) {
  const token = actions.token
  const businessName = view.data.business?.company_name ?? null
  const supabase = useMemo(() => createClient(), [])
  const [msgs, setMsgs] = useState<PortalMessage[] | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  // Load on open + a modest poll so an owner reply appears without a manual
  // refresh. 30s is deliberate: portal tabs are short-lived and anon.
  useEffect(() => {
    let alive = true
    async function loadMsgs() {
      const { data } = await supabase.rpc('portal_get_messages', { p_token: token })
      if (alive) setMsgs(m => (Array.isArray(data) ? (data as PortalMessage[]) : (m ?? [])))
    }
    loadMsgs()
    const t = setInterval(loadMsgs, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [token, supabase])

  // Keep the newest message in view — scroll the thread box, never the page.
  const count = msgs?.length ?? 0
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight }, [count])

  async function send() {
    const text = body.trim()
    if (!text || sending) return
    setSending(true); setErr(null)
    const { data: ok, error } = await supabase.rpc('portal_send_message', { p_token: token, p_body: text })
    if (error || !ok) {
      setErr('Your message didn’t send — please try again, or call us directly.')
    } else {
      setBody('')
      // Show it immediately, then reconcile with the server copy (which also
      // picks up anything that arrived meanwhile).
      setMsgs(m => [...(m ?? []), { id: `local-${Date.now()}`, direction: 'inbound', channel: 'portal', body: text, created_at: new Date().toISOString() }])
      setTimeout(async () => {
        const { data } = await supabase.rpc('portal_get_messages', { p_token: token })
        if (Array.isArray(data)) setMsgs(data as PortalMessage[])
      }, 1200)
    }
    setSending(false)
  }

  // Day separators — a thread without dates turns "did they reply yesterday or
  // last month?" into archaeology.
  const rows = useMemo(() => {
    const out: ({ kind: 'day'; key: string; label: string } | { kind: 'msg'; m: PortalMessage })[] = []
    let lastDay = ''
    for (const m of msgs ?? []) {
      const day = (m.created_at || '').slice(0, 10)
      if (day && day !== lastDay) { out.push({ kind: 'day', key: 'd' + day, label: formatDate(day) }); lastDay = day }
      out.push({ kind: 'msg', m })
    }
    return out
  }, [msgs])

  const who = businessName || 'Your service provider'
  return (
    <div className="space-y-3">
      <div className="animate-rise stagger-1 rounded-card border border-border bg-bg-secondary">
        {msgs === null ? (
          <p className="text-sm text-ink-muted flex items-center gap-2 px-4 py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Loading your messages…</p>
        ) : rows.length === 0 ? (
          <div className="py-10 px-6 text-center">
            <MessageSquare className="w-7 h-7 text-ink-faint mx-auto mb-2.5" />
            <p className="text-sm text-ink-muted max-w-xs mx-auto">No messages yet — write to us below and we&rsquo;ll reply right here.</p>
          </div>
        ) : (
          <div ref={threadRef} className="max-h-[26rem] overflow-y-auto px-3.5 py-3 space-y-2">
            {rows.map(r => r.kind === 'day' ? (
              <p key={r.key} className="text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint pt-2">{r.label}</p>
            ) : (
              <MessageBubble key={r.m.id} m={r.m} who={who} />
            ))}
          </div>
        )}
      </div>

      {/* Composer — same shape as the Requests tab's ask, plus the promise of where
          the reply lands. */}
      <div className="animate-rise stagger-2 rounded-card border border-border bg-bg-secondary p-4">
        <form onSubmit={e => { e.preventDefault(); send() }}>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} aria-label="Your message" placeholder={`Message ${businessName || 'us'}…`}
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
          <div className="flex items-center justify-between gap-3 mt-2">
            <p className="text-[11px] text-ink-faint">Goes straight to {businessName ? `${businessName}’s` : 'our'} inbox — replies appear right here.</p>
            <Button size="sm" type="submit" loading={sending} disabled={!body.trim()}><Send className="w-4 h-4" /> Send</Button>
          </div>
        </form>
        {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      </div>
    </div>
  )
}

function MessageBubble({ m, who }: { m: PortalMessage; who: string }) {
  // direction is the OWNER's perspective — 'inbound' is the customer speaking.
  const mine = m.direction === 'inbound'
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const via = m.channel === 'sms' ? ' · by text' : m.channel === 'email' ? ' · by email' : ''
  return (
    <div className={cn('max-w-[85%]', mine ? 'ml-auto' : 'mr-auto')}>
      <div className={cn('rounded-2xl border px-3.5 py-2.5', mine ? 'bg-accent/15 border-accent/25 rounded-br-md' : 'bg-bg-tertiary border-border rounded-bl-md')}>
        <p className="text-sm text-ink whitespace-pre-wrap break-words">{m.body}</p>
      </div>
      <p className={cn('text-[10px] text-ink-faint mt-0.5 px-1', mine ? 'text-right' : 'text-left')}>
        {mine ? 'You' : who}{time ? ` · ${time}` : ''}{via}
      </p>
    </div>
  )
}
