'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { LayoutDashboard, Users, FileText, Settings, LogOut, Zap, LayoutTemplate, Home, CalendarDays, Receipt, Menu, X, Sprout, MessageSquare, Ruler, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { NotificationBell } from '@/components/notifications/NotificationBell'

// Everyday work up top; the 7 analytics pages now live behind one "Grow" hub
// (/dashboard/grow) so the sidebar stays short — fewer navigation decisions.
const navMain = [
  { label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard },
  { label: 'Schedule',   href: '/dashboard/schedule',   icon: CalendarDays },
  { label: 'Customers',  href: '/dashboard/customers',  icon: Users },
  { label: 'Properties', href: '/dashboard/properties', icon: Home },
  { label: 'Measurements', href: '/dashboard/measurements', icon: Ruler },
  { label: 'Quotes',     href: '/dashboard/quotes',     icon: FileText },
  { label: 'Invoices',   href: '/dashboard/invoices',   icon: Receipt },
  { label: 'Messages',   href: '/dashboard/messages',   icon: MessageSquare },
  { label: 'Grow',       href: '/dashboard/grow',       icon: Sprout },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [brand, setBrand] = useState<{ url: string | null; scale: number }>({ url: null, scale: 100 })
  const [unread, setUnread] = useState(0)

  // Uploaded logo + size from Branding settings (cached for the login screen).
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const cached = window.localStorage.getItem('eq-logo')
        if (cached) { const c = JSON.parse(cached); if (active && c?.url) setBrand({ url: c.url, scale: c.scale || 100 }) }
      } catch { /* ignore */ }
      const supabase = createClient()
      // Local session read — the sidebar mounts on every page; no auth round-trip
      // before the logo query (it already painted from the localStorage cache above).
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) return
      const { data } = await supabase.from('business_settings').select('logo_url, logo_scale').eq('user_id', user.id).maybeSingle()
      const s = data as { logo_url: string | null; logo_scale: number | null } | null
      if (!active) return
      const next = { url: s?.logo_url ?? null, scale: s?.logo_scale && s.logo_scale >= 50 ? s.logo_scale : 100 }
      setBrand(next)
      try { window.localStorage.setItem('eq-logo', JSON.stringify(next)) } catch { /* ignore */ }
    }
    load()
    return () => { active = false }
  }, [])

  // Unread Messages badge — live. The sum of conversations.unread, kept in sync
  // through the SAME Realtime stream as the inbox, so the count updates app-wide
  // (on any page) without a refresh or navigation. RLS scopes the stream to us.
  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let active = true
    async function refresh(userId: string) {
      const { data } = await supabase.from('conversations').select('unread').eq('user_id', userId).gt('unread', 0)
      if (active) setUnread((data as { unread: number }[] | null)?.reduce((s, c) => s + (c.unread || 0), 0) || 0)
    }
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user || !active) return
      await refresh(user.id)
      channel = supabase
        .channel(`sidebar-unread:${user.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${user.id}` }, () => refresh(user.id))
        .subscribe()
    })()
    return () => { active = false; if (channel) supabase.removeChannel(channel) }
  }, [])

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
      active ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:text-ink hover:bg-surface'
    )

  function navBody(onNavigate?: () => void) {
    return (
      <>
        <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5 overflow-y-auto">
          <button
            onClick={() => { onNavigate?.(); openCommand() }}
            className="flex items-center gap-3 px-3 py-2.5 mb-1 rounded-xl text-sm font-medium text-ink-muted bg-surface/60 border border-border hover:text-ink hover:bg-surface transition-all w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="hidden lg:inline text-[10px] font-semibold text-ink-faint border border-border rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
          {navMain.map(({ label, href, icon: Icon }) => {
            const active = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
            const badge = label === 'Messages' && unread > 0 ? unread : 0
            return (
              <Link key={href} href={href} onClick={onNavigate} className={linkClass(active)}>
                <Icon className="w-4 h-4" />
                <span className="flex-1">{label}</span>
                {badge > 0 && (
                  <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>
        <div className="px-3 py-4 border-t border-border flex flex-col gap-0.5">
          <Link href="/dashboard/settings/templates" onClick={onNavigate}
            className={linkClass(pathname === '/dashboard/settings/templates')}>
            <LayoutTemplate className="w-4 h-4" />
            Service Templates
          </Link>
          <Link href="/dashboard/settings" onClick={onNavigate}
            className={linkClass(pathname === '/dashboard/settings')}>
            <Settings className="w-4 h-4" />
            Settings
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
        <p className="text-[10px] text-ink-faint leading-none mt-0.5 truncate">Edge Property Services</p>
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
          <NotificationBell />
          <button onClick={() => setOpen(true)} className="text-ink p-2 -mr-2" aria-label="Open menu">
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 max-w-[80%] bg-bg-secondary border-r border-border flex flex-col">
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
      <aside className="hidden lg:flex w-60 shrink-0 h-screen sticky top-0 flex-col bg-bg-secondary border-r border-border">
        <div className="h-16 flex items-center justify-between gap-2 px-5 border-b border-border">
          {logo}
          <NotificationBell />
        </div>
        {navBody()}
      </aside>
    </>
  )
}