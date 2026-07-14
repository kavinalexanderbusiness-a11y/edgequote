'use client'

import { useEffect, useRef } from 'react'
import { X, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Modal ─────────────────────────────────────────────────────────────────────
// One dialog/overlay primitive to replace the ~11 bespoke `fixed inset-0`
// overlays scattered across the app (ScopeDialog, CommandPalette, the schedule
// modals, QuoteMeasure, JobPhotos lightbox, OptimizeSchedule, RainDelayCenter…),
// each of which re-implemented the backdrop, centering and close handling — and
// most of which skipped Escape, scroll-lock and aria-modal. Behaviour here:
// • backdrop click + Escape + the X button all close (when `dismissable`)
// • body scroll locked while open; restored on close
// • role="dialog" aria-modal, labelled by the title; panel takes focus on open
// • mobile bottom-sheet (items-end) → centered on sm+
interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  icon?: LucideIcon
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  dismissable?: boolean
  className?: string
  /** Cmd/Ctrl+Enter fires the dialog's primary action (mirrors Escape = close). */
  onSubmit?: () => void
}

const SIZES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

export function Modal({ open, onClose, title, icon: Icon, children, footer, size = 'md', dismissable = true, className, onSubmit }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissable) onClose()
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, dismissable, onClose, onSubmit])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4 animate-fade"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={e => e.stopPropagation()}
        className={cn(
          'w-full bg-surface border border-border-strong rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] focus:outline-none animate-panel',
          SIZES[size],
          className
        )}
      >
        {(title || dismissable) && (
          <div className="flex items-center gap-2 px-5 py-4 border-b border-border shrink-0">
            {Icon && <Icon className="w-4 h-4 text-accent shrink-0" />}
            {title && <h2 className="text-sm font-semibold text-ink min-w-0 truncate">{title}</h2>}
            {dismissable && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        <div className="overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-border shrink-0 flex items-center justify-end gap-2">{footer}</div>
        )}
      </div>
    </div>
  )
}
