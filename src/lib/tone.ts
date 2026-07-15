// ── Semantic tone tokens ──────────────────────────────────────────────────────
// One source of truth for status colours. The strings mirror the status maps
// already in types/index.ts (emerald = success, amber = warn, red = danger,
// blue = info) so badges, banners, pills and stat tiles never drift. Pages
// should reference a Tone — never spell out `bg-emerald-500/15 …` inline.

export type Tone = 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'neutral'

/** Soft tinted chip: background + text + subtle border. Badges & pills. */
export const toneSoft: Record<Tone, string> = {
  accent:  'bg-accent/10 text-accent-text border-accent/30',
  success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  warn:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
  danger:  'bg-red-500/10 text-red-400 border-red-500/20',
  info:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
  neutral: 'bg-surface text-ink-muted border-border',
}

/** Foreground only — for big numbers and icons that carry a tone. */
export const toneText: Record<Tone, string> = {
  accent:  'text-accent-text',
  success: 'text-emerald-400',
  warn:    'text-amber-400',
  danger:  'text-red-400',
  info:    'text-blue-400',
  neutral: 'text-ink',
}
