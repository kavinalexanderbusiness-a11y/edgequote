// ── Sentry scrubbing ─────────────────────────────────────────────────────────
// THE one place we decide what must never leave this app. Shared by all three
// Sentry runtimes (client, server, edge) so a rule can't be applied in two of
// them and forgotten in the third.
//
// WHY THIS EXISTS AT ALL:
// A customer's portal URL *is* their credential — /portal/<token> needs no
// password, so the token is the whole key. Sentry captures request URLs,
// breadcrumbs and navigation by default, which means an un-scrubbed setup would
// quietly ship live customer credentials to a third party on every error. Same
// for /book/<token>, which is the owner's public booking key.
//
// The rule: observability must never become an exfiltration path. If we can't
// scrub a field confidently, we drop it.

/** Tokens live in the path, not a query param: /portal/<token>, /book/<token>. */
const TOKEN_PATH_RE = /\/(portal|book)\/[^/?#]+/gi

/** Query params that carry secrets or identity across the app's own URLs. */
const SENSITIVE_PARAMS = ['token', 'p_token', 'secret', 'key', 'signature', 'sig', 'code', 'access_token']

/** Replace the token segment of a portal/booking URL with a placeholder. */
export function scrubUrl(input: string): string {
  if (!input) return input
  let out = input.replace(TOKEN_PATH_RE, (_m, kind) => `/${kind}/[token]`)
  // Strip sensitive query values without destroying the shape of the URL — the
  // param NAME is useful signal ("this failed with a token present"); the value
  // never is.
  for (const p of SENSITIVE_PARAMS) {
    out = out.replace(new RegExp(`([?&]${p}=)[^&#]*`, 'gi'), `$1[redacted]`)
  }
  return out
}

/** SDK labels can wrap a route: `Page Server Component (/portal/[token])`. */
function scrubTransactionName(input: string): string {
  // Keep the label and closing delimiter outside the URL token match. Applying
  // scrubUrl to the entire wrapper would consume its closing parenthesis too.
  const wrapped = /^([^/?#&]*\()(.+)\)$/.exec(input)
  return wrapped ? `${wrapped[1]}${scrubUrl(wrapped[2])})` : scrubUrl(input)
}

/** Only the installed SDK's legacy browser INP envelope, not other span channels. */
export function scrubInpEnvelope(envelope: [Record<string, unknown>, [Record<string, unknown>, unknown][]]): void {
  const [headers, items] = envelope
  let hasInp = false
  const nextItems = items.map<(typeof items)[number]>(item => {
    const [itemHeaders, payload] = item
    if (itemHeaders.type !== 'span' || itemHeaders.content_type !== undefined ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) return item
    const span = payload as Record<string, unknown>
    if (span.origin !== 'auto.http.browser.inp' || typeof span.span_id !== 'string' ||
      typeof span.trace_id !== 'string' || typeof span.start_timestamp !== 'number' ||
      !span.data || typeof span.data !== 'object' || Array.isArray(span.data)) return item
    hasInp = true
    const data = span.data as Record<string, unknown>
    if (typeof data.transaction !== 'string') return item
    return [itemHeaders, { ...span, data: { ...data, transaction: scrubTransactionName(data.transaction) } }]
  })
  if (!hasInp) return
  // beforeEnvelope ignores return values. Replace only the envelope's copies;
  // the SDK may still share the original attributes and frozen sampling context.
  envelope[1] = nextItems
  const trace = headers.trace
  if (trace && typeof trace === 'object' && !Array.isArray(trace) &&
    typeof (trace as Record<string, unknown>).transaction === 'string') {
    envelope[0] = { ...headers, trace: { ...trace,
      transaction: scrubTransactionName((trace as { transaction: string }).transaction) } }
  }
}

/** Keys whose VALUE must never be sent, wherever they appear. */
const SENSITIVE_KEY_RE = /(token|secret|password|authorization|cookie|api[-_]?key|access[-_]?key|service[-_]?role|card|cvc|iban|sin|ssn)/i

/**
 * Recursively redact sensitive values in an arbitrary object (Sentry `extra`,
 * `contexts`, request data). Depth-capped: a cyclic or vast object must not turn
 * error reporting into a performance problem during an incident.
 */
export function scrubObject(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value
  if (typeof value === 'string') return scrubUrl(value)
  if (Array.isArray(value)) return value.slice(0, 50).map(v => scrubObject(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[redacted]' : scrubObject(v, depth + 1)
    }
    return out
  }
  return value
}

// Minimal shape of what we touch on a Sentry event — typed locally so this module
// stays dependency-free and testable without importing the SDK.
interface ScrubbableEvent {
  transaction?: string
  sdkProcessingMetadata?: { dynamicSamplingContext?: { transaction?: string } }
  request?: { url?: string; headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown }
  breadcrumbs?: { data?: Record<string, unknown>; message?: string }[]
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  user?: Record<string, unknown>
}

/**
 * THE beforeSend/beforeSendTransaction body. Applied identically in every runtime.
 * Deliberately conservative: it strips more than it strictly must, because the
 * cost of over-scrubbing is a slightly less convenient stack trace, and the cost
 * of under-scrubbing is a customer's portal key sitting in a third-party SaaS.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (typeof event.transaction === 'string') event.transaction = scrubTransactionName(event.transaction)
  // Sentry copies this second name into the envelope's trace header before
  // removing SDK metadata from the event body. Do not mutate a shared context.
  const sampling = event.sdkProcessingMetadata?.dynamicSamplingContext
  if (typeof sampling?.transaction === 'string') {
    event.sdkProcessingMetadata = {
      ...event.sdkProcessingMetadata,
      dynamicSamplingContext: { ...sampling, transaction: scrubTransactionName(sampling.transaction) },
    }
  }
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url)
    // Headers and cookies carry auth wholesale. There is no version of these we
    // need badly enough to risk sending.
    delete event.request.cookies
    delete event.request.headers
    if (event.request.query_string) event.request.query_string = scrubObject(event.request.query_string)
    if (event.request.data) event.request.data = scrubObject(event.request.data)
  }
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubUrl(b.message)
      if (b.data) b.data = scrubObject(b.data) as Record<string, unknown>
    }
  }
  if (event.extra) event.extra = scrubObject(event.extra) as Record<string, unknown>
  if (event.contexts) event.contexts = scrubObject(event.contexts) as Record<string, unknown>
  // We never send user identity. A Supabase user_id is enough to correlate in our
  // own logs if we ever need to, and it isn't worth sending an email to Sentry.
  if (event.user) {
    const id = event.user.id
    event.user = id ? { id } : {}
  }
  return event
}

/**
 * Errors that are noise, not signal. Filtering them at the source keeps the issue
 * feed meaningful — an alerting system nobody trusts is the same as no alerting.
 */
export function isIgnorable(message: string): boolean {
  return [
    'ResizeObserver loop',          // benign browser layout chatter
    'Non-Error promise rejection',  // usually a cancelled fetch
    'AbortError',                   // user navigated away mid-request
    'NEXT_REDIRECT',                // Next's control flow, not a failure
    'NEXT_NOT_FOUND',
  ].some(p => message.includes(p))
}
