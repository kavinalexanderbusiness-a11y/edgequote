'use client'

import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

// ── Shared anchored menu primitive ───────────────────────────────────────────
// A trigger-anchored dropdown that PORTALS to <body> (so it's never clipped by a
// parent's overflow:hidden), positions with position:fixed off the trigger's
// rect, flips above when there's no room below, and clamps to the viewport on all
// edges. Full keyboard nav (↑/↓/Home/End/Enter/Esc), hover/active states, and
// outside-click + scroll/resize reposition. Same look as the rest of the app's
// menus (rounded-xl border bg-bg-secondary shadow). Use via a render-prop trigger:
//
//   <Menu align="end" width={300} items={items}>
//     {({ toggle, open, triggerProps }) => (
//       <Button onClick={toggle} {...triggerProps}>New</Button>
//     )}
//   </Menu>

export interface MenuItem {
  key: string
  label: string
  description?: string
  icon?: LucideIcon
  onSelect: () => void
  disabled?: boolean
  danger?: boolean   // destructive item — red text/icon so danger is visible before hover
}

interface TriggerApi {
  open: boolean
  toggle: () => void
  triggerProps: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean }
}

interface MenuProps {
  items: MenuItem[]
  align?: 'start' | 'end'   // align the menu's left ('start') or right ('end') edge to the trigger
  width?: number            // desired width in px (clamped to the viewport)
  ariaLabel?: string
  className?: string        // applied to the inline-block anchor wrapper
  children: (api: TriggerApi) => ReactNode
}

const MARGIN = 8   // min gap from any viewport edge
const GAP = 6      // gap between trigger and menu

export function Menu({ items, align = 'start', width = 288, ariaLabel = 'Menu', className, children }: MenuProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null)
  const [active, setActive] = useState(-1)

  useEffect(() => setMounted(true), [])

  const close = useCallback(() => { setOpen(false); setActive(-1); setCoords(null) }, [])
  const toggle = useCallback(() => setOpen(o => !o), [])

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect()
    if (!a) return
    const vw = window.innerWidth, vh = window.innerHeight
    const w = Math.min(width, vw - MARGIN * 2)
    const h = menuRef.current?.offsetHeight ?? 0
    let left = align === 'end' ? a.right - w : a.left
    left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN)
    const below = a.bottom + GAP
    let top: number
    if (below + h + MARGIN <= vh || a.top < vh - a.bottom) top = below   // fits below, or more room below than above
    else top = Math.max(MARGIN, a.top - GAP - h)                          // flip above
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - h - MARGIN))
    setCoords({ top, left, width: w })
  }, [align, width])

  // Measure + position synchronously after the menu mounts (menuRef has height by now).
  useLayoutEffect(() => { if (open) place() }, [open, place])

  // Reposition while open; close on outside pointer / Escape.
  useEffect(() => {
    if (!open) return
    const onScrollResize = () => place()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return
      close()
    }
    window.addEventListener('resize', onScrollResize)
    window.addEventListener('scroll', onScrollResize, true)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('resize', onScrollResize)
      window.removeEventListener('scroll', onScrollResize, true)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, place, close])

  // Focus the first enabled item when opened (keyboard entry point).
  useEffect(() => {
    if (!open) return
    const first = items.findIndex(i => !i.disabled)
    setActive(first)
    if (first >= 0) requestAnimationFrame(() => itemRefs.current[first]?.focus())
  }, [open, items])

  // Keep DOM focus in sync with the active row.
  useEffect(() => { if (open && active >= 0) itemRefs.current[active]?.focus() }, [open, active])

  const move = (dir: 1 | -1) => {
    if (!items.length) return
    let i = active
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length
      if (!items[i].disabled) { setActive(i); return }
    }
  }
  const edge = (end: boolean) => {
    const order = end ? [...items.keys()].reverse() : [...items.keys()]
    const i = order.find(idx => !items[idx].disabled)
    if (i != null) setActive(i)
  }
  const select = (it: MenuItem) => { if (it.disabled) return; close(); anchorRef.current?.querySelector('button')?.focus(); it.onSelect() }

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break
      case 'ArrowUp': e.preventDefault(); move(-1); break
      case 'Home': e.preventDefault(); edge(false); break
      case 'End': e.preventDefault(); edge(true); break
      case 'Enter':
      case ' ': e.preventDefault(); if (active >= 0) select(items[active]); break
      case 'Escape': e.preventDefault(); close(); anchorRef.current?.querySelector('button')?.focus(); break
      case 'Tab': close(); break
    }
  }

  return (
    <div ref={anchorRef} className={cn('relative inline-block', className)}>
      {children({ open, toggle, triggerProps: { 'aria-haspopup': 'menu', 'aria-expanded': open } })}
      {mounted && open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onKeyDown}
          style={{
            position: 'fixed',
            top: coords?.top ?? -9999,
            left: coords?.left ?? -9999,
            width: coords?.width ?? width,
            maxHeight: 'calc(100vh - 16px)',
            visibility: coords ? 'visible' : 'hidden',
          }}
          className="z-[200] overflow-y-auto rounded-xl border border-border bg-bg-secondary shadow-2xl p-1.5 origin-top animate-pop">
          {items.map((it, i) => {
            const Icon = it.icon
            return (
              <button
                key={it.key}
                ref={el => { itemRefs.current[i] = el }}
                role="menuitem"
                tabIndex={-1}
                disabled={it.disabled}
                onClick={() => select(it)}
                onMouseEnter={() => !it.disabled && setActive(i)}
                className={cn(
                  'w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  it.danger
                    ? (i === active ? 'bg-red-500/10 text-red-400' : 'text-red-400/80 hover:bg-red-500/10 hover:text-red-400')
                    : (i === active ? 'bg-surface text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink'),
                  it.disabled && 'opacity-50 pointer-events-none',
                )}>
                {Icon && <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', it.danger ? 'text-red-400' : 'text-accent-text')} />}
                <span className="min-w-0">
                  <span className={cn('block text-sm font-medium', it.danger ? 'text-red-400' : 'text-ink')}>{it.label}</span>
                  {it.description && <span className="block text-[11px] text-ink-faint leading-snug line-clamp-2 mt-0.5">{it.description}</span>}
                </span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
