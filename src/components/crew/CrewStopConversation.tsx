'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  loadCrewConversation, postCrewMessage, markInboxRead, newClientToken,
  type CrewMessage,
} from '@/lib/crewMessages'
import { CREW_MEDIA_ACCEPT } from '@/lib/crewMedia'
import { ConversationView, type MessageAttachment, type PendingMessage } from '@/components/conversation/ConversationView'
import { ChevronDown, MessagesSquare } from 'lucide-react'

// ── The visit conversation, from the driveway ────────────────────────────────
// The CREW half of the door. Everything here goes through the DEFINER RPCs in
// lib/crewMessages — a crew session holds no table grants at all, so there is no
// `.from('crew_messages')` in this tree and there cannot be one (verify:crew-access
// fails the build on it, and it would return an empty conversation rather than an
// error, which is the worst possible failure: it reads as "nobody said anything").
//
// ⭐ COLLAPSED UNTIL TAPPED, LIKE THE WORK INSTRUCTIONS BESIDE IT. The unread
// count comes from the day's single inbox fetch (lib/crewMessages' shared feed),
// so a card can honestly say "2 new" without one request per stop. The
// conversation itself is fetched when it is opened — which is also what marks it
// read, server-side, in the same statement that returns the messages.
//
// ⭐ THE OUTBOX IS THE HONESTY MECHANISM. A message the server has not confirmed
// sits in the thread greyed out; a message that FAILED sits there in red with a
// Retry. Nothing is ever drawn as delivered on the strength of a tap. The retry
// reuses the SAME client token, so the double-tap guard in the database answers
// a replay with the row that already landed instead of writing a second one.

interface OutboxEntry {
  key: string
  /** ⭐ Minted ONCE per message, reused by every retry of it. Minting per attempt
   *  would make the database's replay guard a no-op. */
  token: string
  body: string
  files: File[]
  state: 'sending' | 'failed'
  error?: string
}

interface UploadEntry {
  key: string
  messageId: string
  file: File
  state: 'uploading' | 'failed'
  error?: string
}

