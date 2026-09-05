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
//   • A SERVER REFUSAL IS DEFINITE — and only the adapter can say so.
//     `{ ok: false, definite: true }` means the server answered with an HTTP
//     status and did not write; the card goes back to the last confirmed row and
//     the owner is told it was not recorded. ⛔ The mere presence of an error is
//     NOT that proof: postgrest-js resolves a dead connection as an error object
//     (`status: 0`), so `definite: false` arrives here and takes the ambiguous
//     path below exactly as a throw does.
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
//   • A REFRESH DOES NOT RESET IN-FLIGHT WORK, OR UNDO A LATER ONE. The server's
//     feedback becomes the confirmed baseline, in-flight cards keep their
//     optimistic badge, and a key confirmed AFTER the refresh began keeps its own
//     answer — the read started before that save landed, so its map predates it.
//     Callers pass `beginRefresh()` into `onRefreshed`.
//
//   • A NOTICE BELONGS TO ONE CARD. Failures are keyed, so tapping one card
//     cannot silently erase another card's unresolved error.
//
// The page owns React state; this owns the decisions, through five callbacks, so
// the SAME handler the page runs can be driven offline with delayed, refused,
// thrown and reconciled outcomes in every interleaving.

import type { FeedbackRow, OppKind } from './revenueIntelligence'

export type ActionStatus = 'acted' | 'dismissed' | 'won'
/**
 * `definite: true` means the server answered and did not write. `false` means the
 * request did not complete, so the outcome is unknown — postgrest-js resolves a
 * dead connection as an error object rather than throwing, so this cannot be
 * inferred from the error's presence. See recordRecommendation.
 */
export type SaveAnswer = { ok: true } | { ok: false; definite: boolean; error?: string }
export type ReadAnswer = { ok: true; row: FeedbackRow | null } | { ok: false; error?: string }

export interface ActionTarget { key: string; kind: OppKind; customerId: string; customerName: string; expectedValue: number }

export interface ActionNotice {
  /** Which card this is about. A notice belongs to one key; tapping another card must not clear it. */
  key: string
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
  /** Set or clear the notice for ONE key. Tapping a card must not erase another card's unresolved error. */
  setNotice: (key: string, notice: ActionNotice | null) => void
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
  /** When each key was last confirmed, so a refresh that began earlier cannot undo it. */
  const confirmedAt = new Map<string, number>()
  let clock = 0
  const confirm = (key: string, row: FeedbackRow | undefined) => {
    if (row) confirmed.set(key, row); else confirmed.delete(key)
    confirmedAt.set(key, ++clock)
  }
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
      confirm(o.key, row)
      inflight.delete(o.key); publishBusy()
      deps.setRow(o.key, row)
      return
    }
    if (answer !== 'thrown' && answer.definite) {
      // The server answered and refused: nothing was written. Definite.
      inflight.delete(o.key); publishBusy()
      deps.setRow(o.key, confirmed.get(o.key))
      deps.setNotice(o.key, { key: o.key, tone: 'refused', text: `Couldn't save ${label} — it was not recorded. Check your connection and tap it again.` })
      return
    }
    // The request threw. It may have committed. Read the row back before saying anything.
    let readBack: ReadAnswer
    try { readBack = await deps.read(o.key) } catch { readBack = { ok: false } }
    inflight.delete(o.key); publishBusy()
    if (readBack.ok) {
      const onRecord = readBack.row ?? undefined
      confirm(o.key, onRecord)
      deps.setRow(o.key, onRecord)
      if (onRecord?.status === status) return          // it did save; the badge already says so
      // ⚠️ OBSERVED STATE, NOT A VERDICT. The read-back is one look at one moment;
      // a write the wire lost can still land after it. So this says what was seen
      // and when, and never that the save did not happen. Re-tapping is safe
      // either way — the writer upserts on the same key, so a late arrival is
      // replaced, not duplicated.
      deps.setNotice(o.key, { key: o.key, tone: 'reconciled', text: `The connection dropped while saving ${label} — as of this check it is not on record. Tap it again if you still want it.` })
      return
    }
    deps.setRow(o.key, confirmed.get(o.key))
    deps.setNotice(o.key, { key: o.key, tone: 'unconfirmed', text: `The connection dropped while saving ${label} — it may or may not have been recorded. Refresh to check before tapping again.` })
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
      deps.setNotice(o.key, null)
      deps.setRow(o.key, row)
      void run(o, status, row)
      return true
    },
    /**
     * The page loaded or refreshed the server's feedback. It is the confirmed
     * baseline for every key now; keys with a save in flight keep showing their
     * optimistic row until that save settles on its own answer.
     */
    onRefreshed(feedback: Record<string, FeedbackRow>, since = Infinity): void {
      // ⛔ A READ THAT BEGAN EARLIER CANNOT UNDO A LATER CONFIRMATION. `since` is
      // the clock when this refresh STARTED; any key confirmed after it settled
      // while the read was already in flight, so the server map predates that
      // answer and must not overwrite the card. Default Infinity = no key is
      // newer, i.e. the previous behaviour.
      const kept = new Map([...confirmedAt]
        .filter(([, at]) => at > since)
        .map(([k]) => [k, confirmed.get(k)] as const))
      confirmed.clear()
      for (const [k, v] of Object.entries(feedback)) confirmed.set(k, v)
      for (const [k, row] of kept) {
        if (row) confirmed.set(k, row); else confirmed.delete(k)
        if (!inflight.has(k)) deps.setRow(k, row)
      }
      for (const [k, row] of inflight) deps.setRow(k, row)
    },
    /** The clock at the moment a refresh starts; hand it back to onRefreshed. */
    beginRefresh(): number { return clock },
    /** For tests and the busy indicator: keys with a save in flight. */
    pending(): string[] { return [...inflight.keys()] },
  }
}
