import type { SupabaseClient } from '@supabase/supabase-js'

// ── The conversation attached to a visit ─────────────────────────────────────
// Owner/admin ↔ the crew assigned to one visit. Short, linear, and permanently
// attached to the work it is about.
//
// ⭐⭐ NOTE vs MESSAGE — the distinction this whole feature turns on, and the
// reason it is not a second notes system.
//
//   jobs.notes (Session 35) is a STANDING FACT.  "Gate code 1942."
//     Edited in place, always current, authorless — the answer is the same
//     whoever wrote it. Read once, BEFORE you pull into the driveway.
//   crew_messages (here) is an UTTERANCE AT A MOMENT.  "Running 20 min late."
//     Appended, never edited, always attributed — WHO said it and WHEN is most
//     of the meaning. Read as a sequence.
//
// The test when a new field could be either: **can it be answered correctly
// without knowing who said it?** Yes → it is a note. No → it is a message.
// Collapsing them breaks both directions: a gate code buried under twenty
// replies is lost to the next crew, and a note appended with "…and now 1943"
// makes a worker read history to find the truth.
//
// ⭐ THE TABLE IS THE AUDIENCE (the crew_media precedent). There is no
// `visibility` column and there must never be one — see lib/noteScope for why
// this codebase decides audience by column/table and not by a flag. Everything
// here is internal: the business and the assigned crew. No customer surface
// selects it, at any point, including after completion.
//
// ⭐ TWO DOORS, ONE AUTHORIZATION EACH — the shape Crew Mode already uses:
//   OWNER → the table directly, under `auth.uid() = user_id` RLS, exactly like
//           the other ~300 owner policies. The insert's WITH CHECK also proves
//           the VISIT belongs to the same business, so a message cannot be
//           attached across a tenant boundary even by its own author.
//   CREW  → crew_job_messages / crew_post_message / crew_message_inbox. A crew
//           session holds NO table grants (RLS is row-level; granting the row
//           would grant jobs.price with it), so these DEFINER RPCs are the only
//           way in, and each re-proves employer + crew assignment.
//
// ⛔ Never add a `.from('crew_messages')` call to a crew screen. verify:crew-access
// fails the build if you do, and it would not work anyway.

import type { NoteAudience } from '@/lib/noteScope'

/** ⭐ The whole table is one audience. A per-row switch here would be a control
 *  whose only possible use is to leak a conversation to the customer it is about. */
export const CREW_MESSAGE_AUDIENCE: NoteAudience = 'crew'

/** Matches the `crew_messages_body_length` CHECK. The database is the ceiling;
 *  this is so the composer can say so before the round trip. */
export const MAX_MESSAGE_CHARS = 2000

export type MessageAuthorKind = 'owner' | 'crew' | 'system'

export interface CrewMessage {
  id: string
  body: string
  author_kind: MessageAuthorKind
  author_name: string
  author_technician_id: string | null
  /** NULL when a person said it; names the system event otherwise. */
  event_type: string | null
  /** Did the reader asking write this? Answered by the server, so no client has
   *  to compare auth uids it should not be handling in the first place. */
  mine: boolean
  created_at: string
}

export interface CrewConversation {
  job_id: string
  title: string
  customer_name: string | null
  scheduled_date: string | null
  status: string | null
  messages: CrewMessage[]
}

export interface CrewInboxItem {
  job_id: string
  title: string
  customer_name: string | null
  scheduled_date: string | null
  status: string | null
  unread: number
  last_at: string
  last_author: string
  last_body: string
}

// ── Results: THREE outcomes, never two ───────────────────────────────────────
// The rule lib/crewAccess had to learn the hard way, and it applies identically
// here: supabase-js RESOLVES with `{ error }` on a dead connection rather than
// throwing, so "we could not ask" and "the server said no" arrive on different
// fields of the same object.
//   error  → couldn't ask. Keep what is on screen, offer Retry.
//   null   → the database ANSWERED: you are not an active crew member. That is
//            revocation, and the only time an access message may appear.
//   ok     → the truth.
// Folding error into revoked is how a worker in a dead zone gets told they were
// fired; folding it into ok is how a failed send looks like a sent one.
export type ConversationResult =
  | { kind: 'ok'; conversation: CrewConversation }
  | { kind: 'revoked' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

export type InboxResult =
  | { kind: 'ok'; items: CrewInboxItem[] }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string }

export type PostResult =
  | { kind: 'ok'; message: CrewMessage }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string }

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * ⭐ THE DOUBLE-TAP GUARD, MINTED ONCE PER ATTEMPT-SERIES — not per attempt.
 * The caller creates this when the person hits Send and reuses the SAME value
 * for every retry of that one message. The unique index on
 * (job_id, created_by, client_token) then makes a replay return the row that
 * already landed instead of writing a second one, so a double tap, an impatient
 * retry, and a request that succeeded on the server but died on the way back are
 * all indistinguishable from a single successful send — which is the point.
 *
 * ⛔ Do NOT generate this inside the send function: a retry would mint a fresh
 * token and the guard would be a no-op, which is exactly the bug it exists to
 * prevent.
 */
