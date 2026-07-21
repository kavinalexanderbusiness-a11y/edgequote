'use client'

import { useEffect, useId, useRef } from 'react'
import { X, LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUSABLE } from '@/hooks/useFocusTrap'

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
  // The element that had focus when the dialog opened, so we can return focus
  // there on close (a keyboard user isn't dumped at the top of the page).
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  // Callbacks live in refs so the effect's deps are only [open, dismissable]:
  // parents pass fresh arrow functions every render, and re-running this effect
  // mid-dialog (a realtime refresh re-rendering the parent) would re-steal focus
  // from whatever the user was typing in — cleanup refocuses the opener, setup
  // refocuses the panel, and the keystroke in between lands nowhere.
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit

  // Swipe-down-to-dismiss for the mobile bottom sheet. Driven ONLY from the grab
  // handle (a mobile-only strip, `sm:hidden`), never the scrollable body — so it
  // can't be confused with scrolling the content, the failure mode that makes
  // most sheet-drag implementations feel broken. The transform is applied
  // imperatively during the drag so a finger move doesn't cost a React render.
  const dragStart = useRef<number | null>(null)
  const dragDelta = useRef(0)

  function beginDrag(e: React.TouchEvent) {
    if (!dismissable || e.touches.length !== 1) return
    dragStart.current = e.touches[0].clientY
    dragDelta.current = 0
    if (panelRef.current) panelRef.current.style.transition = 'none'
  }
  function moveDrag(e: React.TouchEvent) {
    if (dragStart.current == null) return
    // Down only — clamp up-drags to 0 so the sheet can't be flung off the top.
    const dy = Math.max(0, e.touches[0].clientY - dragStart.current)
    dragDelta.current = dy
    if (panelRef.current) panelRef.current.style.transform = dy ? `translateY(${dy}px)` : ''
  }
  function endDrag() {
    if (dragStart.current == null) return
    const dy = dragDelta.current
    dragStart.current = null
    const panel = panelRef.current
    if (!panel) return
    // Past the threshold it's a dismiss; short of it, snap back to place.
    if (dy > 90) { onClose(); return }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    panel.style.transition = reduce ? 'none' : 'transform 0.2s ease'
    panel.style.transform = ''
  }

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissable) onCloseRef.current()
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmitRef.current) { e.preventDefault(); onSubmitRef.current() }
      else if (e.key === 'Tab') {
        // Focus trap: Tab/Shift+Tab wrap within the dialog so focus can never
        // land on the obscured background page behind the backdrop.
        const panel = panelRef.current
        if (!panel) return
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === panel)
        if (items.length === 0) { e.preventDefault(); panel.focus(); return }
        const first = items[0], last = items[items.length - 1]
        const activeEl = document.activeElement
        if (e.shiftKey && (activeEl === first || activeEl === panel)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      // Return focus to whatever opened the dialog (no-op if it's since gone).
      restoreRef.current?.focus?.()
    }
  }, [open, dismissable])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-overlay flex items-end sm:items-center justify-center bg-black/50 p-4 animate-fade"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? 'Dialog' : undefined}
        onClick={e => e.stopPropagation()}
        className={cn(
          'w-full bg-surface border border-border-strong rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] focus:outline-none animate-panel',
          SIZES[size],
          className
        )}
      >
        {/* Grab handle: the affordance AND the drag target, mobile-sheet only.
            `touch-none` stops the browser scrolling the page from a drag that
            starts here. Rendered whenever the sheet can be dismissed, even when
            there's no header. */}
        {dismissable && (
          <div
            className="sm:hidden flex justify-center pt-2.5 pb-1 shrink-0 touch-none cursor-grab active:cursor-grabbing"
            onTouchStart={beginDrag}
            onTouchMove={moveDrag}
            onTouchEnd={endDrag}
            aria-hidden="true"
          >
            <span className="h-1 w-9 rounded-full bg-border-strong" />
          </div>
        )}
        {(title || dismissable) && (
          <div className="flex items-center gap-2 px-5 py-4 border-b border-border shrink-0">
            {Icon && <Icon className="w-4 h-4 text-accent-text shrink-0" aria-hidden="true" />}
            {title && <h2 id={titleId} className="text-sm font-semibold text-ink min-w-0 truncate">{title}</h2>}
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
