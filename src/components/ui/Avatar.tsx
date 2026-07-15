import { cn, getInitials } from '@/lib/utils'

// ── Avatar ────────────────────────────────────────────────────────────────────
// ONE initials avatar. Replaces the hand-rolled `rounded-full bg-accent/10 …`
// circles that every customer surface stamped in a single flat accent tint —
// which made a list of 40 people a wall of identical grey-green dots. The colour
// is derived deterministically from a stable seed (the customer id), so the same
// person always wears the same colour across the list, their profile and the
// archive — turning colour into a scannable identity cue instead of decoration.
// Tints mirror the app's badge language (bg/10 · border/20 · text-400) and live
// here (a scanned path) so Tailwind never purges them.
const PALETTE = [
  'bg-accent/10 border-accent/25 text-accent',
  'bg-emerald-500/10 border-emerald-500/25 text-emerald-400',
  'bg-sky-500/10 border-sky-500/25 text-sky-400',
  'bg-violet-500/10 border-violet-500/25 text-violet-400',
  'bg-amber-500/10 border-amber-500/25 text-amber-400',
  'bg-rose-500/10 border-rose-500/25 text-rose-400',
  'bg-teal-500/10 border-teal-500/25 text-teal-400',
  'bg-fuchsia-500/10 border-fuchsia-500/25 text-fuchsia-400',
] as const

// Small, stable string hash (djb2-ish) → palette index. Same seed → same colour.
function paletteFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

const SIZES = {
  sm: 'w-9 h-9 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
} as const

export function Avatar({
  name,
  seed,
  size = 'md',
  className,
}: {
  name: string
  /** Stable colour seed — pass the customer id so the colour never shifts on rename. */
  seed?: string
  size?: keyof typeof SIZES
  className?: string
}) {
  const initials = getInitials(name) || '?'
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-full border flex items-center justify-center shrink-0 font-bold tracking-tight select-none',
        SIZES[size],
        paletteFor(seed || name),
        className,
      )}
    >
      {initials}
    </div>
  )
}
