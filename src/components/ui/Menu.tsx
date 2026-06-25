import { cn } from '@/lib/utils'

// ── Menu / Popover surface ─────────────────────────────────────────────────────
// One look for every dropdown, popover and context menu so they feel identical:
// an elevated raised surface, a defined border, a soft shadow and a subtle
// pop-in. Applied to the notification popover, address autocomplete, the message
// actions menu, the command palette, etc. Exported as class strings (not a forced
// wrapper) so each popover keeps its own positioning logic.
export const menuSurface =
  'rounded-card border border-border-strong bg-surface-raised shadow-xl overflow-hidden animate-pop'

// One menu row: consistent padding, icon gap, hover + focus, disabled.
export const menuItemClass =
  'w-full text-left flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-ink transition-colors hover:bg-surface focus:bg-surface focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none'

export function MenuItem({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(menuItemClass, className)} {...props} />
}
