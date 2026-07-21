'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useModules } from '@/hooks/useModules'
import { useUnread } from '@/hooks/useUnread'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import {
  LayoutDashboard, CalendarDays, FileText, MessageSquare, Plus, X,
  Receipt, CreditCard, UserPlus, type LucideIcon,
} from 'lucide-react'

// ── The thumb-zone shell ─────────────────────────────────────────────────────
// Mobile navigation used to be a hamburger at the TOP of the screen — the one
// place a thumb can't reach one-handed. This bar puts the four daily-driver
// destinations and a quick-action button where the thumb already rests. The
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

// Left pair / right pair around the center action button.
const LEFT_TABS: TabDef[] = [
  { moduleKey: 'dashboard', href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { moduleKey: 'schedule', href: '/dashboard/schedule', label: 'Schedule', icon: CalendarDays },
]
const RIGHT_TABS: TabDef[] = [
  { moduleKey: 'quotes', href: '/dashboard/quotes', label: 'Quotes', icon: FileText },
  { moduleKey: 'messages', href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
]

// Quick actions: the workflows the owner starts 30× a day, one tap from
// anywhere. Routes only — no invented deep-link params; ?customer/?quote on
// invoices are the params that page actually reads.
const QUICK_ACTIONS: { moduleKey: string; href: string; label: string; sub: string; icon: LucideIcon }[] = [
  { moduleKey: 'quotes', href: '/dashboard/quotes/new', label: 'New quote', sub: 'Price a job', icon: FileText },
  { moduleKey: 'invoices', href: '/dashboard/invoices', label: 'Invoice', sub: 'Bill finished work', icon: Receipt },
  { moduleKey: 'payments', href: '/dashboard/payments', label: 'Collect payment', sub: 'Record or charge', icon: CreditCard },
  { moduleKey: 'customers', href: '/dashboard/customers', label: 'Customers', sub: 'Look up or add', icon: UserPlus },
]

export function BottomNav() {
  const pathname = usePathname()
  const { visible } = useModules()
  const unread = useUnread()
  const [sheetOpen, setSheetOpen] = useState(false)
  const sheetRef = useFocusTrap<HTMLDivElement>(sheetOpen, () => setSheetOpen(false))

  // Close the sheet on navigation — tapping an action must feel like GOING,
  // not like closing a dialog and then going.
  useEffect(() => { setSheetOpen(false) }, [pathname])

  const enabled = new Set(visible.map(m => m.key))
  const show = (t: { moduleKey: string }) => enabled.has(t.moduleKey)
  const leftTabs = LEFT_TABS.filter(show)
  const rightTabs = RIGHT_TABS.filter(show)
  const actions = QUICK_ACTIONS.filter(show)

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
            className="absolute top-1 right-[calc(50%-1.4rem)] min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-accent text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Link>
    )
  }

  return (
    <>
      {/* Quick-action sheet — opens UPWARD from the bar so every action is in
          thumb reach. Modal: focus-trapped, Escape/backdrop close. */}
      {sheetOpen && (
        <div className="lg:hidden fixed inset-0 z-overlay" role="dialog" aria-modal="true" aria-label="Quick actions">
          <button aria-label="Close quick actions" onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
          <div ref={sheetRef}
            className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-bg-secondary border-t border-border p-4 pb-safe rise">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">Quick actions</p>
              <button onClick={() => setSheetOpen(false)} aria-label="Close"
                className="w-11 h-11 -mr-2 flex items-center justify-center text-ink-muted hover:text-ink">
                <X className="w-5 h-5" aria-hidden />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 pb-2">
              {actions.map(a => (
                <Link key={a.label} href={a.href}
                  className="flex items-center gap-3 rounded-xl border border-border bg-bg p-3.5 min-h-[64px] active:scale-[0.98] transition-transform">
                  <a.icon className="w-5 h-5 text-accent shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink leading-tight">{a.label}</span>
                    <span className="block text-[11px] text-ink-faint leading-tight mt-0.5">{a.sub}</span>
                  </span>
                </Link>
              ))}
              {actions.length === 0 && (
                <p className="col-span-2 text-xs text-ink-faint p-2">No quick actions — the modules they start are turned off.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <nav aria-label="Primary" className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-bg-secondary/95 backdrop-blur border-t border-border pb-safe">
        <div className="flex items-stretch px-1 pt-1 pb-1">
          {leftTabs.map(tab)}
          {/* Center action — visually raised so it reads as THE button. Hidden
              only if literally nothing is quick-actionable. */}
          {actions.length > 0 && (
            <div className="flex-1 flex items-center justify-center">
              <button onClick={() => setSheetOpen(o => !o)}
                aria-label="Quick actions" aria-expanded={sheetOpen}
                className="w-12 h-12 -mt-4 rounded-full bg-accent text-white shadow-lg shadow-accent/30 flex items-center justify-center active:scale-95 transition-transform">
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
