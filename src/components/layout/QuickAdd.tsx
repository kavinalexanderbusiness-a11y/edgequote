'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { quickAddActions, type QuickAddIcon } from '@/lib/quickAdd'
import { useQuickAddContext } from '@/components/layout/QuickAddProvider'
import { FilePlus, CalendarPlus, UserPlus, Timer, Receipt, X, type LucideIcon } from 'lucide-react'

// ── THE quick-add sheet ──────────────────────────────────────────────────────
// One sheet, opened by the ONE + in the bottom bar. It renders whatever
// lib/quickAdd decided for the surface underneath; it holds no rules of its own,
// so "what does + offer here" has exactly one answer in exactly one file.
//
// Opens UPWARD from the bar so every row lands under the thumb, and every row is
// ≥64px — this is the control you tap with a glove on.

const ICONS: Record<QuickAddIcon, LucideIcon> = {
  quote: FilePlus, visit: CalendarPlus, customer: UserPlus, time: Timer, cost: Receipt,
}

export function QuickAdd({ open, onClose, enabled }: {
  open: boolean
  onClose: () => void
  enabled: ReadonlySet<string>
}) {
  const pathname = usePathname()
  const ctx = useQuickAddContext()
  const sheetRef = useFocusTrap<HTMLDivElement>(open, onClose)

  // Tapping an action must feel like GOING, not like closing a dialog and then
  // going. Navigation closes the sheet.
  useEffect(() => { onClose() }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null
  const actions = quickAddActions(ctx, enabled)
  // Named once, here, so the heading and every subtitle agree about who "for
  // Sarah Kevol" refers to.
  const contextual = actions.filter(a => a.contextual)

  return (
    <div className="lg:hidden fixed inset-0 z-overlay" role="dialog" aria-modal="true" aria-label="Create">
      <button aria-label="Close" onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div ref={sheetRef}
        className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-bg-secondary border-t border-border p-4 pb-safe rise">
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">Create</p>
            {/* The sheet says what it is prefilled with. A + that quietly
                attaches the record you happen to be standing on, and never
                mentions it, is a surprise rather than a shortcut. */}
            {contextual.length > 0 && (
              <p className="text-[11px] text-ink-muted mt-0.5 truncate">{contextual[0].sub}</p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-11 h-11 -mr-2 flex items-center justify-center text-ink-muted hover:text-ink">
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 pb-2">
          {actions.map(a => {
            const Icon = ICONS[a.icon]
            return (
              <Link key={a.key} href={a.href} onClick={onClose}
                className={cn(
                  'flex items-center gap-3 rounded-xl border bg-bg p-3.5 min-h-[64px] active:scale-[0.98] transition-transform',
                  // A prefilled door is visibly different from a blank one, so a
                  // glance answers "will this remember the customer?".
                  a.contextual ? 'border-accent/40' : 'border-border',
                )}>
                <Icon className="w-5 h-5 text-accent shrink-0" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink leading-tight">{a.label}</span>
                  <span className="block text-[11px] text-ink-faint leading-tight mt-0.5 truncate">{a.sub}</span>
                </span>
              </Link>
            )
          })}
          {actions.length === 0 && (
            <p className="col-span-2 text-xs text-ink-faint p-2">
              Nothing to create here — the modules these doors open are turned off in Settings.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
