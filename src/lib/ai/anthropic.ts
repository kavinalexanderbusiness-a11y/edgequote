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

// ── Model tiers ──────────────────────────────────────────────────────────────
// One place that maps a *task shape* to a model, so a feature asks for the
// cheapest model that meets its bar instead of hard-coding an id. Vision / hard
// reasoning → Opus; routine text generation → Sonnet; high-volume cheap text →
// Haiku. Callers pass `tier`; an explicit `model` still wins. A model bump is a
// one-line change here — no caller edits. Keep `vision` on the flagship: the
// before/after picker and future property-vision must not lose quality.
export type AiTier = 'vision' | 'smart' | 'balanced' | 'fast'
export const MODEL_TIERS: Record<AiTier, string> = {
  vision: 'claude-opus-4-8',
  smart: 'claude-opus-4-8',
  balanced: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
}
export function modelForTier(tier?: AiTier): string {
  return tier ? MODEL_TIERS[tier] : AI_MODEL
}

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

// ── Image downscaling ────────────────────────────────────────────────────────
// Images dominate the input-token bill, so shrink them BEFORE the model fetches
// them. This is a pure URL rewrite of a Supabase Storage *public* object URL to
// its on-the-fly render URL at a bounded edge — the app does no server image
// processing and never touches the bytes. Any non-Supabase-public URL (or a
// non-positive edge) is returned UNCHANGED, so this is always safe to call.
// NOTE: the render endpoint needs Supabase image transformations enabled; callers
// should gate it (e.g. behind an env var) and rely on the usual graceful AI
// fallback if a transform URL ever fails to fetch.
export function downscaleImageUrl(url: string, maxEdge: number): string {
  if (!url || !Number.isFinite(maxEdge) || maxEdge <= 0) return url
  const marker = '/storage/v1/object/public/'
  const i = url.indexOf(marker)
  if (i === -1) return url
  const rendered = `${url.slice(0, i)}/storage/v1/render/image/public/${url.slice(i + marker.length)}`
  const edge = Math.round(maxEdge)
  const sep = rendered.includes('?') ? '&' : '?'
  return `${rendered}${sep}width=${edge}&height=${edge}&resize=contain&quality=80`
}

// A content block in the user turn. Images may be a public URL (cheapest — the
// API fetches it) or inline base64. Text blocks may set `cache: true` to drop a
// prompt-cache breakpoint after them — put the large STABLE prefix (instructions,
// brand/style guides, tool context) first and mark its last block cached, so
// repeated calls reuse it at ~10% of the input cost. Blocks below the model's
// minimum cacheable length are simply not cached (no error), so marking is safe.
export type AiBlock =
  | { type: 'text'; text: string; cache?: boolean }
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
    if (b.type === 'text') {
      const block: Record<string, unknown> = { type: 'text', text: b.text }
      if (b.cache) block.cache_control = { type: 'ephemeral' }
      return block
    }
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
  tier?: AiTier
  maxTokens?: number
  timeoutMs?: number
  // Drop a prompt-cache breakpoint on the system prompt / tool schema. Use when
  // the same large system or tool definition is reused across many calls.
  cacheSystem?: boolean
  cacheTools?: boolean
}): Promise<T | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null

  // A cached system prompt must be sent as content blocks, not a bare string.
  const system = opts.system
    ? opts.cacheSystem
      ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
      : opts.system
    : undefined

  const tool: Record<string, unknown> = {
    name: opts.tool.name,
    description: opts.tool.description,
    input_schema: opts.tool.schema,
  }
  if (opts.cacheTools) tool.cache_control = { type: 'ephemeral' }

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
        model: opts.model ?? modelForTier(opts.tier),
        max_tokens: opts.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        tools: [tool],
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
