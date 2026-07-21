'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Settings, LogOut, Zap, LayoutTemplate, Menu, X, Search, LifeBuoy, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useModules } from '@/hooks/useModules'
import { useUnread } from '@/hooks/useUnread'
import { NotificationBell } from '@/components/notifications/NotificationBell'

// Everyday work up top; the analytics pages live behind one "Grow" hub
// (/dashboard/grow) so the sidebar stays short — fewer navigation decisions.
// The item list itself comes from THE feature-module registry (lib/modules) —
// filtered per business by business_settings.enabled_modules (null = all).

// Pages that live outside their hub's path still light up their parent nav item,
// so the sidebar always answers "where am I" — even on Grow's analytics leaves
// and the weather ops page (a Schedule tool).
const sectionOf: Record<string, string> = {
  '/dashboard/intelligence': '/dashboard/grow',
  '/dashboard/revenue-intelligence': '/dashboard/grow',
  '/dashboard/pricing-recovery': '/dashboard/grow',
  '/dashboard/profitability': '/dashboard/grow',
  '/dashboard/saturation': '/dashboard/grow',
  '/dashboard/neighbors': '/dashboard/grow',
  '/dashboard/reactivation': '/dashboard/grow',
  '/dashboard/review': '/dashboard/grow',
  '/dashboard/data-quality': '/dashboard/grow',
  '/dashboard/reports': '/dashboard/grow',
  '/dashboard/reports/scheduled': '/dashboard/grow',
  '/dashboard/routes': '/dashboard/grow',
  '/dashboard/measurements': '/dashboard/grow',
  '/dashboard/weather': '/dashboard/schedule',
}

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // The mobile drawer is a modal overlay — trap focus, move focus in on open,
  // Escape to close, and restore focus to the hamburger on close.
  const drawerRef = useFocusTrap<HTMLElement>(open, () => setOpen(false))
  const [brand, setBrand] = useState<{ url: string | null; scale: number; name: string | null }>({ url: null, scale: 100, name: null })
  // THE one unread engine (hooks/useUnread), shared with the mobile bottom nav
  // so the two badges can never disagree.
  const unread = useUnread()
  // Per-business module composition — ONE loader (useModules) shared with the
  // command palette and the Modules settings surface; live-updates on change.
  const { visible: navMain } = useModules()

  // Uploaded logo + size from Branding settings (cached for the login screen).
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const cached = window.localStorage.getItem('eq-logo')
        if (cached) { const c = JSON.parse(cached); if (active && (c?.url || c?.name)) setBrand({ url: c.url ?? null, scale: c.scale || 100, name: c.name ?? null }) }
      } catch { /* ignore */ }
      const supabase = createClient()
      // Local session read — the sidebar mounts on every page; no auth round-trip
      // before the logo query (it already painted from the localStorage cache above).
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) return
      const { data } = await supabase.from('business_settings').select('logo_url, logo_scale, company_name').eq('user_id', user.id).maybeSingle()
      const s = data as { logo_url: string | null; logo_scale: number | null; company_name: string | null } | null
      if (!active) return
      const next = { url: s?.logo_url ?? null, scale: s?.logo_scale && s.logo_scale >= 50 ? s.logo_scale : 100, name: s?.company_name?.trim() || null }
      setBrand(next)
      try { window.localStorage.setItem('eq-logo', JSON.stringify(next)) } catch { /* ignore */ }
    }
    load()
    return () => { active = false }
  }, [])


  // Tab-title badge: "(3) EdgeQuote …" while messages wait — the one attention cue
  // that works with the app open in a background tab, no permission needed.
  // Best-effort: a route change re-renders the title without the prefix, and the
  // next unread change re-applies it.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const bare = document.title.replace(/^\(\d+\+?\)\s/, '')
    document.title = unread > 0 ? `(${unread > 9 ? '9+' : unread}) ${bare}` : bare
  }, [unread])

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  // Open the global command palette (also reachable via Cmd/Ctrl+K anywhere).
  const openCommand = () => window.dispatchEvent(new Event('eq:command-open'))

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      active ? 'bg-accent/10 text-accent-text' : 'text-ink-muted hover:text-ink hover:bg-surface'
    )

  function navBody(onNavigate?: () => void) {
    return (
      <>
        <nav aria-label="Primary" className="flex-1 px-3 py-4 flex flex-col gap-0.5 overflow-y-auto">
          <button
            onClick={() => { onNavigate?.(); openCommand() }}
            className="flex items-center gap-3 px-3 py-2.5 mb-1 rounded-xl text-sm font-medium text-ink-muted bg-surface/60 border border-border hover:text-ink hover:bg-surface transition-all w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="hidden lg:inline text-[10px] font-semibold text-ink-faint border border-border rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
          {navMain.map(({ label, href, icon: Icon }) => {
            const section = Object.keys(sectionOf).find(p => pathname.startsWith(p))
            const active = href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(href) || (section != null && sectionOf[section] === href)
            const badge = label === 'Messages' && unread > 0 ? unread : 0
            return (
              <Link key={href} href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={linkClass(active)}>
                <Icon className="w-4 h-4" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                {badge > 0 && (
                  <span aria-label={`${badge} unread`} className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="px-3 py-4 border-t border-border flex flex-col gap-0.5">
          {/* Help sits with Settings, not in the work nav above — it's a place you go
              when something is confusing, not part of the daily loop. */}
          <Link href="/dashboard/help" onClick={onNavigate}
            aria-current={pathname === '/dashboard/help' ? 'page' : undefined}
            className={linkClass(pathname === '/dashboard/help')}>
            <LifeBuoy className="w-4 h-4" aria-hidden="true" />
            Help
          </Link>
          <Link href="/dashboard/settings" onClick={onNavigate}
            aria-current={pathname === '/dashboard/settings' ? 'page' : undefined}
            className={linkClass(pathname === '/dashboard/settings')}>
            <Settings className="w-4 h-4" aria-hidden="true" />
            Settings
          </Link>
          <Link href="/dashboard/settings/templates" onClick={onNavigate}
            aria-current={pathname === '/dashboard/settings/templates' ? 'page' : undefined}
            className={linkClass(pathname === '/dashboard/settings/templates')}>
            <LayoutTemplate className="w-4 h-4" aria-hidden="true" />
            Service Templates
          </Link>
          <button
            onClick={() => { onNavigate?.(); handleSignOut() }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-red-400 hover:bg-red-500/5 transition-all w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </>
    )
  }

  // Logo height scales with the Branding setting (base 32px at 100%).
  const logoPx = Math.round(32 * (brand.scale / 100))
  const logo = (
    <div className="flex items-center gap-2.5 min-w-0">
      {brand.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.url} alt="Logo" className="object-contain shrink-0"
          style={{ height: logoPx, maxHeight: 56, maxWidth: 160 }} />
      ) : (
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center shrink-0">
          <Zap className="w-4 h-4 text-black fill-black" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-bold text-ink leading-none truncate">EdgeQuote</p>
        {/* The OWNER's business name (Settings → Branding) — the platform never
            assumes whose business this is. Hidden until a name is set. */}
        {brand.name && <p className="text-[10px] text-ink-faint leading-none mt-0.5 truncate">{brand.name}</p>}
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between h-14 px-4 bg-bg-secondary border-b border-border">
        {logo}
        <div className="flex items-center gap-1.5">
          <button onClick={openCommand} className="text-ink-muted hover:text-ink p-2" aria-label="Search">
            <Search className="w-5 h-5" />
          </button>
          {/* Messages, one tap from anywhere on mobile — the unread count was
              previously invisible until the drawer was opened. */}
          <Link href="/dashboard/messages" aria-label={unread > 0 ? `Messages, ${unread} unread` : 'Messages'}
            className="relative text-ink-muted hover:text-ink p-2">
            <MessageSquare className="w-5 h-5" />
            {unread > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-0.5 rounded-full bg-accent text-black text-[9px] font-bold tabular-nums flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </Link>
          <NotificationBell />
          <button onClick={() => setOpen(true)} className="text-ink p-2 -mr-2" aria-label="Open menu">
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-overlay">
          <div className="absolute inset-0 bg-black/60 animate-fade" onClick={() => setOpen(false)} />
          <aside ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Menu" className="absolute left-0 top-0 h-full w-64 max-w-[80%] bg-bg-secondary border-r border-border flex flex-col animate-drawer focus:outline-none">
            <div className="h-14 flex items-center justify-between px-4 border-b border-border">
              {logo}
              <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink p-2 -mr-2" aria-label="Close menu">
                <X className="w-5 h-5" />
              </button>
            </div>
            {navBody(() => setOpen(false))}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside aria-label="Sidebar" className="hidden lg:flex w-60 shrink-0 h-screen sticky top-0 flex-col bg-bg-secondary border-r border-border">
        <div className="h-16 flex items-center justify-between gap-2 px-5 border-b border-border">
          {logo}
          <NotificationBell />
        </div>
        {navBody()}
      </aside>
    </>
  )
}