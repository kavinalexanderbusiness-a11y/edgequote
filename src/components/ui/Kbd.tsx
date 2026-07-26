import { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// ── Kbd ───────────────────────────────────────────────────────────────────────
// THE keyboard-key chip. Five hand-rolled <kbd>s had five stylings — but only
// two intents, now named:
//   hint — a quiet inline affordance next to a control ("⌘K", "/", "Esc").
//          Faint on purpose: it whispers that a shortcut exists.
//   map  — a readable key in a shortcut-reference list ("?" overlays, help
//          panels). Higher contrast + tabular-nums so a column of keys aligns.
// Styles are the most deliberate existing site of each role, verbatim
// (hint = the sidebar's ⌘K; map = the dispatch shortcut sheet).
interface KbdProps extends HTMLAttributes<HTMLElement> {
  variant?: 'hint' | 'map'
}

export function Kbd({ variant = 'hint', className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        variant === 'hint'
          ? 'text-[10px] font-semibold text-ink-faint border border-border rounded px-1.5 py-0.5'
          : 'rounded-md border border-border-strong bg-bg-tertiary px-1.5 py-0.5 text-[11px] font-semibold text-ink tabular-nums whitespace-nowrap',
        className,
      )}
      {...props}
    />
  )
}
