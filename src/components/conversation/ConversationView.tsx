'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { MAX_MESSAGE_CHARS, type CrewMessage } from '@/lib/crewMessages'
import { AlertTriangle, CalendarClock, Loader2, RotateCw, Send, X } from 'lucide-react'

// ── The visit conversation, as pixels ────────────────────────────────────────
// ⭐ PURE. This component performs NO data access — no supabase client, no fetch,
// no `.from(`, no `.rpc(`. It receives messages and hands back intent. That is
// what lets the OWNER's screen (table access under RLS) and the CREW's screen
// (DEFINER RPCs, no table grants at all) render the identical conversation
// without either one being able to reach the other's door by importing this.
// verify:crew-messages pins the emptiness.
//
// ⭐ THE OUTBOX IS PART OF THE THREAD, NOT A TOAST. A message being sent, and a
// message that FAILED to send, both sit in the transcript where they were typed
// — greyed while in flight, marked with a Retry when they fail. The rule this
// serves: **nothing on this screen ever looks sent when it is not.** A toast
// that says "couldn't send" while the message sits in the thread looking
// delivered is the exact lie this component exists to make impossible.
//
// MOBILE (375 / 390 / 430, one hand, gloves):
//   · The thread scrolls INSIDE itself; the composer sits below it in normal
//     document flow. That is deliberate — a `position: fixed` composer is what
//     puts Send under the on-screen keyboard on iOS. In flow, focusing the box
//     scrolls the box AND the button into view together, every time.
//   · Send is a 44px tap target. So is Retry, and so is Discard.
//   · Long words break, long messages wrap, and media is width-bounded.

/** A message the person has typed that the server has not yet confirmed. */
export interface PendingMessage {
  key: string
  body: string
  state: 'sending' | 'failed'
  error?: string
}

/** A signed, short-lived attachment on one message. */
export interface MessageAttachment {
  id: string
  messageId: string
  kind: 'photo' | 'video'
  url: string | null
  mime: string | null
}

interface Props {
  messages: CrewMessage[]
  pending: PendingMessage[]
  attachments?: MessageAttachment[]
  loading?: boolean
  /** Set when the conversation could not be READ. Different from "no messages". */
  loadError?: string | null
  onReload?: () => void
  onSend: (text: string) => void
  onRetry: (key: string) => void
  onDiscard: (key: string) => void
  /** Rendered in the composer when there is nothing to say yet. */
  placeholder?: string
  /** Blocks the composer with a reason (revoked access, cancelled tenant, …). */
  disabledReason?: string | null
  /** A file picker for attachments, when the surface offers one. */
  onPickFiles?: (files: FileList) => void
  attachAccept?: string
  /** Attachments still in flight or failed, rendered under the composer. */
  uploads?: { key: string; name: string; state: 'uploading' | 'failed'; error?: string }[]
  onRetryUpload?: (key: string) => void
  onDiscardUpload?: (key: string) => void
}

// "9:14 AM" — the only time format a conversation needs.
function clockTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch { return '' }
}

