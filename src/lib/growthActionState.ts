// ── Which feedback a recommendation card shows while saves are in flight ─────
//
// The Growth page records "acted / dismissed / won" optimistically: the badge
// changes the instant the owner taps, and the save follows. Right for a tap
// that succeeds; a lie for one that does not. `recordRecommendation` answers
// `{ ok: false }` when the upsert is refused and throws when the connection
// drops, and the page used to ignore both — leaving "Won" on a card nothing was
// recorded for, and `busy` stuck forever after a throw.
//
// ⭐ ONE RULE, per recommendation key: the card shows the NEWEST attempt still
// in flight; when none is, the last state the SERVER ACKNOWLEDGED — the row that
// was loaded, or the most recently confirmed save. Attempts on different keys
// never touch each other. A failure is reported to the owner only when it was
// the newest attempt on its key; an older attempt that fails after a newer one
// was tapped is superseded and changes nothing. An older attempt that is
// acknowledged LATER than a newer one committed later on the server (each
// response follows its own commit), so the most recently acknowledged success is
// the truth, whatever the tap order was.
//
// Pure and synchronous, so the page handler stays thin and this rule can be
// proven offline with synthetic outcomes in any interleaving.

export type ActionOutcome = { ok: true } | { ok: false; error?: string }

interface Attempt<Row> { seq: number; row: Row }
interface KeyState<Row> { baseline: Row | undefined; latestSeq: number; inflight: Attempt<Row>[] }

export interface Settled<Row> {
  /** What the card must show now — set it, or delete the key when undefined. */
  display: Row | undefined
  /** The save did not happen. */
  failed: boolean
  /** A newer attempt on this key was tapped after this one; its answer owns the card. */
  superseded: boolean
}

export function createActionLedger<Row>() {
  const keys = new Map<string, KeyState<Row>>()
  let n = 0
  const shown = (k: KeyState<Row>): Row | undefined =>
    k.inflight.length ? k.inflight[k.inflight.length - 1].row : k.baseline

  return {
    /**
     * Register a tap. `current` is the row the card showed before it — on the
     * first tap of a key that is the loaded state, which becomes the fallback
     * until a save is acknowledged. Returns this attempt's sequence number.
     */
    begin(key: string, optimistic: Row, current: Row | undefined): number {
      const seq = ++n
      let k = keys.get(key)
      if (!k) { k = { baseline: current, latestSeq: 0, inflight: [] }; keys.set(key, k) }
      k.latestSeq = seq
      k.inflight.push({ seq, row: optimistic })
      return seq
    },
    /** Apply one attempt's answer. */
    settle(key: string, seq: number, outcome: ActionOutcome): Settled<Row> {
      const k = keys.get(key)
      if (!k) return { display: undefined, failed: !outcome.ok, superseded: false }
      const idx = k.inflight.findIndex(a => a.seq === seq)
      const attempt = idx >= 0 ? k.inflight[idx] : null
      if (idx >= 0) k.inflight.splice(idx, 1)
      if (outcome.ok && attempt) k.baseline = attempt.row
      return { display: shown(k), failed: !outcome.ok, superseded: seq < k.latestSeq }
    },
    /** What a key's card shows right now. */
    display(key: string): Row | undefined { const k = keys.get(key); return k ? shown(k) : undefined },
    /** Keys with at least one save still in flight — the cards to mark busy. */
    pendingKeys(): string[] { return [...keys].filter(([, k]) => k.inflight.length > 0).map(([key]) => key) },
  }
}

/** Set or delete one key in an immutable feedback map. */
export function withRow<Row>(map: Record<string, Row>, key: string, row: Row | undefined): Record<string, Row> {
  const next = { ...map }
  if (row === undefined) delete next[key]; else next[key] = row
  return next
}
