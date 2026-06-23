// ── Job duration learning ──────────────────────────────────────────────────────
// Learn the owner's REAL on-site durations from completed timed jobs
// (jobs.actual_minutes, stamped by Day Ops check-in/out) so capacity, ETA and
// scheduling math can lean on actual pace instead of the static duration_minutes
// typed when a job was created. ONE place; reuses serviceCategory for grouping.
// Pure and synchronous — no I/O, safe to call inside the suggestions engine.

import { serviceCategory } from '@/lib/seasons'
import { DEFAULT_JOB_MIN } from '@/lib/route'

export interface DurationModel {
  byCategory: Record<string, number>       // median actual minutes per service category (n ≥ MIN_SAMPLES)
  sampleByCategory: Record<string, number> // how many timed jobs backed each category
  overall: number | null                   // median across ALL timed jobs (n ≥ MIN_SAMPLES)
  totalSamples: number
}

// A few real data points before a learned number outranks the typed one.
const MIN_SAMPLES = 3

interface DurJob {
  service_type: string | null
  status: string
  actual_minutes: number | null
  duration_minutes?: number | null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

// Build the model from all jobs. Only completed, plausibly-timed visits count
// (a forgotten running timer or a mis-tap is filtered as an outlier).
export function learnDurations(jobs: DurJob[]): DurationModel {
  const byCat: Record<string, number[]> = {}
  const all: number[] = []
  for (const j of jobs) {
    const a = Number(j.actual_minutes)
    if (j.status !== 'completed' || !(a > 0)) continue
    if (a < 5 || a > 600) continue // ignore implausible outliers
    const cat = serviceCategory(j.service_type)
    ;(byCat[cat] ||= []).push(a)
    all.push(a)
  }
  const byCategory: Record<string, number> = {}
  const sampleByCategory: Record<string, number> = {}
  for (const [cat, xs] of Object.entries(byCat)) {
    sampleByCategory[cat] = xs.length
    if (xs.length >= MIN_SAMPLES) byCategory[cat] = median(xs)
  }
  return {
    byCategory,
    sampleByCategory,
    overall: all.length >= MIN_SAMPLES ? median(all) : null,
    totalSamples: all.length,
  }
}

// Best on-site-minutes estimate for ONE job: its own actual (if already timed) →
// the learned category median → the typed duration → the global default. So
// planning uses real data wherever it exists and degrades gracefully everywhere
// else. Future visits (no actual_minutes) get the learned category median.
export function learnedDurationFor(
  job: { service_type: string | null; duration_minutes: number | null; actual_minutes?: number | null },
  model: DurationModel,
): number {
  const own = Number(job.actual_minutes)
  if (own > 0) return own
  const cat = serviceCategory(job.service_type)
  if (model.byCategory[cat] != null) return model.byCategory[cat]
  const typed = Number(job.duration_minutes)
  if (typed > 0) return typed
  return model.overall ?? DEFAULT_JOB_MIN
}
