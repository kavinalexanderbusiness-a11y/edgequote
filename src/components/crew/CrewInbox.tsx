'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn, timeAgo } from '@/lib/utils'
import {
  startCrewInboxFeed, subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot,
  getCrewInboxState, refreshCrewInbox, markInboxRead, loadCrewConversation, postCrewMessage,
  newClientToken, type CrewInboxItem, type CrewMessage,
} from '@/lib/crewMessages'
import { ConversationView, type PendingMessage } from '@/components/conversation/ConversationView'
import { AlertTriangle, ChevronLeft, MessagesSquare } from 'lucide-react'

// ── Messages ─────────────────────────────────────────────────────────────────
// ⭐ AN INBOX OF VISITS, NOT A LIST OF CHANNELS. Every row names the WORK it is
// about, because "Jake: need another bag" is unanswerable without it. There are
// no channels to create, join, mute or name; a conversation exists because
// somebody said something about a visit, and it disappears from here when the
// talk goes quiet (the RPC windows to 30 days).
//
// This screen exists for exactly one reason: without it, a message about
// tomorrow's visit — or about one already finished — is invisible, because
// Today only shows today. That is the "messages get lost" failure, and it is the
// entire justification for a second surface. It is not a chat app.

type View = { kind: 'list' } | { kind: 'thread'; item: CrewInboxItem }

interface OutboxEntry {
  key: string
  token: string
  body: string
  state: 'sending' | 'failed'
  error?: string
}