// "Today" / "Yesterday" / "Mon, Aug 11" — the divider between days, so a thread
// that spans a week does not read as one long morning.
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((midnight(today) - midnight(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  try {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  } catch { return '' }
}

export function ConversationView({
  messages, pending, attachments, loading, loadError, onReload,
  onSend, onRetry, onDiscard, placeholder, disabledReason,
  onPickFiles, attachAccept, uploads, onRetryUpload, onDiscardUpload,
}: Props) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Keep the newest line in view as the conversation grows — including when the
  // person's own message joins the outbox, so they see it land where they typed.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length, pending.length])

  const tooLong = text.trim().length > MAX_MESSAGE_CHARS
  const canSend = text.trim().length > 0 && !tooLong && !disabledReason

  function submit() {
    if (!canSend) return
    onSend(text.trim())
    setText('')      // the container now owns it, in the outbox, visibly
  }

  let lastDay = ''

  return (
    <div className="space-y-2">
      {/* ── The transcript ───────────────────────────────────────────────── */}
      <div className="max-h-[50vh] overflow-y-auto overscroll-contain space-y-2 pr-0.5">
        {loading && (
          <p className="text-xs text-ink-faint flex items-center gap-1.5 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Loading the conversation…
          </p>
        )}

        {/* ⛔ A failed READ is not an empty conversation. Saying "no messages
            yet" here would be a statement about the visit that we have no
            evidence for, and it invites someone to repeat what was already
            said. */}
        {!loading && loadError && (
          <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
            <span className="min-w-0">
              {loadError}
              {onReload && (
                <button type="button" onClick={onReload} className="ml-1.5 font-semibold underline underline-offset-2">
                  Retry
                </button>
              )}
            </span>
          </div>
        )}

        {!loading && !loadError && messages.length === 0 && pending.length === 0 && (
          <p className="text-xs text-ink-faint py-1">
            Nothing here yet. Anything said about this visit stays with it.
          </p>
        )}

        {messages.map(m => {
          const day = dayLabel(m.created_at)
          const showDay = day !== lastDay
          lastDay = day
          const mine = m.mine
          const system = m.author_kind === 'system'
          const mediaFor = (attachments || []).filter(a => a.messageId === m.id)

          if (system) {
            return (
              <div key={m.id}>
                {showDay && <DayDivider label={day} />}
                {/* A system line is CONTEXT, not somebody talking — so it is
                    centred, quiet, and carries no author bubble. It never rings
                    an unread badge either (lib/crewMessages.isAttentionWorthy). */}
                <p className="flex items-center justify-center gap-1.5 py-0.5 text-[10px] text-ink-faint">
                  <CalendarClock className="w-3 h-3 shrink-0" aria-hidden />
                  <span className="break-words">{m.body}</span>
                </p>
              </div>
            )
          }

          return (
            <div key={m.id}>
              {showDay && <DayDivider label={day} />}
              <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] min-w-0 rounded-lg border px-2.5 py-1.5',
                  mine ? 'border-accent/30 bg-accent/10' : 'border-border bg-bg-tertiary/60')}>
                  <p className="text-[10px] font-semibold text-ink-muted">
                    {m.author_name}
                    <span className="ml-1.5 font-normal text-ink-faint">{clockTime(m.created_at)}</span>
                  </p>
                  {/* break-words, not truncate: a worker's message is the payload,
                      and an ellipsis in the middle of a gate code is useless. */}
                  <p className="text-sm text-ink whitespace-pre-wrap break-words">{m.body}</p>
                  {mediaFor.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {mediaFor.map(a => <Attachment key={a.id} a={a} />)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {/* ── The outbox, in the thread ───────────────────────────────────── */}
        {pending.map(p => (
          <div key={p.key} className="flex justify-end">
            <div className={cn('max-w-[85%] min-w-0 rounded-lg border px-2.5 py-1.5',
              p.state === 'failed' ? 'border-red-500/50 bg-red-500/10' : 'border-border bg-bg-tertiary/40 opacity-70')}>
              <p className="text-sm text-ink whitespace-pre-wrap break-words">{p.body}</p>
              {p.state === 'sending' ? (
                <p className="mt-0.5 text-[10px] text-ink-faint flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Sending…
                </p>
              ) : (
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-red-300">{p.error || 'Didn’t send.'}</span>
                  <button type="button" onClick={() => onRetry(p.key)}
                    className="tap-target h-9 px-2.5 rounded-lg border border-red-500/40 text-[11px] font-semibold text-red-200 flex items-center gap-1">
                    <RotateCw className="w-3 h-3" aria-hidden /> Retry
                  </button>
                  <button type="button" onClick={() => onDiscard(p.key)} aria-label="Discard message"
                    className="tap-target h-9 px-2 rounded-lg border border-border text-[11px] text-ink-faint flex items-center">
                    <X className="w-3 h-3" aria-hidden />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* ── The composer ─────────────────────────────────────────────────── */}
      {disabledReason ? (
        <p className="text-[11px] text-amber-300">{disabledReason}</p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-end gap-1.5">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                // Enter sends on a keyboard; Shift+Enter makes a new line. On a
                // phone the on-screen Return key inserts a newline as usual —
                // this only fires for a real keypress with no modifier, and the
                // Send button is always there regardless.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault(); submit()
                }
              }}
              rows={2}
              aria-label="Message the crew"
              placeholder={placeholder || 'Message the crew…'}
              className="flex-1 min-w-0 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none"
            />
            <div className="flex flex-col gap-1.5">
              {onPickFiles && (
                <>
                  <input ref={fileRef} type="file" accept={attachAccept} hidden
                    onChange={e => { if (e.target.files?.length) onPickFiles(e.target.files); e.target.value = '' }} />
                  <button type="button" onClick={() => fileRef.current?.click()} aria-label="Attach a photo or video"
                    className="tap-target h-10 w-11 rounded-lg border border-border text-ink-muted flex items-center justify-center hover:text-ink hover:border-border-strong transition-colors">
                    <PaperclipIcon />
                  </button>
                </>
              )}
              <button type="button" onClick={submit} disabled={!canSend} aria-label="Send message"
                className="tap-target h-10 w-11 rounded-lg bg-accent text-black flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform">
                <Send className="w-4 h-4" aria-hidden />
              </button>
            </div>
          </div>
          {tooLong && (
            <p className="text-[10px] text-amber-300">
              {text.trim().length} characters — keep it under {MAX_MESSAGE_CHARS}.
            </p>
          )}
          {(uploads || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(uploads || []).map(u => (
                <span key={u.key}
                  className={cn('inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] max-w-full',
                    u.state === 'failed' ? 'border-red-500/50 text-red-300' : 'border-border text-ink-faint')}>
                  {u.state === 'uploading'
                    ? <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden />
                    : <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden />}
                  <span className="truncate max-w-[9rem]">{u.name}</span>
                  {u.state === 'failed' && onRetryUpload && (
                    <button type="button" onClick={() => onRetryUpload(u.key)} className="font-semibold underline underline-offset-2">Retry</button>
                  )}
                  {u.state === 'failed' && onDiscardUpload && (
                    <button type="button" onClick={() => onDiscardUpload(u.key)} aria-label="Discard attachment"><X className="w-3 h-3" aria-hidden /></button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <p className="text-center text-[10px] uppercase tracking-wide text-ink-faint py-1">{label}</p>
  )
}

/**
 * ⚠️ Width-bounded on purpose. A phone photo is 4032px wide and a card on a
 * 375px screen is not — an unbounded <img> pushes the whole conversation
 * sideways and takes the Send button off-screen with it.
 */
function Attachment({ a }: { a: MessageAttachment }) {
  if (!a.url) {
    return <span className="text-[10px] text-amber-300">An attachment wouldn’t open — reopen the conversation.</span>
  }
  if (a.kind === 'video') {
    return (
      <video src={a.url} controls playsInline preload="metadata"
        className="max-w-full w-40 max-h-40 rounded-lg border border-border bg-black object-contain" />
    )
  }
  return (
    // next/image cannot be used here: the src is a SHORT-LIVED SIGNED URL against
    // a private bucket, so the optimizer would cache a link that expires in five
    // minutes. Same reason CrewStopMedia and JobPhotos use a bare <img>.
    <a href={a.url} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={a.url} alt="Attachment" className="max-w-full w-24 h-24 rounded-lg border border-border object-cover" />
    </a>
  )
}

// lucide's Paperclip under a local name, so the import list above stays the set
// of icons this file actually reasons about.
function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" className="w-4 h-4" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}
