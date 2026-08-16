import Link from 'next/link'
import { CrewAvailability } from '@/components/crew/CrewAvailability'
import { ChevronLeft } from 'lucide-react'

export const metadata = { title: 'My availability — EdgeQuote' }

// ── My availability ──────────────────────────────────────────────────────────
// Reached from Me rather than the nav bar: four tabs is what fits a 375px phone
// comfortably, and this is a "set it and forget it" screen, not a daily one.
// Everything on it is about the person signed in — the RPCs behind it take no
// technician id, so a worker cannot reach anyone else's week.
export default function CrewAvailabilityPage() {
  return (
    <div className="space-y-3">
      <Link href="/crew/profile"
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink">
        <ChevronLeft className="w-3.5 h-3.5" aria-hidden /> Me
      </Link>
      <header>
        <h1 className="text-xl font-bold tracking-tight text-ink">My availability</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          The days you normally work, and any time off you’ve asked for.
        </p>
      </header>
      <CrewAvailability />
    </div>
  )
}
