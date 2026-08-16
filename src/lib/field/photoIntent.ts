// ── Proof photos that survive a dead zone, and never land twice ──────────────
//
// ⭐⭐ THE IDEMPOTENCY KEY IS THE STORAGE PATH.
//
// A worker shoots the finished lawn, the upload starts, the truck rolls out of
// coverage. They tap Retry. Whether the first attempt got there is unknowable
// from the phone — so the retry must be constructed such that landing twice is
// IMPOSSIBLE rather than unlikely.
//
// The token below is minted ONCE when the shot is taken and reused by every
// retry of that shot. The server derives the object's path from it
// deterministically, so all attempts address the SAME object — and object
// storage's own `upsert: false` is then the atomic primitive: the second writer
// is told the object already exists. No new column, no migration, no
// check-then-write race on the row.
//
// ⛔ WHY NOT `content_hash`, the column that already exists and is already
// indexed for dedup: it holds a PERCEPTUAL hash (lib/dedup — compared by Hamming
// distance, with a deliberate near-duplicate threshold). Two genuinely different
// photographs of the same lawn are DESIGNED to collide on it. Using it as a
// retry key would silently discard a worker's second shot as a duplicate — data
// loss dressed as idempotency, and unrecoverable because the lawn is already
// mown. It answers "do these look alike", never "is this the same upload".
//
// ⛔ And not a random path per attempt, which is what the route did: a retry
// after a lost response uploaded the bytes AGAIN under a fresh name, so the
// customer's timeline showed the same photo twice and the second object was
// storage nobody could account for.

/** Minted at the moment the camera returns the file, carried through every
 *  retry of THAT shot. ⛔ Never regenerate on retry — a fresh token addresses a
 *  fresh object and turns the guarantee off. */
export function newPhotoToken(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Tokens cross the wire and land in a storage path, so they are constrained to
 *  what a path may safely hold. Anything else is refused rather than sanitised —
 *  a token we rewrote would no longer address the object the first attempt
 *  wrote, quietly restoring the duplicate. */
const TOKEN_RE = /^[a-zA-Z0-9-]{8,64}$/
export function isValidPhotoToken(token: string): boolean {
  return TOKEN_RE.test(token)
}

/**
 * ⭐ THE path, derived — never invented per attempt.
 *
 * Shape follows the canonical one (`<owner>/<property>/<file>`) because the
 * storage policies key on the first segment as the tenant boundary. The visit
 * and the token identify the shot within it; the extension follows the content
 * type so the object is served correctly.
 *
 * Pure and exported so the guard can assert the property that matters: the same
 * token yields the same path, and different tokens never collide.
 */
export function photoStoragePath(
  ownerId: string, propertyId: string | null, jobId: string, token: string, ext: string,
): string {
  return `${ownerId}/${propertyId ?? 'unassigned'}/${jobId}-${token}.${ext}`
}

// ── What the worker's screen may claim ───────────────────────────────────────
// ⛔⛔ A REQUIRED PHOTO IS NOT SATISFIED UNTIL THE ROW EXISTS. `uploading` and
// `failed` are both "not yet", and a checklist that counted a queued shot as
// done would let a worker close out a visit whose only evidence is sitting in a
// phone that may never reconnect. Only `stored` — server row confirmed — counts.
export type PhotoShotState = 'uploading' | 'pending' | 'failed' | 'stored'

export function isCanonicallyStored(state: PhotoShotState): boolean {
  return state === 'stored'
}

/** How many shots have NOT reached the server. The completion sheet reads this
 *  so its confirmation can say a note saved while evidence is still outstanding,
 *  rather than one cheerful "Saved" covering both. */
export function outstandingShots(states: PhotoShotState[]): number {
  return states.filter(s => !isCanonicallyStored(s)).length
}
