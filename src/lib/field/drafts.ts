// ── Text a worker typed, kept until it lands ─────────────────────────────────
// ⭐⭐ THE RULE: never erase what a person wrote because a request failed.
//
// A worker standing in the rain types four sentences about a broken sprinkler
// head, taps Save, and the request dies. The old behaviour left the text in the
// component — which is fine until the phone locks, the tab is evicted, or they
// switch to the camera and come back. Then it is gone, and the only copy of that
// observation was in their head an hour ago.
//
// So a draft is written to disk BEFORE the request goes out, and removed only
// when the server has confirmed. Crash, reload, app-kill, or a walk out of
// coverage all resume with the words still there.
//
// ⭐ localStorage, not IndexedDB, on purpose. A draft is a few hundred bytes and
// the write must be DURABLE AT THE MOMENT OF TYPING — localStorage commits
// synchronously, so there is no window between "the worker typed it" and "the
// bytes are safe" for a killed tab to fall into. IndexedDB's async commit is the
// right tool for photo blobs and queued intents; here it would add the exact gap
// the file exists to close. (photoStore's header pays for the async version of
// this lesson.)
//
// ⛔ NOT A SYNC QUEUE. A draft is unsent text, nothing more. It never replays
// itself, it never resends on a timer, and it never decides on the worker's
// behalf that the words are still wanted — "do not silently resend forever" is
// the requirement. The surface offers Retry and Discard; a human picks.

const PREFIX = 'eq-field-draft'

export type DraftField = 'completion_summary' | 'completion_issue' | 'message'

export interface FieldDraft {
  text: string
  /** When it was last typed — so a surface can say "saved 10 minutes ago" and a
   *  sweep can retire drafts nobody is coming back for. */
  savedAt: number
}

// ⭐ Keyed by AUTH USER as well as by record, so a shared phone cannot show one
// worker the words another worker typed. Same rule as the day cache.
function keyFor(userId: string, jobId: string, field: DraftField): string {
  return `${PREFIX}:${userId}:${jobId}:${field}`
}

function available(): boolean {
  try { return typeof window !== 'undefined' && !!window.localStorage } catch { return false }
}

/**
 * Keep what they typed. Writing an EMPTY string clears the draft rather than
 * storing a blank one — an emptied box is not a draft, and leaving one behind
 * would repopulate a field the worker deliberately cleared.
 *
 * Best-effort: a full or blocked store must never stop the save from being
 * attempted. It returns whether the words are actually safe, so a caller can
 * decline to promise something it did not get (putPending's rule).
 */
export function saveDraft(userId: string, jobId: string, field: DraftField, text: string): boolean {
  if (!available() || !userId) return false
  try {
    if (!text) { window.localStorage.removeItem(keyFor(userId, jobId, field)); return true }
    const rec: FieldDraft = { text, savedAt: Date.now() }
    window.localStorage.setItem(keyFor(userId, jobId, field), JSON.stringify(rec))
    return true
  } catch { return false }
}

export function readDraft(userId: string, jobId: string, field: DraftField): FieldDraft | null {
  if (!available() || !userId) return null
  try {
    const raw = window.localStorage.getItem(keyFor(userId, jobId, field))
    if (!raw) return null
    const rec = JSON.parse(raw) as FieldDraft
    return typeof rec?.text === 'string' ? rec : null
  } catch { return null }
}

/** ⛔ Called ONLY when the server has confirmed the write, or when a human taps
 *  Discard. Never on a failure, and never on a timer. */
export function clearDraft(userId: string, jobId: string, field: DraftField): void {
  if (!available()) return
  try { window.localStorage.removeItem(keyFor(userId, jobId, field)) } catch { /* ignore */ }
}

/** Everything this device is holding for this worker — so a surface can say
 *  "2 unsent notes" instead of the worker discovering them one card at a time. */
export function listDrafts(userId: string): { jobId: string; field: DraftField; draft: FieldDraft }[] {
  if (!available() || !userId) return []
  const out: { jobId: string; field: DraftField; draft: FieldDraft }[] = []
  try {
    const head = `${PREFIX}:${userId}:`
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (!k || !k.startsWith(head)) continue
      const rest = k.slice(head.length)
      const cut = rest.lastIndexOf(':')
      if (cut < 0) continue
      const jobId = rest.slice(0, cut)
      const field = rest.slice(cut + 1) as DraftField
      const raw = window.localStorage.getItem(k)
      if (!raw) continue
      try {
        const draft = JSON.parse(raw) as FieldDraft
        if (typeof draft?.text === 'string') out.push({ jobId, field, draft })
      } catch { /* skip a corrupt entry rather than failing the list */ }
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.draft.savedAt - b.draft.savedAt)
}

/** Sign-out, and only sign-out. Drops every draft on this device — for ALL
 *  users, because a device changing hands is precisely when this matters and we
 *  cannot know who is next. */
export function clearAllDrafts(): void {
  if (!available()) return
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(`${PREFIX}:`)) doomed.push(k)
    }
    doomed.forEach(k => { try { window.localStorage.removeItem(k) } catch { /* ignore */ } })
  } catch { /* ignore */ }
}
