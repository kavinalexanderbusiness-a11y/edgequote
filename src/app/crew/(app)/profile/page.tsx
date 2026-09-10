import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { loadCrewDay } from '@/lib/crewAccess'
import { CrewSignOut } from '@/components/crew/CrewSignOut'
import { localTodayISO } from '@/lib/utils'
import { User, Users, Building2, Phone, CalendarOff, ChevronRight } from 'lucide-react'

export const metadata = { title: 'Me — EdgeQuote' }

// ── Me ───────────────────────────────────────────────────────────────────────
// Identity and the way out. No profile editing, no settings, no HR: a worker
// needs to confirm the app knows who they are and which crew they are on, be
// able to phone the office, and sign out on a shared phone. That is V1.
export default async function CrewProfilePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Identity only — a failed read renders the em-dash fallbacks below rather
  // than an error screen; the header still shows who is signed in.
  const res = await loadCrewDay(supabase, localTodayISO())
  const day = res.kind === 'ok' ? res.day : null

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-ink">{day?.me?.name || 'You'}</h1>
        <p className="mt-0.5 text-xs text-ink-muted">{day?.me?.role || 'Crew'}{user?.email ? ` · ${user.email}` : ''}</p>
      </header>

      <dl className="rounded-card border border-border bg-bg-secondary divide-y divide-border">
        <Row icon={Building2} label="Business" value={day?.business?.name || '—'} />
        <Row icon={Users} label="Crew" value={day?.crew?.name || 'Not on a crew yet'} />
        <Row
          icon={User}
          label="Working with"
          value={day?.teammates.length ? day.teammates.map(t => t.name).join(', ') : 'Just you'}
        />
        {day?.business?.phone && (
          <div className="px-3.5 py-3 flex items-center gap-3">
            <Phone className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
            <dt className="text-xs text-ink-muted w-24 shrink-0">Office</dt>
            <dd className="min-w-0 flex-1 text-sm">
              <a href={`tel:${day.business.phone}`} className="font-medium text-accent-text underline-offset-2 hover:underline">
                {day.business.phone}
              </a>
            </dd>
          </div>
        )}
      </dl>

      <Link href="/crew/availability"
        className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3.5 py-3 min-h-[48px] hover:border-accent/40">
        <CalendarOff className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">My availability</span>
          <span className="block text-[11px] text-ink-muted">Your working days, and asking for time off</span>
        </span>
        <ChevronRight className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
      </Link>

      <p className="px-1 text-[11px] text-ink-faint">
        You see the visits assigned to your crew. Prices, invoices, customer records and company
        settings stay with the office.
      </p>

      <CrewSignOut />
    </div>
  )
}

function Row({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
  return (
    <div className="px-3.5 py-3 flex items-center gap-3">
      <Icon className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
      <dt className="text-xs text-ink-muted w-24 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm font-medium text-ink truncate">{value}</dd>
    </div>
  )
}
