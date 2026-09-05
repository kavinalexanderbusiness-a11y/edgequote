// ── The Growth card action handler: optimistic, latched, honest about the wire ──
//
// A tap on "Take action / Dismiss / Mark won" changes the badge at once and the
// save follows. What this module guarantees about that:
//
//   • ONE SAVE IN FLIGHT PER CARD. A synchronous latch refuses a second tap on
//     the same recommendation while its save is pending (`act` returns false and
//     issues no request). Different recommendations save concurrently. So there
//     is never an ordering question between two saves of one key — the previous
//     design tried to infer commit order from response order, and could not:
//     a response sent after a commit can be delayed in transport past a later
//     commit's response.
//
//   • A SERVER REFUSAL IS DEFINITE. `{ ok: false }` means the server answered
//     and did not write; the card goes back to the last confirmed row and the
//     owner is told it was not recorded.
//
//   • A THROWN REQUEST IS AMBIGUOUS. A connection error after the request left
//     the device does not prove the upsert did not commit — the response may
//     have been lost after the write. So nothing is asserted: the row is READ
//     back. If the read shows the save, the badge stands with no fuss; if it
//     shows otherwise, the card takes what is on record and says so; if the read
//     fails too, the card shows the last confirmed state and the owner is told
//     the save is unconfirmed and to refresh before tapping again. "Nothing was
//     recorded" is never said about a throw.
//
//   • A REFRESH DOES NOT RESET IN-FLIGHT WORK. When the page reloads the server's
//     feedback, that map becomes the confirmed baseline for every card, in-flight
//     cards keep their optimistic badge until their own save settles, and a
//     settlement only ever writes the answer it received (or read) for its own
//     key — never an older baseline over fresher data.
//
// The page owns React state; this owns the decisions, through five callbacks, so
// the SAME handler the page runs can be driven offline with delayed, refused,
// thrown and reconciled outcomes in every interleaving.

import type { FeedbackRow, OppKind } from './revenueIntelligence'

export type ActionStatus = 'acted' | 'dismissed' | 'won'
export type SaveAnswer = { ok: true } | { ok: false; error?: string }
export type ReadAnswer = { ok: true; row: FeedbackRow | null } | { ok: false; error?: string }

export interface ActionTarget { key: string; kind: OppKind; customerId: string; customerName: string; expectedValue: number }

export interface ActionNotice {
  /** refused: the server said no · unconfirmed: the wire dropped and the read-back failed too · reconciled: the wire dropped, the read-back shows it is not on record */
  tone: 'refused' | 'unconfirmed' | 'reconciled'
  text: string
}

export interface ActionDeps {
  record: (o: ActionTarget, status: ActionStatus, resultValue?: number) => Promise<SaveAnswer>
  read: (key: string) => Promise<ReadAnswer>
  /** Show `row` for `key`, or remove the key when undefined. */
  setRow: (key: string, row: FeedbackRow | undefined) => void
  setBusy: (keys: ReadonlySet<string>) => void
  setNotice: (notice: ActionNotice | null) => void
}

/** The button the owner tapped, named back to them. */
export const ACTION_LABEL: Record<ActionStatus, string> = { acted: 'Take action', dismissed: 'Dismiss', won: 'Mark won' }

/** Set or delete one key in an immutable feedback map. */
export function withRow<Row>(map: Record<string, Row>, key: string, row: Row | undefined): Record<string, Row> {
  const next = { ...map }
  if (row === undefined) delete next[key]; else next[key] = row
  return next
}

export function createActionController(deps: ActionDeps, initialFeedback: Record<string, FeedbackRow> = {}) {
  /** The last row the server is KNOWN to hold per key (loaded, refreshed, confirmed, or read back). */
  const confirmed = new Map<string, FeedbackRow>(Object.entries(initialFeedback))
  /** At most one per key — the latch. */
  const inflight = new Map<string, FeedbackRow>()
  const publishBusy = () => deps.setBusy(new Set(inflight.keys()))

  async function run(o: ActionTarget, status: ActionStatus, row: FeedbackRow): Promise<void> {
    let answer: SaveAnswer | 'thrown'
    try {
      answer = await deps.record(o, status, status === 'won' ? o.expectedValue : undefined)
    } catch {
      answer = 'thrown'
    }
    const label = `"${ACTION_LABEL[status]}" for ${o.customerName}`

    if (answer !== 'thrown' && answer.ok) {
      confirmed.set(o.key, row)
      inflight.delete(o.key); publishBusy()
      deps.setRow(o.key, row)
      return
    }
    if (answer !== 'thrown') {
      // The server answered and refused: nothing was written. Definite.
      inflight.delete(o.key); publishBusy()
      deps.setRow(o.key, confirmed.get(o.key))
      deps.setNotice({ tone: 'refused', text: `Couldn't save ${label} — it was not recorded. Check your connection and tap it again.` })
      return
    }
    // The request threw. It may have committed. Read the row back before saying anything.
    let readBack: ReadAnswer
    try { readBack = await deps.read(o.key) } catch { readBack = { ok: false } }
    inflight.delete(o.key); publishBusy()
    if (readBack.ok) {
      const onRecord = readBack.row ?? undefined
      if (onRecord) confirmed.set(o.key, onRecord); else confirmed.delete(o.key)
      deps.setRow(o.key, onRecord)
      if (onRecord?.status === status) return          // it did save; the badge already says so
      deps.setNotice({ tone: 'reconciled', text: `The connection dropped while saving ${label} — it isn't on record. Tap it again if you still want it.` })
      return
    }
    deps.setRow(o.key, confirmed.get(o.key))
    deps.setNotice({ tone: 'unconfirmed', text: `The connection dropped while saving ${label} — it may or may not have been recorded. Refresh to check before tapping again.` })
  }

  return {
    /**
     * Tap. Returns false — and issues no request — when this key already has a
     * save in flight. Synchronous, so two calls in one tick cannot both pass.
     */
    act(o: ActionTarget, status: ActionStatus): boolean {
      if (inflight.has(o.key)) return false
      const row: FeedbackRow = { opportunity_key: o.key, kind: o.kind, status, expected_value: o.expectedValue, result_value: status === 'won' ? o.expectedValue : null }
      inflight.set(o.key, row); publishBusy()
      deps.setNotice(null)
      deps.setRow(o.key, row)
      void run(o, status, row)
      return true
    },
    /**
     * The page loaded or refreshed the server's feedback. It is the confirmed
     * baseline for every key now; keys with a save in flight keep showing their
     * optimistic row until that save settles on its own answer.
     */
    onRefreshed(feedback: Record<string, FeedbackRow>): void {
      confirmed.clear()
      for (const [k, v] of Object.entries(feedback)) confirmed.set(k, v)
      for (const [k, row] of inflight) deps.setRow(k, row)
    },
    /** For tests and the busy indicator: keys with a save in flight. */
    pending(): string[] { return [...inflight.keys()] },
  }
}
