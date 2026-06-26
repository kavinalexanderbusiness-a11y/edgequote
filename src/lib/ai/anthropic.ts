// ── THE Claude gateway ──────────────────────────────────────────────────────
// server-only; never import into a client component (it reads ANTHROPIC_API_KEY).
// A single server-side door to the Claude Messages API, by raw `fetch` (no SDK)
// to match the Twilio/Stripe/Resend convention used elsewhere in the app.
//
// DISABLED BY DEFAULT: every call no-ops gracefully (returns null) unless
// ANTHROPIC_API_KEY is set, so the whole app runs with no AI key and any feature
// that uses it degrades to a deterministic fallback. This file is generic on
// purpose — it knows nothing about before/after or marketing; callers describe a
// tool schema and pass content blocks (text and/or images).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

// Default to the most capable current model; callers may override.
export const AI_MODEL = 'claude-opus-4-8'

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// A content block in the user turn. Images may be a public URL (cheapest — the
// API fetches it) or inline base64.
export type AiBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'image'; base64: string; mediaType: string }

interface ApiImageSource {
  type: 'url' | 'base64'
  url?: string
  media_type?: string
  data?: string
}

function toApiContent(blocks: AiBlock[]): unknown[] {
  return blocks.map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    const source: ApiImageSource =
      'url' in b
        ? { type: 'url', url: b.url }
        : { type: 'base64', media_type: b.mediaType, data: b.base64 }
    return { type: 'image', source }
  })
}

interface ToolBlock {
  type: string
  name?: string
  input?: unknown
}

// Force a single strict tool call and return its validated `input` as T. This is
// THE structured-output path (no fragile prose parsing). Returns null when the
// gateway is disabled, on timeout, or on any API / shape failure — callers must
// always have a deterministic fallback.
export async function generateStructured<T>(opts: {
  blocks: AiBlock[]
  tool: { name: string; description: string; schema: Record<string, unknown> }
  system?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
}): Promise<T | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000)
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.model ?? AI_MODEL,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.system ? { system: opts.system } : {}),
        tools: [
          {
            name: opts.tool.name,
            description: opts.tool.description,
            input_schema: opts.tool.schema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.tool.name },
        messages: [{ role: 'user', content: toApiContent(opts.blocks) }],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { content?: ToolBlock[] }
    const use = (data.content || []).find(c => c.type === 'tool_use' && c.name === opts.tool.name)
    if (!use || use.input == null) return null
    return use.input as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
