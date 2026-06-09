'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { LayoutDashboard, Users, FileText, Settings, LogOut, Zap, LayoutTemplate, Home, CalendarDays, Navigation, Receipt, Menu, X, HeartPulse, BarChart3, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

// Operational pages first (everyday work), then insight dashboards.
const navMain = [
  { label: 'Dashboard',  href: '/dashboard',            icon: LayoutDashboard },
  { label: 'Schedule',   href: '/dashboard/schedule',   icon: CalendarDays },
  { label: 'Routes',     href: '/dashboard/routes',     icon: Navigation },
  { label: 'Customers',  href: '/dashboard/customers',  icon: Users },
  { label: 'Properties', href: '/dashboard/properties', icon: Home },
  { label: 'Quotes',     href: '/dashboard/quotes',     icon: FileText },
  { label: 'Invoices',   href: '/dashboard/invoices',   icon: Receipt },
]
const navInsights = [
  { label: 'Profitability',    href: '/dashboard/profitability',   icon: BarChart3 },
  { label: 'Pricing Recovery', href: '/dashboard/pricing-recovery', icon: Gauge },
  { label: 'Reactivation',     href: '/dashboard/reactivation',    icon: HeartPulse },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
      active ? 'bg-accent/10 text-accent' : 'text-ink-muted hover:text-ink hover:bg-surface'
    )

  function navBody(onNavigate?: () => void) {
    return (
      <>
        <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5 overflow-y-auto">
          {navMain.map(({ label, href, icon: Icon }) => {
            const active = href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href)
            return (
              <Link key={href} href={href} onClick={onNavigate} className={linkClass(active)}>
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            )
          })}
          <p className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Insights</p>
          {navInsights.map(({ label, href, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link key={href} href={href} onClick={onNavigate} className={linkClass(active)}>
                <Icon className="w-4 h-4" />
                {label}
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
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-red-400 hover:bg-red-500/5 transition-all w-full text-left"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </>
    )
  }

  const logo = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center">
        <Zap className="w-4 h-4 text-black fill-black" />
      </div>
      <div>
        <p className="text-sm font-bold text-ink leading-none">EdgeQuote</p>
        <p className="text-[10px] text-ink-faint leading-none mt-0.5">Edge Property Services</p>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between h-14 px-4 bg-bg-secondary border-b border-border">
        {logo}
        <button onClick={() => setOpen(true)} className="text-ink p-2 -mr-2" aria-label="Open menu">
          <Menu className="w-5 h-5" />
        </button>
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
        <div className="h-16 flex items-center px-5 border-b border-border">
          {logo}
        </div>
        {navBody()}
      </aside>
    </>
  )
}