// ── THE AI streaming seam ─────────────────────────────────────────────────────
// One NDJSON transport for every AI surface in the product: the assist engine
// and the marketing generator both stream through here, server and client.
//
// WHY THIS EXISTS
// There were two hand-rolled copies of both halves. The server halves each built
// their own TextEncoder + ReadableStream + `emit` closure and repeated the same
// three headers; the client halves each ran the same getReader/TextDecoder/
// indexOf('\n')/JSON.parse loop. useAiAssist even said so in a comment: "Same
// reader loop as the marketing composer." Two copies of a transport is two
// places for a header to drift, and it is why the two stacks could feel like
// different products while doing the identical thing.
//
// WHAT THIS IS NOT
// It is not an engine and it does not know what a task is. Events stay open —
// assist sends {t:'delta'|'done'|'error'}, marketing also sends 'polishing' and
// 'note' and puts a `piece` on its done — because the two generators genuinely
// produce different things. The TRANSPORT is what's shared; the vocabulary is
// the caller's. That keeps the marketing engine untouched.

/** An NDJSON line. `t` is the event kind; every other field is the sender's. */
export interface AiStreamEvent {
  t: string
  text?: string
  error?: string
  [key: string]: unknown
}

// One place these are stated. `no-transform` and `X-Accel-Buffering: no` are the
// load-bearing ones: without them a proxy will buffer the stream and the whole
// "watch it write" effect collapses into a pause and a paste.
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
} as const

/**
 * SERVER: run `body`, streaming whatever it emits as NDJSON.
 *
 * A throw inside `body` becomes a terminal error EVENT rather than a dead
 * socket — previously an unexpected error mid-generation just stopped the
 * stream, and the client sat there with a spinner and no explanation.
 */
export function ndjsonResponse(
  body: (emit: (event: AiStreamEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AiStreamEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
      try {
        await body(emit)
      } catch (e) {
        // Never leak an exception string to a contractor; the client turns this
        // into its own human sentence anyway.
        console.error('[ai/stream] generation threw', e)
        emit({ t: 'error', error: 'generation failed' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: NDJSON_HEADERS })
}

/**
 * CLIENT: read an NDJSON response, calling `onEvent` per line.
 *
 * Partial lines are buffered across chunks (a delta can be split mid-JSON), and
 * an unparseable line is skipped rather than killing the read.
 *
 * `onEvent` may be async and is awaited in order — the marketing composer falls
 * back to a non-streaming generation from inside its error event, and events
 * must not overtake each other while it does.
 */
export async function readNdjson(
  res: Response,
  onEvent: (event: AiStreamEvent) => void | Promise<void>,
): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let evt: AiStreamEvent
      try { evt = JSON.parse(line) as AiStreamEvent } catch { continue }
      await onEvent(evt)
    }
  }
}

/** True when a response is a live NDJSON stream rather than a JSON error body. */
export function isNdjson(res: Response): boolean {
  return res.ok && (res.headers.get('content-type') || '').includes('ndjson') && !!res.body
}