export function CrewStopConversation({ jobId, unread }: { jobId: string; unread: number }) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<CrewMessage[]>([])
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  const [staged, setStaged] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Signed URLs for anything attached to this visit's messages. The SAME door
  // the work instructions use — one signing path to audit, and a fresh 5-minute
  // window every time the conversation is opened rather than one minted at 7am.
  const fetchAttachments = useCallback(async () => {
    try {
      const res = await fetch(`/api/crew/media?jobId=${encodeURIComponent(jobId)}`)
      const d = await res.json().catch(() => ({}))
      if (!alive.current || !res.ok || !d.ok) return
      const rows = (d.media || []) as { id: string; message_id: string | null; kind: 'photo' | 'video'; mime: string | null; url: string | null }[]
      setAttachments(rows.filter(r => r.message_id).map(r => ({
        id: r.id, messageId: r.message_id as string, kind: r.kind, url: r.url, mime: r.mime,
      })))
    } catch { /* attachments are an enhancement; the words still arrived */ }
  }, [jobId])

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null)
    const res = await loadCrewConversation(supabase, jobId)
    if (!alive.current) return
    setLoading(false)
    if (res.kind === 'ok') {
      setMessages(res.conversation.messages)
      setBlocked(null)
      // The server already stamped the high-water mark inside that same call —
      // this only keeps the badge on this card and the one on the nav in step
      // before the next refresh lands.
      markInboxRead(jobId)
      if (res.conversation.messages.length) void fetchAttachments()
      return
    }
    if (res.kind === 'revoked') { setBlocked('Your crew access has been turned off. Talk to the office.'); return }
    if (res.kind === 'denied') { setBlocked('This visit isn’t on your board.'); return }
    // ⛔ Keep whatever is on screen. A dead zone must not blank a conversation.
    setLoadError('Couldn’t load the conversation.')
  }, [supabase, jobId, fetchAttachments])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && !messages.length && !loading) void load()
  }

  async function uploadOne(entry: UploadEntry) {
    setUploads(prev => prev.map(u => u.key === entry.key ? { ...u, state: 'uploading', error: undefined } : u))
    try {
      const body = new FormData()
      body.set('jobId', jobId)
      body.set('messageId', entry.messageId)
      body.set('file', entry.file)
      const res = await fetch('/api/crew/media', { method: 'POST', body })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.ok) throw new Error(d.error || 'The file didn’t attach.')
      if (!alive.current) return
      setUploads(prev => prev.filter(u => u.key !== entry.key))
      void fetchAttachments()
    } catch (e) {
      if (!alive.current) return
      // ⛔ The message itself DID land — only the file did not. Saying so keeps
      // the two facts apart instead of implying the whole send failed.
      setUploads(prev => prev.map(u => u.key === entry.key
        ? { ...u, state: 'failed', error: e instanceof Error ? e.message : 'Attachment failed.' } : u))
    }
  }

  async function attempt(entry: OutboxEntry) {
    setOutbox(prev => prev.map(o => o.key === entry.key ? { ...o, state: 'sending', error: undefined } : o))
    const res = await postCrewMessage(supabase, jobId, entry.body, entry.token)
    if (!alive.current) return
    if (res.kind === 'ok') {
      setOutbox(prev => prev.filter(o => o.key !== entry.key))
      // Idempotent on the id, so a retry whose first attempt actually landed
      // cannot paint the same message twice.
      setMessages(prev => prev.some(m => m.id === res.message.id) ? prev : [...prev, res.message])
      const msgId = res.message.id
      for (const file of entry.files) {
        const u: UploadEntry = { key: `${msgId}-${file.name}-${file.size}`, messageId: msgId, file, state: 'uploading' }
        setUploads(prev => [...prev, u])
        void uploadOne(u)
      }
      return
    }
    const why = res.kind === 'revoked'
      ? 'Your crew access has been turned off.'
      : res.message
    setOutbox(prev => prev.map(o => o.key === entry.key ? { ...o, state: 'failed', error: why } : o))
  }

  function send(text: string) {
    const entry: OutboxEntry = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      token: newClientToken(),
      body: text,
      files: staged,
      state: 'sending',
    }
    setStaged([])
    setOutbox(prev => [...prev, entry])
    void attempt(entry)
  }

  const pending: PendingMessage[] = outbox.map(o => ({
    key: o.key,
    body: o.files.length ? `${o.body}` : o.body,
    state: o.state,
    error: o.error,
  }))

  const badge = unread > 0

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="tap-target w-full h-10 px-2.5 rounded-lg border border-border bg-bg-tertiary/40 flex items-center gap-2 text-left"
      >
        <MessagesSquare className={cn('w-4 h-4 shrink-0', badge ? 'text-accent-text' : 'text-ink-faint')} aria-hidden />
        <span className="text-xs font-medium text-ink-muted flex-1 min-w-0 truncate">Crew chat</span>
        {badge && (
          <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        <ChevronDown className={cn('w-4 h-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5">
          <ConversationView
            messages={messages}
            pending={pending}
            attachments={attachments}
            loading={loading}
            loadError={loadError}
            onReload={() => void load()}
            onSend={send}
            onRetry={key => { const e = outbox.find(o => o.key === key); if (e) void attempt(e) }}
            onDiscard={key => setOutbox(prev => prev.filter(o => o.key !== key))}
            disabledReason={blocked}
            placeholder="Message the office…"
            onPickFiles={files => setStaged(prev => [...prev, ...Array.from(files)])}
            attachAccept={CREW_MEDIA_ACCEPT}
            uploads={[
              ...staged.map(f => ({ key: `staged-${f.name}-${f.size}`, name: `${f.name} — sends with your message`, state: 'uploading' as const })),
              ...uploads.map(u => ({ key: u.key, name: u.file.name, state: u.state, error: u.error })),
            ]}
            onRetryUpload={key => { const u = uploads.find(x => x.key === key); if (u) void uploadOne(u) }}
            onDiscardUpload={key => {
              setUploads(prev => prev.filter(x => x.key !== key))
              setStaged(prev => prev.filter(f => `staged-${f.name}-${f.size}` !== key))
            }}
          />
        </div>
      )}
    </div>
  )
}
