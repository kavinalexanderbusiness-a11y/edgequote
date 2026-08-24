import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BriefingChip } from '@/lib/dashboard/briefing'

// ── The briefing strip — today's shape, each fact a door ─────────────────────
// Presentation for lib/dashboard/briefing's chips: the linked evolution of the
// header facts ("7 stops today · $840 booked") that used to be a static string.
// Server-rendered from the same batch as every band, so it paints complete on
// the first byte and can never disagree with the cards below it.
//
// Tone language: neutral facts stay quiet; amber = waiting on someone; red is
// reserved for broken-or-late (conflicts, overdue) — the same reservation the
// design language makes for tinted pills. An UNAVAILABLE source wears amber
// with a warning glyph and says so in words: a failed read is an answer, and
// it must never be dressed as a calm zero.

const TONE: Record<BriefingChip['tone'], string> = {
  neutral: 'border-border bg-bg-secondary text-ink-muted hover:text-ink hover:border-border-strong',
  attention: 'border-amber-500/25 bg-amber-500/[0.07] text-amber-400 hover:border-amber-500/45',
  urgent: 'border-red-500/25 bg-red-500/[0.07] text-red-400 hover:border-red-500/45',
}

export function OwnerBriefing({ chips }: { chips: BriefingChip[] }) {
  if (chips.length === 0) return null
  return (
    <nav aria-label="Today at a glance" className="flex flex-wrap items-center gap-2">
      {chips.map(c => (
        <Link
          key={c.id}
          href={c.href}
          className={cn(
            'tap-target-y inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            TONE[c.tone],
          )}
        >
          {c.unavailable && <AlertTriangle aria-hidden className="w-3 h-3 shrink-0" />}
          <span>{c.label}</span>
          {c.sub && <span className="font-medium opacity-70">· {c.sub}</span>}
        </Link>
      ))}
    </nav>
  )
}
