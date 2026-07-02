// ── Marketing Studio AI gateway (text + streaming) ─────────────────────────────────
// A SECOND, dedicated door to the Claude Messages API for the Marketing Studio's
// TEXT generation (structured drafts + live streaming). It is deliberately separate
// from `lib/ai/anthropic.ts`, which is the MULTIMODAL (vision/before-after) gateway
// owned by another surface and has an incompatible `generateStructured({blocks,tool})`
// signature. Keeping them apart means the Studio can ship without modifying — or
// risking — the before-after gateway. Same conventions: raw `fetch` (no SDK),
// DISABLED BY DEFAULT (no-ops to { ok:false, reason:'disabled' } until
// ANTHROPIC_API_KEY is set), server-only — never import into a client component.

export const DEFAULT_AI_MODEL = 'claude-opus-4-8'
const ANTHROPIC_VERSION = '2023-06-01'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

export type AiResult<T> =
  | { ok: true; data: T; model: string }
  | { ok: false; reason: 'disabled' | 'error'; error?: string }

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// A JSON-Schema object describing the structured output we want back. Use
// additionalProperties:false + required on every object so `strict` can validate.
export type JsonSchema = Record<string, unknown>

interface GenerateOpts {
  system: string
  prompt: string
  // The model is forced to call this single tool, so its `input` IS our result —
  // a reliable structured-output channel (no brittle JSON-in-prose parsing).
  toolName: string
  toolDescription: string
  schema: JsonSchema
  model?: string
  maxTokens?: number
}

// Force a structured JSON object out of the model via a single required tool call.
// Returns the validated tool input as T. Never throws — degrades to an AiResult so
// callers (and the rest of the app) keep working when the model is down or absent.
export async function generateStructured<T>(opts: GenerateOpts): Promise<AiResult<T>> {
  if (!aiEnabled()) return { ok: false, reason: 'disabled' }
  const model = opts.model || DEFAULT_AI_MODEL
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 2000,
        system: opts.system,
        tools: [{
          name: opts.toolName,
          description: opts.toolDescription,
          input_schema: opts.schema,
          strict: true,
        }],
        tool_choice: { type: 'tool', name: opts.toolName },
        messages: [{ role: 'user', content: opts.prompt }],
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      let msg = `Anthropic ${res.status}`
      try { const j = JSON.parse(detail); if (j?.error?.message) msg = `Anthropic ${res.status}: ${j.error.message}` }
      catch { if (detail) msg += `: ${detail.slice(0, 300)}` }
      return { ok: false, reason: 'error', error: msg }
    }
    const data = await res.json()
    if (data?.stop_reason === 'refusal') {
      return { ok: false, reason: 'error', error: 'The model declined this request.' }
    }
    const block = Array.isArray(data?.content)
      ? data.content.find((b: { type?: string }) => b?.type === 'tool_use')
      : null
    if (!block || typeof block.input !== 'object') {
      return { ok: false, reason: 'error', error: 'No structured output returned.' }
    }
    return { ok: true, data: block.input as T, model }
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : 'generation failed' }
  }
}

interface StreamOpts {
  system: string
  prompt: string
  model?: string
  maxTokens?: number
}

// Stream a plain-text completion token-by-token. `onDelta` fires for each text
// chunk (the route re-emits these to the browser for a live "watch it write"
// feel); the full accumulated text comes back in the result. Parses the Messages
// API SSE stream by hand (no SDK) — same disabled-by-default contract as above.
export async function streamText(opts: StreamOpts, onDelta: (text: string) => void): Promise<AiResult<string>> {
  if (!aiEnabled()) return { ok: false, reason: 'disabled' }
  const model = opts.model || DEFAULT_AI_MODEL
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 1024,
        stream: true,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
      }),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      let msg = `Anthropic ${res.status}`
      try { const j = JSON.parse(detail); if (j?.error?.message) msg = `Anthropic ${res.status}: ${j.error.message}` }
      catch { if (detail) msg += `: ${detail.slice(0, 300)}` }
      return { ok: false, reason: 'error', error: msg }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of event.split('\n')) {
          const m = line.match(/^data:\s?(.*)$/)
          if (!m) continue
          const data = m[1]
          if (!data || data === '[DONE]') continue
          try {
            const evt = JSON.parse(data)
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              full += evt.delta.text
              onDelta(evt.delta.text)
            } else if (evt.type === 'error') {
              return { ok: false, reason: 'error', error: evt.error?.message || 'stream error' }
            }
          } catch { /* keep-alive / partial — ignore */ }
        }
      }
    }
    return { ok: true, data: full, model }
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : 'stream failed' }
  }
}