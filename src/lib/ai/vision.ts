// ── AI Vision gateway (Anthropic / Claude, multimodal) ─────────────────────────
// The ONE place the app sends IMAGES to a language model. A deliberate sibling of
// lib/ai/anthropic.ts (which is text-only and owned by Marketing Studio) — same
// contract, same disabled-by-default safety, but the user turn carries image
// blocks. Kept separate so nothing in the existing text pipeline changes; we only
// READ the shared constants/types from anthropic.ts. Server-only — the key must
// never reach the browser, and image bytes are gathered server-side too.

import { aiEnabled, DEFAULT_AI_MODEL, type AiResult, type JsonSchema } from './anthropic'

const ANTHROPIC_VERSION = '2023-06-01'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

// Anthropic accepts a handful of image media types. We normalise to these; the
// gather step (lib/vision/data) downgrades anything unexpected to image/jpeg.
export type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

// One picture handed to the model, base64-encoded (no public URL required, so a
// private/static-maps image with an embedded API key never leaves the server).
// `label` is shown to the model as a text block immediately BEFORE the image, so
// it always knows what it's looking at ("Satellite aerial view", "AFTER photo").
export interface VisionImage {
  label: string
  mediaType: VisionMediaType
  dataBase64: string
}

interface AnalyzeOpts {
  system: string
  prompt: string
  images: VisionImage[]
  // Forced single tool call → its `input` IS our structured result (no brittle
  // JSON-in-prose parsing), exactly like anthropic.generateStructured.
  toolName: string
  toolDescription: string
  schema: JsonSchema
  model?: string
  maxTokens?: number
}

// Analyse one or more images and force a structured object back. Never throws —
// degrades to an AiResult so the route (and the rest of the app) keeps working
// when the model is down, absent, or declines. Mirrors generateStructured so a
// caller that knows one knows both.
export async function analyzeImages<T>(opts: AnalyzeOpts): Promise<AiResult<T>> {
  if (!aiEnabled()) return { ok: false, reason: 'disabled' }
  if (!opts.images.length) return { ok: false, reason: 'error', error: 'No imagery was available to analyze.' }
  const model = opts.model || DEFAULT_AI_MODEL

  // Interleave: [label, image] per picture, then the analysis instructions last.
  const content: unknown[] = []
  for (const img of opts.images) {
    content.push({ type: 'text', text: img.label })
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } })
  }
  content.push({ type: 'text', text: opts.prompt })

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
        max_tokens: opts.maxTokens ?? 2500,
        system: opts.system,
        tools: [{
          name: opts.toolName,
          description: opts.toolDescription,
          input_schema: opts.schema,
          strict: true,
        }],
        tool_choice: { type: 'tool', name: opts.toolName },
        messages: [{ role: 'user', content }],
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
      return { ok: false, reason: 'error', error: 'The model declined to analyze this imagery.' }
    }
    const block = Array.isArray(data?.content)
      ? data.content.find((b: { type?: string }) => b?.type === 'tool_use')
      : null
    if (!block || typeof block.input !== 'object') {
      return { ok: false, reason: 'error', error: 'No structured analysis returned.' }
    }
    return { ok: true, data: block.input as T, model }
  } catch (e) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : 'analysis failed' }
  }
}
