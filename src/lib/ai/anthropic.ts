// ── AI generation gateway (Anthropic / Claude) ─────────────────────────────────
// The ONE place the app talks to a language model. Mirrors lib/comms/send.ts:
// raw fetch (no SDK — same as Twilio/Resend/Stripe), DISABLED by default. Every
// call is a no-op returning { ok:false, reason:'disabled' } until ANTHROPIC_API_KEY
// is present, so the Marketing Studio can be wired now and "just work" the moment
// the key is added — and nothing can call the model by accident. Server-only —
// never import into a client component (the key must never reach the browser).

// Quality copy: Opus 4.8 is the default. Marketing drafts are short and creative;
// we omit `thinking` (off by default on 4.8) and send no sampling params (removed
// on 4.8 — they 400). Callers may override the model for cheap bulk variants.
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
      // Surface Anthropic's exact error (e.g. 401 invalid key, 429 rate limit).
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