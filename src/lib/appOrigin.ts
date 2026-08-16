// ── THE app origin ───────────────────────────────────────────────────────────
// Every generated link — beta confirmation, crew setup, password reset, portal,
// booking, Stripe return URLs — and every webhook URL we RECONSTRUCT in order to
// check a signature is built from NEXT_PUBLIC_APP_URL. That makes the exact BYTES
// of that env var load-bearing, and an env var is whatever a human last pasted
// into a web form.
//
// 2026-08-15: the production domain moved to app.edgehq.ca and the pasted value
// arrived with a UTF-8 BOM (U+FEFF) in front of it. Nothing threw. Instead each
// consumer failed differently, and quietly:
//   · new URL(origin)          → Invalid URL
//   · Stripe success_url       → rejected; the Pay button 502s
//   · Twilio signature check   → HMAC computed over "<U+FEFF>https://…" never
//                                matches Twilio's → 403 on EVERY inbound SMS
//   · /^https:\/\//.test(base) → false, so the SMS status callback silently
//                                stopped being sent — sends "succeed" forever
//                                with no delivery updates
//   · emailed links            → an invisible character in front of the scheme
// Five different directions of failure, no single visible symptom, which is why
// it survived a domain migration that everyone was watching.
//
// So the origin is resolved in exactly ONE place. It is NORMALIZED (invisible
// characters and surrounding whitespace removed) and VALIDATED (it must parse as
// an http(s) URL) before anything is built on top of it.
//
// THE CONTRACT
// · An origin we cannot trust reads as ABSENT (''), never as a repaired guess.
//   Every caller already has an absent-origin path — a relative link, a skipped
//   status callback, a friendly "not set up". A missing link is a far better
//   failure than an invisible-character link that looks correct in every log.
// · Normalizing is NOT the same as accepting anything: we strip characters that
//   carry no meaning in a URL, we do not rewrite a wrong host into a right one.
// · This module never reads the request. Precedence between the configured
//   origin and the request origin belongs to each door (they legitimately
//   differ: a webhook trusts its own request, an emailed link must not), and
//   changing that precedence is not this module's job.

/** Characters that can ride along invisibly in a pasted env var and are never
 *  meaningful in an origin: the BOM/zero-width family and the bidi controls.
 *  Written as escapes ON PURPOSE — the literal characters are invisible in a
 *  diff, which is the very property that caused the outage this file exists for.
 *  Same class as lib/customerImport's INVISIBLE_CHARS, kept separate because
 *  cleaning a pasted CSV cell and parsing a deploy's origin are not one job. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * Clean and validate an origin. Returns '' when the value is absent or cannot be
 * trusted — callers treat '' exactly as they already treat "not configured".
 *
 * Pure and side-effect free; pinned by scripts/verify-app-origin.ts.
 */
export function normalizeOrigin(raw: string | null | undefined): string {
  if (!raw) return ''
  // Order matters: strip the invisibles FIRST, otherwise a leading BOM defeats
  // the anchored scheme test below exactly the way it defeated the real ones.
  const cleaned = raw.replace(INVISIBLE, '').trim().replace(/\/+$/, '')
  if (!cleaned) return ''
  let parsed: URL
  try {
    parsed = new URL(cleaned)
  } catch {
    return '' // not a URL at all — say nothing rather than something wrong
  }
  // http(s) only. A mailto:/javascript: origin would be pasted into links and
  // webhook URLs, and neither is a thing this app can serve.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  // Rebuild from the parsed URL rather than returning `cleaned`: this drops any
  // path, query or fragment someone appended, which is what every caller means
  // by "origin" when it writes `${base}/portal/…`.
  return parsed.origin
}

/**
 * THE configured app origin — normalized NEXT_PUBLIC_APP_URL, or '' if it is
 * unset or unusable. This is the value that ends up in generated links.
 */
export function configuredAppOrigin(): string {
  return normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL)
}

/**
 * What /api/health reports about the origin. Three states worth telling apart:
 *
 *  · not configured  — fine in a preview, expected locally. Says nothing.
 *  · configured, but not a usable origin — an outage wearing an ordinary-looking
 *    string. The only one that should degrade a deploy.
 *  · configured, usable, but it had to be SANITIZED — the app now compensates,
 *    so nothing is broken, but the stored env var is still wrong and the next
 *    thing to read it raw (a script, a dashboard, a human) will be misled.
 *    Reported, deliberately NOT degrading: it is a chore, not an outage.
 *
 * That third state is the one this whole module was written for. Without it the
 * fix would hide its own evidence — the value would read as healthy forever and
 * nobody would ever correct it at the source.
 */
export function appOriginReport(): {
  origin: string | null; configured: boolean; usable: boolean; sanitized: boolean
} {
  const raw = process.env.NEXT_PUBLIC_APP_URL
  const configured = !!raw && raw.trim().length > 0
  const origin = configuredAppOrigin()
  // Whether real characters had to be removed. Two questions, because neither
  // answers it alone:
  //
  //   · did it carry invisible characters? Asked DIRECTLY, and deliberately not
  //     via trim(): JavaScript's trim() counts U+FEFF as whitespace and would
  //     quietly eat the exact character that caused the outage, reporting the
  //     production value as clean. (It does NOT strip U+200B or the bidi
  //     controls, so trim() is not a fix either — only a blindfold.)
  //   · did anything else change? Catches a stray path, query or fragment.
  //
  // A trailing slash and ordinary surrounding whitespace stay BENIGN — they are
  // common, harmless, and flagging them would train everyone to ignore the flag.
  const hadInvisible = new RegExp(INVISIBLE.source).test(raw || '')
  const benign = (raw || '').trim().replace(/\/+$/, '')
  return {
    origin: origin || null,
    configured,
    usable: !!origin,
    sanitized: !!origin && (hadInvisible || benign !== origin),
  }
}