export function newClientToken(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** What the composer will accept, and why it will not. Returned rather than
 *  thrown so the button can be disabled with a reason on screen. */
export function messageProblem(body: string): string | null {
  const t = body.trim()
  if (!t) return 'Type a message first.'
  if (t.length > MAX_MESSAGE_CHARS) return `That's ${t.length} characters — the limit is ${MAX_MESSAGE_CHARS}.`
  return null
}

/**
 * Unread, DERIVED — never a stored counter that can drift out of step with the
 * messages it counts.
 *
 * ⭐ THE RULE, AND IT IS ONE RULE: **a person's words are unread; a system line
 * is context.** So a message counts if it arrived after my high-water mark, I
 * did not write it, and a PERSON wrote it.
 *
 * Why system events are excluded rather than attributed to nobody-and-therefore-
 * everybody: the owner who reschedules a visit from the day board would
 * otherwise watch that same board grow a "1 new" badge announcing their own
 * action back to them, which reads as a bug. And a reschedule is not news to the
 * crew either — their Today and Week boards are server truth and already show
 * it. The system line exists so the TRANSCRIPT stays honest ("we'll be there
 * Tuesday" followed by the move), not to demand anyone's attention. Something
 * that appears in a thread and something that pulls someone into a thread are
 * different jobs.
 */
export function isAttentionWorthy(m: CrewMessage): boolean {
  return !m.mine && m.author_kind !== 'system'
}

export function unreadCount(messages: CrewMessage[], lastReadAt: string | null): number {
  const mark = lastReadAt ? Date.parse(lastReadAt) : Number.NEGATIVE_INFINITY
  return messages.filter(m => isAttentionWorthy(m) && Date.parse(m.created_at) > mark).length
}

/** "3 new" / "1 new" / "" — one phrasing, so every surface says it the same way. */
export function unreadLabel(n: number): string {
  return n > 0 ? `${n} new` : ''
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CREW DOOR — RPCs only. No table names appear below this line.
// ─────────────────────────────────────────────────────────────────────────────

export async function loadCrewConversation(
  supabase: SupabaseClient, jobId: string,
): Promise<ConversationResult> {
  const { data, error } = await supabase.rpc('crew_job_messages', { p_job_id: jobId })
  if (error) return { kind: 'error', message: error.message }
  if (!data) return { kind: 'revoked' }
  const d = data as { ok: boolean; reason?: string } & CrewConversation
  // The visit is not this crew's work. Deliberately its own outcome: it is not
  // an error (nothing failed) and not revocation (their access is fine).
  if (!d.ok) return { kind: 'denied' }
  return {
    kind: 'ok',
    conversation: {
      job_id: d.job_id,
      title: d.title,
      customer_name: d.customer_name ?? null,
      scheduled_date: d.scheduled_date ?? null,
      status: d.status ?? null,
      messages: (d.messages || []) as CrewMessage[],
    },
  }
}

/**
 * ⛔ NEVER REPORTS A SEND IT DID NOT GET. Every failing branch returns an error
 * result; the caller keeps the typed text in hand and offers Retry with the same
 * token. There is no branch here that optimistically assumes success.
 */
export async function postCrewMessage(
  supabase: SupabaseClient, jobId: string, body: string, clientToken: string,
): Promise<PostResult> {
  const { data, error } = await supabase.rpc('crew_post_message', {
    p_job_id: jobId, p_body: body, p_client_token: clientToken,
  })
  if (error) return { kind: 'error', message: 'Your message didn’t send — check your signal and retry.' }
  if (!data) return { kind: 'revoked' }
  const d = data as { ok: boolean; reason?: string; message?: CrewMessage }
  if (!d.ok || !d.message) {
    const why = d.reason === 'not_found' ? 'That visit isn’t on your board.'
      : d.reason === 'too_long' ? `Too long — keep it under ${MAX_MESSAGE_CHARS} characters.`
      : d.reason === 'empty' ? 'Type a message first.'
      : 'Your message didn’t send — try again.'
    return { kind: 'error', message: why }
  }
  return { kind: 'ok', message: d.message }
}

export async function loadCrewInbox(supabase: SupabaseClient): Promise<InboxResult> {
  const { data, error } = await supabase.rpc('crew_message_inbox')
  if (error) return { kind: 'error', message: error.message }
  if (!data) return { kind: 'revoked' }
  return { kind: 'ok', items: (data as CrewInboxItem[]) || [] }
}

// ── The crew's shared inbox feed ─────────────────────────────────────────────
// ⭐ ONE fetch and ONE refresh loop, however many components want the number.
// The nav badge and the per-stop counts on Today are the same fact, and the
// NotificationBell already paid for the lesson that two components each running
// their own effect against the same source is a bug waiting to happen (there,
// the second bell's realtime binding threw and its badge was dead all session).
//
// ⭐ NO REALTIME, DELIBERATELY — and this is not an oversight to "fix". A crew
// session has no table grants, and Supabase realtime requires an RLS SELECT to
// deliver a row. Re-asking the RPC IS the crew liveness mechanism here, exactly
// as CrewToday re-asks crew_day: on mount, when the tab becomes visible, when
// the network returns, and on a slow tick.
const REFRESH_MS = 60_000

let inboxItems: CrewInboxItem[] = []
let inboxState: 'idle' | 'ok' | 'revoked' | 'error' = 'idle'
let listeners = new Set<() => void>()
let refs = 0
let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<void> | null = null
const EMPTY: CrewInboxItem[] = []

function emit() { for (const l of Array.from(listeners)) l() }

export function subscribeCrewInbox(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function getCrewInboxSnapshot(): CrewInboxItem[] { return inboxItems }
export function getCrewInboxServerSnapshot(): CrewInboxItem[] { return EMPTY }
export function getCrewInboxState(): 'idle' | 'ok' | 'revoked' | 'error' { return inboxState }

/** Total unread across every conversation — the number on the nav tab. */
export function totalUnread(items: CrewInboxItem[]): number {
  return items.reduce((n, i) => n + (i.unread || 0), 0)
}

export async function refreshCrewInbox(supabase: SupabaseClient): Promise<void> {
  // Collapse concurrent asks: a tab becoming visible while the tick fires must
  // not produce two round trips from a phone on a tether.
  if (inflight) return inflight
  inflight = (async () => {
    const res = await loadCrewInbox(supabase)
    if (res.kind === 'ok') { inboxItems = res.items; inboxState = 'ok' }
    // ⛔ A failed refresh keeps the last known list. Blanking it would tell a
    // worker in a dead zone that their messages are gone.
    else if (res.kind === 'revoked') { inboxItems = []; inboxState = 'revoked' }
    else inboxState = 'error'
    emit()
  })().finally(() => { inflight = null })
  return inflight
}

/** Ref-counted lifecycle: the first subscriber starts the loop, the last stops
 *  it. Returns the teardown the effect should call. */
export function startCrewInboxFeed(supabase: SupabaseClient): () => void {
  refs++
  const wake = () => { if (document.visibilityState === 'visible') void refreshCrewInbox(supabase) }
  if (refs === 1) {
    void refreshCrewInbox(supabase)
    timer = setInterval(wake, REFRESH_MS)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
  }
  return () => {
    refs--
    if (refs <= 0) {
      if (timer) { clearInterval(timer); timer = null }
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      refs = 0
    }
  }
}

/** Locally zero a conversation the moment it is opened, so the badge agrees with
 *  the screen before the next refresh lands. The server has already stamped the
 *  high-water mark inside crew_job_messages — this is the echo, not the record. */
export function markInboxRead(jobId: string): void {
  let changed = false
  inboxItems = inboxItems.map(i => {
    if (i.job_id !== jobId || !i.unread) return i
    changed = true
    return { ...i, unread: 0 }
  })
  if (changed) emit()
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OWNER DOOR — the table directly, under the owner's own RLS.
// ⛔ Nothing below this line may be imported by a crew screen: a crew session has
//    no grants on these tables, so it would return an empty list rather than an
//    honest error. verify:crew-access and verify:crew-messages both pin it.
// ─────────────────────────────────────────────────────────────────────────────

interface OwnerMessageRow {
  id: string
  body: string
  author_kind: MessageAuthorKind
  author_name: string
  author_technician_id: string | null
  event_type: string | null
  created_by: string | null
  created_at: string
}

const toMessage = (r: OwnerMessageRow, uid: string): CrewMessage => ({
  id: r.id,
  body: r.body,
  author_kind: r.author_kind,
  author_name: r.author_name,
  author_technician_id: r.author_technician_id,
  event_type: r.event_type,
  mine: r.created_by === uid,
  created_at: r.created_at,
})

/**
 * One visit's conversation, as the owner. Reads then stamps the high-water mark
 * from the NEWEST MESSAGE RETURNED — never now() — so a message that lands a
 * millisecond after this snapshot still counts as unread. (The crew RPC takes
 * the mark the same way, for the same reason.)
 */
export async function loadOwnerConversation(
  supabase: SupabaseClient, ownerId: string, jobId: string,
): Promise<{ messages: CrewMessage[]; error: boolean }> {
  const { data, error } = await supabase.from('crew_messages')
    .select('id, body, author_kind, author_name, author_technician_id, event_type, created_by, created_at')
    .eq('user_id', ownerId).eq('job_id', jobId)
    .order('created_at', { ascending: true })
  // An empty conversation and a failed read are different facts and must not
  // collapse: "nobody has said anything" is a statement about the visit.
  if (error) return { messages: [], error: true }
  const messages = ((data || []) as OwnerMessageRow[]).map(r => toMessage(r, ownerId))
  const newest = messages.length ? messages[messages.length - 1].created_at : null
  if (newest) await markOwnerRead(supabase, ownerId, jobId, newest)
  return { messages, error: false }
}

export async function markOwnerRead(
  supabase: SupabaseClient, ownerId: string, jobId: string, at: string,
): Promise<void> {
  // Upsert on the (job, reader) key. A failure here is not worth telling anyone
  // about — the worst case is a badge that reappears on the next load.
  await supabase.from('crew_message_reads')
    .upsert({ user_id: ownerId, job_id: jobId, reader_id: ownerId, last_read_at: at },
      { onConflict: 'job_id,reader_id' })
}

/**
 * ⛔ Returns an error string on every failing path. The caller keeps the text in
 * the box. `clientToken` is minted ONCE by the caller and reused on retry, so a
 * double tap cannot produce two messages — the partial unique index answers the
 * replay with the row that already landed.
 */
export async function postOwnerMessage(
  supabase: SupabaseClient, ownerId: string, jobId: string, body: string, clientToken: string,
): Promise<{ message?: CrewMessage; error?: string }> {
  const problem = messageProblem(body)
  if (problem) return { error: problem }
  const { data, error } = await supabase.from('crew_messages')
    .insert({
      user_id: ownerId, job_id: jobId, body: body.trim(), client_token: clientToken,
      // Placeholders only — crew_message_identity() overwrites both from
      // auth.uid() before the row lands. They are here because the columns are
      // NOT NULL, not because the client gets a say in who it is.
      author_kind: 'owner', author_name: 'Office',
    })
    .select('id, body, author_kind, author_name, author_technician_id, event_type, created_by, created_at')
    .maybeSingle()

  if (error) {
    // 23505 = the replay guard fired: this exact send already landed. Fetch what
    // is there and report success, because the caller's request ("let this
    // message exist") is satisfied — reporting a failure would invite a second
    // tap that creates the duplicate this index just prevented.
    if (error.code === '23505') {
      const { data: existing } = await supabase.from('crew_messages')
        .select('id, body, author_kind, author_name, author_technician_id, event_type, created_by, created_at')
        .eq('user_id', ownerId).eq('job_id', jobId).eq('client_token', clientToken)
        .maybeSingle()
      if (existing) return { message: toMessage(existing as OwnerMessageRow, ownerId) }
    }
    return { error: 'Your message didn’t send — try again.' }
  }
  if (!data) return { error: 'Your message didn’t send — try again.' }
  return { message: toMessage(data as OwnerMessageRow, ownerId) }
}

/**
 * Per-visit unread for a whole day's board, in two queries rather than one per
 * stop. Used by the schedule day panel so a card can carry "2 new" without the
 * owner opening every visit to find out.
 */
export async function loadOwnerUnread(
  supabase: SupabaseClient, ownerId: string, jobIds: string[],
): Promise<Record<string, number>> {
  if (!jobIds.length) return {}
  const [msgs, reads] = await Promise.all([
    supabase.from('crew_messages').select('job_id, created_by, author_kind, created_at')
      .eq('user_id', ownerId).in('job_id', jobIds),
    supabase.from('crew_message_reads').select('job_id, last_read_at')
      .eq('reader_id', ownerId).in('job_id', jobIds),
  ])
  if (msgs.error) return {}
  const mark: Record<string, number> = {}
  for (const r of (reads.data || []) as { job_id: string; last_read_at: string }[]) {
    mark[r.job_id] = Date.parse(r.last_read_at)
  }
  const out: Record<string, number> = {}
  for (const m of (msgs.data || []) as { job_id: string; created_by: string | null; author_kind: MessageAuthorKind; created_at: string }[]) {
    // ⭐ The SAME derivation as unreadCount and as crew_message_inbox's SQL, and
    // all three must stay the same sentence: a person's words are unread, a
    // system line is context. Three answers to "what is unread" is three badges
    // that disagree on one screen.
    if (m.created_by === ownerId || m.author_kind === 'system') continue
    if (Date.parse(m.created_at) <= (mark[m.job_id] ?? Number.NEGATIVE_INFINITY)) continue
    out[m.job_id] = (out[m.job_id] || 0) + 1
  }
  return out
}
