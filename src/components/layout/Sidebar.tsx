'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Users, FileText, Plus, Settings, LogOut, Zap, LayoutTemplate, Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const nav = [
  { label: 'Dashboard',  href: '/dashboard',              icon: LayoutDashboard },
  { label: 'Customers',  href: '/dashboard/customers',    icon: Users },
  { label: 'Properties', href: '/dashboard/properties',   icon: Home },
  { label: 'Quotes',     href: '/dashboard/quotes',       icon: FileText },
  { label: 'New Quote',  href: '/dashboard/quotes/new',   icon: Plus },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 flex flex-col bg-bg-secondary border-r border-border">
      {/* Logo */}
      <div className="h-16 flex items-center gap-2.5 px-5 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center">
          <Zap className="w-4 h-4 text-black fill-black" />
        </div>
        <div>
          <p className="text-sm font-bold text-ink leading-none">EdgeQuote</p>
          <p className="text-[10px] text-ink-faint leading-none mt-0.5">Edge Property Services</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5">
        {nav.map(({ label, href, icon: Icon }) => {
          const active = href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
                active
                  ? 'bg-accent/10 text-accent'
                  : 'text-ink-muted hover:text-ink hover:bg-surface'
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 py-4 border-t border-border flex flex-col gap-0.5">
        <Link
          href="/dashboard/settings/templates"
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
            pathname === '/dashboard/settings/templates'
              ? 'bg-accent/10 text-accent'
              : 'text-ink-muted hover:text-ink hover:bg-surface'
          )}
        >
          <LayoutTemplate className="w-4 h-4" />
          Service Templates
        </Link>
        <Link
          href="/dashboard/settings"
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all',
            pathname === '/dashboard/settings'
              ? 'bg-accent/10 text-accent'
              : 'text-ink-muted hover:text-ink hover:bg-surface'
          )}
        >
          <Settings className="w-4 h-4" />
          Settings
        </Link>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-red-400 hover:bg-red-500/5 transition-all w-full text-left"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  )
}