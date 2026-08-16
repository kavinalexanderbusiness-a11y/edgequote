import type { CrewDaySnapshot } from '@/lib/crewBrief'

// ── Where "what I last acknowledged" lives ───────────────────────────────────
//
// ⭐ ON THE DEVICE, ON PURPOSE. "Since I last looked" is a fact about a PHONE,
// not about an account: a worker who read the board on their handset at 7am has
// not read anything on the tablet in the truck. A server column would also mean
// a migration, an RPC and a write on every glance — for a signal whose entire
// job is to be cheap and local.
//
// ⭐ THE FAILURE MODE IS SILENCE, NEVER NOISE. Every read here can fail —
// storage disabled in private browsing, a quota-full phone, JSON a previous
// version wrote. Each failure returns null, which lib/crewBrief turns into NO
// CHANGE CLAIMS (its honesty rule 1). The alternative — treating an unreadable
// baseline as an empty one — would announce every stop on the day as new, which
// is precisely the false alarm that makes a worker stop reading the banner.
//
// ⚠️ Storage is NOT a security boundary and holds nothing that would matter if
// read: names and hours the worker is already looking at, and a hash of the
// instructions. No address, no phone number, no note text, no money. The keys
// are namespaced by technician so a shared handset starts from "no claims"
// rather than from somebody else's morning — that is a correctness rule (a diff
// across two workers' days is meaningless), not a privacy control.

const PREFIX = 'eq-crew-brief:v1'

function keyFor(techId: string | null, dateISO: string): string {
  return `${PREFIX}:${techId ?? 'unknown'}:${dateISO}`
}

/** Storage, or null when it cannot be reached. Touching localStorage throws
 *  outright in some privacy modes, so even the lookup is guarded. */
function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch { return null }
}

/**
 * The day this worker last acknowledged, or null.
 *
 * Null on: no storage, nothing saved, unparseable JSON, or a snapshot whose
 * shape this build does not recognise. Callers must treat all of them the same
 * way — as no baseline — and diffCrewDay does.
 */
export function readCrewDayBaseline(techId: string | null, dateISO: string): CrewDaySnapshot | null {
  const s = store()
  if (!s) return null
  try {
    const raw = s.getItem(keyFor(techId, dateISO))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CrewDaySnapshot
    // A snapshot that does not answer for THIS worker on THIS day is not a
    // baseline, however it came to be under this key.
    if (parsed?.v !== 1) return null
    if (parsed.date !== dateISO) return null
    if ((parsed.techId ?? null) !== (techId ?? null)) return null
    if (!Array.isArray(parsed.order) || typeof parsed.stops !== 'object' || parsed.stops === null) return null
    return parsed
  } catch { return null }
}

/**
 * Record what the worker has now seen.
 *
 * ⛔ CALL THIS ON ACKNOWLEDGEMENT ONLY — never from a render, an interval or a
 * refetch. lib/crewBrief honesty rule 3: the day re-reads itself on focus,
 * reconnect and a five-minute timer, so a save on load would mean a phone lying
 * face-up on the seat quietly consuming a schedule change the worker never saw.
 *
 * A failed write is swallowed. The cost is that the same changes are offered
 * again on the next load, which is the safe direction to fail.
 */
export function writeCrewDayBaseline(snap: CrewDaySnapshot): void {
  const s = store()
  if (!s) return
  try {
    s.setItem(keyFor(snap.techId, snap.date), JSON.stringify(snap))
  } catch { /* full or blocked: the changes simply stay unacknowledged */ }
  pruneOtherDays(s, snap.date)
}

/**
 * Yesterday's baselines are dead weight — the diff refuses to compare across
 * dates anyway. Cleared on each save so a phone that runs all season does not
 * accumulate a snapshot per working day until it hits quota (which would break
 * the CURRENT day's save, the one that matters).
 */
function pruneOtherDays(s: Storage, keepDate: string): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(PREFIX + ':') && !k.endsWith(':' + keepDate)) doomed.push(k)
    }
    for (const k of doomed) s.removeItem(k)
  } catch { /* pruning is hygiene, never a reason to fail a save */ }
}
