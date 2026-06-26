import type { PhotoKind } from '@/types'

// ── Before/After pairing engine ─────────────────────────────────────────────
// Pure, framework-free. Turns the raw rows the Studio loads (completed jobs +
// their before/after photos) into rankable BEFORE→AFTER pairs, plus a
// deterministic quality score used both to order the gallery and as the fallback
// when AI ranking is unavailable. The AI does the real "strongest pair" pick
// (vision); this is the floor, never the only path.

export interface PhotoLite {
  id: string
  url: string
  kind: PhotoKind
  taken_at: string
  caption: string | null
  property_id: string | null
  job_id: string | null
}

export interface JobLite {
  id: string
  title: string
  service_type: string | null
  scheduled_date: string
  completed_at: string | null
  customer_id: string | null
  property_id: string | null
}

export interface PairContext {
  customerName: string | null
  address: string | null
  neighborhood: string | null
  // null = consent column not available / unknown (don't gate); true/false = recorded.
  consent: boolean | null
}

export interface BeforeAfterPair {
  jobId: string
  job: JobLite
  context: PairContext
  before: PhotoLite
  after: PhotoLite
  // All before/after photos on the SAME property — lets the owner swap either
  // side to build a cross-visit pair without us auto-inventing dubious matches.
  beforeOptions: PhotoLite[]
  afterOptions: PhotoLite[]
  score: number // deterministic 0–100
  reasons: string[]
}

// Services whose result is visually dramatic — the posts people actually stop on.
const VISUAL_HINTS = [
  'mow', 'lawn', 'landscap', 'cleanup', 'clean-up', 'clean up', 'leaf', 'leaves',
  'snow', 'plow', 'mulch', 'trim', 'hedge', 'garden', 'aerat', 'overseed', 'sod',
  'pressure', 'power wash', 'gutter', 'edg', 'weed',
]

function isVisual(serviceType: string | null): boolean {
  const s = (serviceType || '').toLowerCase()
  return VISUAL_HINTS.some(h => s.includes(h))
}

function daysSince(iso: string | null, nowMs: number): number {
  if (!iso) return 9999
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 9999
  return Math.max(0, Math.round((nowMs - t) / 86_400_000))
}

// Deterministic 0–100 with a short "why". No pixels are read here — it's a cheap
// proxy over service type, freshness, caption presence and how much there is to
// show. The vision pass refines the order; this guarantees a sensible default.
function scorePair(job: JobLite, before: PhotoLite, after: PhotoLite, ctx: PairContext, afterCount: number, nowMs: number): { score: number; reasons: string[] } {
  let score = 50
  const reasons: string[] = []

  if (isVisual(job.service_type)) { score += 16; reasons.push('High-impact service') }
  const age = daysSince(job.completed_at || job.scheduled_date, nowMs)
  if (age <= 30) { score += 12; reasons.push('Fresh job') }
  else if (age <= 90) { score += 5 }
  if (before.caption || after.caption) { score += 8; reasons.push('Has a caption') }
  if (afterCount >= 2) { score += 8; reasons.push('Several afters to choose from') }
  if (ctx.neighborhood) { score += 4; reasons.push('Known neighborhood') }
  if (ctx.consent === true) { score += 6; reasons.push('Photos cleared to post') }

  return { score: Math.max(0, Math.min(100, score)), reasons }
}

// Build pairs from the loaded data. A pair is a COMPLETED job that has at least
// one before AND one after photo (the strongest, most honest signal — same
// visit). Best before = earliest, best after = latest (the finished look).
export function buildPairs(
  jobs: JobLite[],
  photos: PhotoLite[],
  contexts: Map<string, PairContext>,
  nowMs: number,
): BeforeAfterPair[] {
  const byJob = new Map<string, PhotoLite[]>()
  const byProp = new Map<string, PhotoLite[]>()
  for (const p of photos) {
    if (p.job_id) {
      const arr = byJob.get(p.job_id) || []
      arr.push(p)
      byJob.set(p.job_id, arr)
    }
    if (p.property_id) {
      const arr = byProp.get(p.property_id) || []
      arr.push(p)
      byProp.set(p.property_id, arr)
    }
  }

  const pairs: BeforeAfterPair[] = []
  for (const job of jobs) {
    const jobPhotos = byJob.get(job.id) || []
    const befores = jobPhotos.filter(p => p.kind === 'before').sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at))
    const afters = jobPhotos.filter(p => p.kind === 'after').sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at))
    if (!befores.length || !afters.length) continue

    const before = befores[0]
    const after = afters[afters.length - 1]
    const ctx = contexts.get(job.id) || { customerName: null, address: null, neighborhood: null, consent: null }

    // Swap pools: every before/after on the same property (so the owner can pull
    // a cleaner shot from another visit) plus this job's own photos.
    const propPhotos = job.property_id ? byProp.get(job.property_id) || [] : jobPhotos
    const beforeOptions = dedupe([...befores, ...propPhotos.filter(p => p.kind === 'before')])
    const afterOptions = dedupe([...afters, ...propPhotos.filter(p => p.kind === 'after')])

    const { score, reasons } = scorePair(job, before, after, ctx, afters.length, nowMs)
    pairs.push({ jobId: job.id, job, context: ctx, before, after, beforeOptions, afterOptions, score, reasons })
  }

  return pairs.sort((a, b) => b.score - a.score)
}

function dedupe(list: PhotoLite[]): PhotoLite[] {
  const seen = new Set<string>()
  const out: PhotoLite[] = []
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}
