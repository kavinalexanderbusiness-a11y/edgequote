'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  loadOwnerConversation, postOwnerMessage, newClientToken, type CrewMessage,
} from '@/lib/crewMessages'
import { CREW_MEDIA_ACCEPT, uploadCrewMedia, signedMediaUrl, type CrewMedia } from '@/lib/crewMedia'
import { ConversationView, type MessageAttachment, type PendingMessage } from '@/components/conversation/ConversationView'

// ── The visit conversation, from the office ──────────────────────────────────
// The OWNER half of the door. Reads and writes crew_messages directly under the
// owner's own `auth.uid() = user_id` RLS — the same shape as the other ~300
// owner policies, and no route in front of it, because the DATABASE decides who
// the author is: crew_message_identity() overwrites author_kind/author_name from
// auth.uid() before the row lands, so this client cannot post as a crew member
// even though it can write the table.
//
// ⭐ THIS IS NOT "Message" — that button beside it texts the CUSTOMER through
// /api/comms/send, with consent gating, SMS segment cost and a send governor
// behind it. This one never leaves the business: it reaches the crew assigned to
// this visit, and no customer surface can select it (verify:scoped-notes pins
// crew_messages out of get_portal_data and both PDFs). Keeping the two visibly
// apart on the same card is the whole reason this component has its own label
// and its own icon.
//
// ⛔ Same honesty contract as the crew's phone: a message that has not been
// confirmed sits greyed in the thread, a failed one sits there in red with a
// Retry, and the retry reuses the same client token so a double tap cannot
// produce two messages.

interface OutboxEntry {
  key: string
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

export function VisitConversation({ jobId, onUnreadChange }: {
  jobId: string
  /** Lets the card's badge clear the moment the panel is opened, without a refetch. */
  onUnreadChange?: (jobId: string, n: number) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CrewMessage[]>([])
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [outbox, setOutbox] = useState<OutboxEntry[]>([])
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  const [staged, setStaged] = useState<File[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Signed URLs for this visit's message attachments. The bucket is private, so
  // this is the only way in — ⛔ never getPublicUrl, which would make the link
  // itself the permission for a video of somebody's side gate.
  const signAttachments = useCallback(async (uid: string) => {
    const { data } = await supabase.from('crew_media')
      .select('id, message_id, kind, mime, storage_path')
      .eq('user_id', uid).eq('job_id', jobId).not('message_id', 'is', null)
    const rows = (data || []) as Pick<CrewMedia, 'id' | 'message_id' | 'kind' | 'mime' | 'storage_path'>[]
    const signed = await Promise.all(rows.map(async r => ({
      id: r.id,
      messageId: r.message_id as string,
      kind: r.kind,
      mime: r.mime,
      url: await signedMediaUrl(supabase, r.storage_path),
    })))
    if (alive.current) setAttachments(signed)
  }, [supabase, jobId])

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null)
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setLoading(false); setLoadError('Sign in again to read this conversation.'); return }
    setOwnerId(uid)
    const res = await loadOwnerConversation(supabase, uid, jobId)
    if (!alive.current) return
    setLoading(false)
    // ⛔ A failed read is not an empty conversation. Rendering "nothing here
    // yet" on a failure invites the owner to repeat what the crew already said.
    if (res.error) { setLoadError('Couldn’t load the conversation.'); return }
    setMessages(res.messages)
    onUnreadChange?.(jobId, 0)   // loadOwnerConversation stamped the mark server-side
    if (res.messages.length) void signAttachments(uid)
  }, [supabase, jobId, onUnreadChange, signAttachments])

  useEffect(() => { void load() }, [load])

  async function uploadOne(entry: UploadEntry, uid: string) {
    setUploads(prev => prev.map(u => u.key === entry.key ? { ...u, state: 'uploading', error: undefined } : u))
    const res = await uploadCrewMedia(supabase, {
      userId: uid, jobId, file: entry.file, uploadedBy: uid, messageId: entry.messageId,
    })
    if (!alive.current) return
    if (res.media) {
      setUploads(prev => prev.filter(u => u.key !== entry.key))
      void signAttachments(uid)
      return
    }
    // The message landed; only the file did not. Two facts, kept apart.
    setUploads(prev => prev.map(u => u.key === entry.key
      ? { ...u, state: 'failed', error: res.error || 'The file didn’t attach.' } : u))
  }

  async function attempt(entry: OutboxEntry) {
    const uid = ownerId
    if (!uid) return
    setOutbox(prev => prev.map(o => o.key === entry.key ? { ...o, state: 'sending', error: undefined } : o))
    const res = await postOwnerMessage(supabase, uid, jobId, entry.body, entry.token)
    if (!alive.current) return
    if (res.message) {
      setOutbox(prev => prev.filter(o => o.key !== entry.key))
      const landed = res.message
      setMessages(prev => prev.some(m => m.id === landed.id) ? prev : [...prev, landed])
      for (const file of entry.files) {
        const u: UploadEntry = { key: `${landed.id}-${file.name}-${file.size}`, messageId: landed.id, file, state: 'uploading' }
        setUploads(prev => [...prev, u])
        void uploadOne(u, uid)
      }
      return
    }
    setOutbox(prev => prev.map(o => o.key === entry.key
      ? { ...o, state: 'failed', error: res.error || 'Your message didn’t send.' } : o))
  }

  const pending: PendingMessage[] = outbox.map(o => ({ key: o.key, body: o.body, state: o.state, error: o.error }))

  return (
    <ConversationView
      messages={messages}
      pending={pending}
      attachments={attachments}
      loading={loading}
      loadError={loadError}
      onReload={() => void load()}
      onSend={text => {
        const entry: OutboxEntry = {
          key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          token: newClientToken(), body: text, files: staged, state: 'sending',
        }
        setStaged([])
        setOutbox(prev => [...prev, entry])
        void attempt(entry)
      }}
      onRetry={key => { const e = outbox.find(o => o.key === key); if (e) void attempt(e) }}
      onDiscard={key => setOutbox(prev => prev.filter(o => o.key !== key))}
      placeholder="Message the crew on this visit…"
      onPickFiles={files => setStaged(prev => [...prev, ...Array.from(files)])}
      attachAccept={CREW_MEDIA_ACCEPT}
      uploads={[
        ...staged.map(f => ({ key: `staged-${f.name}-${f.size}`, name: `${f.name} — sends with your message`, state: 'uploading' as const })),
        ...uploads.map(u => ({ key: u.key, name: u.file.name, state: u.state, error: u.error })),
      ]}
      onRetryUpload={key => {
        const u = uploads.find(x => x.key === key)
        if (u && ownerId) void uploadOne(u, ownerId)
      }}
      onDiscardUpload={key => {
        setUploads(prev => prev.filter(x => x.key !== key))
        setStaged(prev => prev.filter(f => `staged-${f.name}-${f.size}` !== key))
      }}
    />
  )
}
