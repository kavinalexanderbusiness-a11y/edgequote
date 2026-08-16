// ── THE origin every generated link is built on ──────────────────────────────
// One question — "what address does this deploy tell the outside world to come
// back to?" — with one answer. Portal links, booking links, crew invitations and
// password resets all leave the building carrying it, and every one of them is
// unreachable if it is wrong.
//
// ⚠️ WHY THIS SANITISES RATHER THAN TRUSTS. NEXT_PUBLIC_APP_URL is typed by a
// human into a dashboard, or piped in by a shell. On 2026-08-15 both failure
// modes landed within an hour of each other:
//
//   1. The production domain moved to app.edgehq.ca and the variable still held
//      the retired host, so every emailed link answered DEPLOYMENT_NOT_FOUND.
//   2. Setting it from PowerShell wrote a UTF-8 BOM into the value —
//      "﻿https://app.edgehq.ca" — which is invisible in every dashboard
//      that displays it and produces a link no browser can resolve.
//
// A stray BOM, a wrapping quote, a trailing slash or a newline are all things a
// value can pick up in transit. None of them is worth a broken invitation, and
// none is detectable by eye. So the value is CLEANED here, once, and every
// caller gets the same clean answer.
//
// What this does NOT do is invent an origin. If the variable is absent, the
// caller's own request origin is the honest fallback (correct for local dev and
// preview deploys); if there is no request either, the empty string is returned
// rather than a guessed hostname — a relative link that visibly fails beats an
// absolute one pointing somewhere real and wrong.

/**
 * Strip what a value picks up in transit: a byte-order mark, surrounding
 * whitespace or newlines, wrapping quotes, and any trailing slash.
 *
 * Exported for the guard, which drives it over each corruption shape rather
 * than trusting that the regex says what it means.
 */
export function cleanOrigin(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/^﻿/, '')        // UTF-8 BOM, invisible everywhere it is displayed
    .trim()                        // whitespace and newlines from a shell pipe
    .replace(/^["']|["']$/g, '')   // quotes a .env line can carry in
    .trim()
    .replace(/\/+$/, '')           // trailing slash — every caller appends its own
}

/**
 * THE origin, for server code that has a request in hand.
 *
 * Prefers the configured value (the deploy's own answer, and the only one that
 * is right when a request arrives on an internal or alias hostname), and falls
 * back to the request's origin so previews and local dev work untouched.
 */
export function appOrigin(requestOrigin?: string | null): string {
  return cleanOrigin(process.env.NEXT_PUBLIC_APP_URL) || cleanOrigin(requestOrigin)
}
