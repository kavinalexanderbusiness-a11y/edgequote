'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useModules } from '@/hooks/useModules'
import { useUnread } from '@/hooks/useUnread'
import { QuickAdd } from '@/components/layout/QuickAdd'
import { quickAddActions } from '@/lib/quickAdd'
import {
  CalendarDays, FileText, MessageSquare, Plus, Users, type LucideIcon,
} from 'lucide-react'

// ── The thumb-zone shell ─────────────────────────────────────────────────────
// Mobile navigation used to be a hamburger at the TOP of the screen — the one
// place a thumb can't reach one-handed. This bar puts the four daily-driver
// destinations and THE create button where the thumb already rests. The
// drawer stays for the long tail; this is the fast path, not a replacement.
//
// Tabs ride THE module registry (useModules) — the same loader the sidebar,
// command palette and settings share — so hiding a module hides its tab and the
// four surfaces can never disagree about what's installed. The unread badge is
// THE one unread engine (useUnread), shared with the sidebar for the same
// reason.
//
// Ergonomics contract:
//   · every target ≥ 48px tall (touch), labels always visible (no icon-only
//     mystery meat), aria-current on the active tab
//   · pb-safe rides the iOS home-indicator inset (viewportFit: 'cover' is
//     already set app-wide)
//   · the quick sheet opens UPWARD from the bar — actions land under the thumb,
//     not at the top of the screen

interface TabDef {
  moduleKey: string   // registry key that must be visible for the tab to show
  href: string
  label: string
  icon: LucideIcon
}

// ── THE four field destinations ──────────────────────────────────────────────
// Measured, not copied from a pattern library. On the shipped bar (Home ·
// Schedule · + · Quotes · Messages) a customer lookup — the thing a ringing
// phone demands — had ZERO one-tap doors: the only paths were the hamburger at
// the TOP-RIGHT corner (the furthest point from a one-handed thumb) or a "+"
// entry called "Customers", i.e. navigation dressed as a create action.
//
// Customers takes the slot Home gave up. Nothing was lost doing it: the logo in
// the mobile top bar is now the Home link (the oldest convention on the web),
// and Home is still in the drawer. Quotes stays — it is a real daily
// destination, and its CREATE door is the first row of the + sheet.
const LEFT_TABS: TabDef[] = [
  { moduleKey: 'schedule', href: '/dashboard/schedule', label: 'Schedule', icon: CalendarDays },
  { moduleKey: 'customers', href: '/dashboard/customers', label: 'Customers', icon: Users },
]
const RIGHT_TABS: TabDef[] = [
  { moduleKey: 'quotes', href: '/dashboard/quotes', label: 'Quotes', icon: FileText },
  { moduleKey: 'messages', href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
]

export function BottomNav() {
  const pathname = usePathname()
  const { visible } = useModules()
  const unread = useUnread()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Belt and braces with QuickAdd's own pathname effect: this bar owns the open
  // state, so it must also let go of it when the route changes.
  useEffect(() => { setSheetOpen(false) }, [pathname])

  const enabled = new Set(visible.map(m => m.key))
  const show = (t: { moduleKey: string }) => enabled.has(t.moduleKey)
  const leftTabs = LEFT_TABS.filter(show)
  const rightTabs = RIGHT_TABS.filter(show)
  // Whether the + is worth showing at all is lib/quickAdd's call, not this
  // file's — it is the one place that knows what a surface can create.
  const canCreate = quickAddActions({ kind: 'none' }, enabled).length > 0

  // Active = exact for /dashboard (else it matches everything), prefix elsewhere.
  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)

  const tab = (t: TabDef) => {
    const active = isActive(t.href)
    return (
      <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex flex-col items-center justify-center gap-0.5 flex-1 min-h-[48px] rounded-lg transition-colors',
          active ? 'text-accent' : 'text-ink-muted hover:text-ink',
        )}>
        <t.icon className="w-5 h-5" aria-hidden />
        <span className="text-[10px] font-medium leading-none">{t.label}</span>
        {t.moduleKey === 'messages' && unread > 0 && (
          <span aria-label={`${unread} unread`}
            className="absolute top-1 right-[calc(50%-1.4rem)] min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Link>
    )
  }

  return (
    <>
      {/* THE quick-add sheet. It is a component, not markup here, because the
          rule "what can I create from this surface" belongs in one file that a
          guard can read (lib/quickAdd) rather than in the navigation. */}
      <QuickAdd open={sheetOpen} onClose={() => setSheetOpen(false)} enabled={enabled} />

      {/* data-eq-bottom-chrome: a field's dropdown must stop above this too, not
          only above a save bar (lib/dropdownPlacement). When a fixed save bar is
          mounted this nav is display:none — height 0 — and the rule skips it,
          which is exactly right. */}
      <nav aria-label="Primary" data-eq-bottom-chrome className="eq-bottom-nav lg:hidden fixed bottom-0 inset-x-0 z-40 bg-bg-secondary/95 backdrop-blur border-t border-border pb-safe">
        <div className="flex items-stretch px-1 pt-1 pb-1">
          {leftTabs.map(tab)}
          {/* Center action — visually raised so it reads as THE button. Hidden
              only if literally nothing is quick-actionable. */}
          {canCreate && (
            <div className="flex-1 flex items-center justify-center">
              <button onClick={() => setSheetOpen(o => !o)}
                aria-label="Create" aria-expanded={sheetOpen}
                className="w-12 h-12 -mt-4 rounded-full bg-accent text-black shadow-lg shadow-accent/30 flex items-center justify-center active:scale-95 transition-transform">
                <Plus className={cn('w-6 h-6 transition-transform', sheetOpen && 'rotate-45')} aria-hidden />
              </button>
            </div>
          )}
          {rightTabs.map(tab)}
        </div>
      </nav>
    </>
  )
}