export function CrewInbox() {
  const supabase = useMemo(() => createClient(), [])
  const items = useSyncExternalStore(subscribeCrewInbox, getCrewInboxSnapshot, getCrewInboxServerSnapshot)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [state, setState] = useState<'idle' | 'ok' | 'revoked' | 'error'>('idle')

  useEffect(() => startCrewInboxFeed(supabase), [supabase])
  // The store's own state is not reactive through useSyncExternalStore (it is a
  // scalar beside the list), so it is mirrored on each emission.
  useEffect(() => subscribeCrewInbox(() => setState(getCrewInboxState())), [])

  if (view.kind === 'thread') {
    return (
      <Thread
        item={view.item}
        onBack={() => { setView({ kind: 'list' }); void refreshCrewInbox(supabase) }}
      />
    )
  }

  // Three outcomes, kept apart exactly as every other crew read keeps them:
  // revocation is what the DATABASE said, an error is what never got asked, and
  // an empty list is a fact about the work.
  if (state === 'revoked') {
    return (
      <Notice title="Your access has been turned off">
        Your account is no longer active on this crew. Ask your manager to switch it back on.
      </Notice>
    )
  }
  if (state === 'error' && items.length === 0) {
    return (
      <Notice title="Couldn’t load your messages">
        Check your signal and reload. Nothing here is out of date — nothing loaded.
      </Notice>
    )
  }

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-ink">Messages</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          {items.length === 0
            ? 'Nothing yet. Messages about a visit stay with that visit.'
            : `${items.length} conversation${items.length === 1 ? '' : 's'} about your work`}
        </p>
      </header>

      {state === 'error' && items.length > 0 && (
        <p className="text-[11px] text-amber-300">
          Couldn’t refresh — showing what loaded last.
        </p>
      )}

      {items.length === 0 ? (
        <div className="rounded-card border border-border bg-bg-secondary p-4 text-center">
          <MessagesSquare className="mx-auto w-6 h-6 text-ink-faint" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-ink">No messages</p>
          <p className="mt-1 text-xs text-ink-muted">
            When the office writes about a visit — or you do — it shows up here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map(i => (
            <li key={i.job_id}>
              <button
                type="button"
                onClick={() => { markInboxRead(i.job_id); setView({ kind: 'thread', item: i }) }}
                className="tap-target w-full text-left rounded-card border border-border bg-bg-secondary p-3 active:scale-[0.99] transition-transform"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    {/* ⭐ WHICH JOB, FIRST. The customer's name if there is one,
                        the visit title otherwise — never a channel name. */}
                    <p className="text-sm font-semibold text-ink truncate">
                      {i.customer_name || i.title}
                    </p>
                    {i.customer_name && (
                      <p className="text-[11px] text-ink-faint truncate">{i.title}</p>
                    )}
                    <p className={cn('mt-1 text-xs truncate', i.unread ? 'text-ink' : 'text-ink-muted')}>
                      <span className="font-medium">{i.last_author}:</span> {i.last_body}
                    </p>
                    <p className="mt-0.5 text-[10px] text-ink-faint">{timeAgo(i.last_at)}</p>
                  </div>
                  {i.unread > 0 && (
                    <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
                      {i.unread > 9 ? '9+' : i.unread}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── One conversation, opened from the inbox ──────────────────────────────────
// Deliberately the SAME ConversationView the stop card renders, reading through
// the SAME RPCs. There is one conversation per visit, and it does not look or
// behave differently depending on which door you came through.
function Thread({ item, onBack }: { item: CrewInboxItem; onBack: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [messages, setMessages] = useState<CrewMessage[]>([])
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)

  const load = useMemo(() => async () => {
    setLoading(true); setLoadError(null)
    const res = await loadCrewConversation(supabase, item.job_id)
    setLoading(false)
    if (res.kind === 'ok') { setMessages(res.conversation.messages); markInboxRead(item.job_id); return }
    if (res.kind === 'revoked') { setBlocked('Your crew access has been turned off.'); return }
    if (res.kind === 'denied') { setBlocked('This visit isn’t on your board.'); return }
    setLoadError('Couldn’t load the conversation.')
  }, [supabase, item.job_id])

  useEffect(() => { void load() }, [load])

  async function attempt(entry: OutboxEntry) {
    setOutbox(prev => prev.map(o => o.key === entry.key ? { ...o, state: 'sending', error: undefined } : o))
    const res = await postCrewMessage(supabase, item.job_id, entry.body, entry.token)
    if (res.kind === 'ok') {
      setOutbox(prev => prev.filter(o => o.key !== entry.key))
      setMessages(prev => prev.some(m => m.id === res.message.id) ? prev : [...prev, res.message])
      return
    }
    const why = res.kind === 'revoked' ? 'Your crew access has been turned off.' : res.message
    setOutbox(prev => prev.map(o => o.key === entry.key ? { ...o, state: 'failed', error: why } : o))
  }

  const pending: PendingMessage[] = outbox.map(o => ({ key: o.key, body: o.body, state: o.state, error: o.error }))

  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack}
        className="tap-target h-10 -ml-2 px-2 rounded-lg text-sm text-ink-muted flex items-center gap-1 hover:text-ink">
        <ChevronLeft className="w-4 h-4" aria-hidden /> Messages
      </button>
      <header>
        <h1 className="text-lg font-bold tracking-tight text-ink truncate">{item.customer_name || item.title}</h1>
        <p className="mt-0.5 text-xs text-ink-muted truncate">{item.title}</p>
      </header>
      <div className="rounded-card border border-border bg-bg-secondary p-2.5">
        <ConversationView
          messages={messages}
          pending={pending}
          loading={loading}
          loadError={loadError}
          onReload={() => void load()}
          onSend={text => {
            const entry: OutboxEntry = {
              key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              token: newClientToken(), body: text, state: 'sending',
            }
            setOutbox(prev => [...prev, entry])
            void attempt(entry)
          }}
          onRetry={key => { const e = outbox.find(o => o.key === key); if (e) void attempt(e) }}
          onDiscard={key => setOutbox(prev => prev.filter(o => o.key !== key))}
          disabledReason={blocked}
          placeholder="Message the office…"
        />
      </div>
    </div>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <AlertTriangle className="w-4 h-4 text-amber-300" aria-hidden /> {title}
      </p>
      <p className="mt-1 text-xs text-ink-muted">{children}</p>
    </div>
  )
}
