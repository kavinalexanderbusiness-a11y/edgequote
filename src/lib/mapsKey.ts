// ── THE server-side Google Maps credential ───────────────────────────────────
// One reader for GOOGLE_MAPS_API_KEY, because six routes were each doing their
// own bare `process.env.GOOGLE_MAPS_API_KEY` and a value that arrives damaged is
// damaged for all of them in the same invisible way.
//
// ⚠️ WHY THIS SANITISES RATHER THAN TRUSTS — THE EXACT BUG HAS HAPPENED HERE.
// On 2026-08-15 NEXT_PUBLIC_APP_URL was set from PowerShell and picked up a
// UTF-8 BOM. Invisible in every dashboard that displays it, and it produced a
// URL no browser could resolve. lib/appOrigin now cleans that value for exactly
// this reason.
//
// An API key is MORE vulnerable to it, not less, because there is no way to look
// at one and tell. A key carrying a BOM, a wrapping quote, or a trailing newline
// is sent to Google verbatim and comes back as:
//
//   REQUEST_DENIED — The provided API key is invalid.
//
// which is byte-for-byte the same message Google returns for a key that was
// genuinely deleted. So the two causes are indistinguishable from the outside,
// and one of them is free to rule out. This rules it out.
//
// ⛔ This does NOT paper over a revoked credential. If the key is genuinely gone,
// the cleaned value is still refused and the route still reports the refusal in
// Google's own words. The only thing that changes is that a value which was
// always correct stops being corrupted in transit.

/**
 * Strip what a secret picks up between a dashboard field and `process.env`:
 * a byte-order mark, surrounding whitespace or newlines, and wrapping quotes.
 *
 * Deliberately the same shape as lib/appOrigin's cleanOrigin, minus the URL
 * concerns. Exported so the guard can drive each corruption shape through it
 * rather than trusting that the regex says what it means.
 */
export function cleanKey(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    // The invisibles `trim()` CANNOT reach — zero-width space/joiners and the
    // bidi marks. A value copied out of a rendered console page rather than
    // typed picks them up and they survive trim() untouched. (U+FEFF is absent
    // on purpose: it is WhiteSpace, so the trim() below already takes it.)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim()
}

/**
 * THE server Maps key, cleaned. Empty string when unset — callers already treat
 * that as "not configured" and answer 500 rather than calling Google with nothing.
 */
export function serverMapsKey(): string {
  return cleanKey(process.env.GOOGLE_MAPS_API_KEY)
}

/**
 * A safe way to say WHICH credential a deploy is carrying, for diagnostics and
 * support, without putting the secret in a log, a screenshot or a bug report.
 *
 * Google API keys are not secrets in the cryptographic sense — the browser one
 * ships in the bundle — but the server one is restriction-free by design (that
 * is the whole point of proxying through /api/*), so it must never be printed.
 * The first four and last four characters are enough for a human to compare two
 * keys for identity, and far too little to use one.
 */
export function keyFingerprint(key: string | null | undefined): string {
  const k = cleanKey(key)
  if (!k) return '(unset)'
  if (k.length < 12) return '(malformed)'
  return `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`
}

/**
 * Whether the value even LOOKS like a Google API key, before we spend a round
 * trip finding out. Google's keys are `AIza` + 35 URL-safe characters.
 *
 * ⭐ This is what tells a damaged value apart from a revoked one WITHOUT asking
 * Google: a key that fails this never reached Google intact, so "invalid key"
 * would be our fault, not the credential's. Callers surface that distinction
 * instead of reporting a configuration error the owner cannot act on.
 */
export function looksLikeMapsKey(key: string | null | undefined): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(cleanKey(key))
}
