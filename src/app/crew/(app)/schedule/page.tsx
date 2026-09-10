import { createClient } from '@/lib/supabase/server'
import { loadCrewUpcoming } from '@/lib/crewAccess'
import { CalendarDays, AlertTriangle } from 'lucide-react'
import { CrewWeekDay } from '@/components/crew/CrewWeekDay'

export const metadata = { title: 'Week — EdgeQuote' }

// ── The week ahead ───────────────────────────────────────────────────────────
// Server-rendered and deliberately thin: a count per day, so "am I working
// Saturday" is answered without loading seven days of stop detail onto a phone
// at the edge of coverage. Tapping a day is the next pass; the question this
// screen exists to answer is whether tomorrow is a surprise.
export default async function CrewSchedulePage() {
  const supabase = await createClient()
  const now = new Date()
  const fromISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const res = await loadCrewUpcoming(supabase, fromISO, 14)

  // Three outcomes, kept apart (the seam's rule): a failed READ renders as
  // "couldn't load" — never as an empty, believable calendar — and a revoked
  // account is told so plainly (the layout normally redirects first; this is
  // the honest answer if the page is reached anyway).
  if (res.kind === 'revoked') {
    return (
      <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className="w-4 h-4 text-amber-300" aria-hidden /> Your access has been turned off
        </p>
        <p className="mt-1 text-xs text-ink-muted">Your account is no longer active on this crew. Ask your manager to switch it back on.</p>
      </div>
    )
  }
  if (res.kind === 'error') {
    return (
      <div className="rounded-card border border-amber-500/30 bg-amber-500/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className="w-4 h-4 text-amber-300" aria-hidden /> Couldn’t load your week
        </p>
        <p className="mt-1 text-xs text-ink-muted">Check your signal and reload. Nothing here is out of date — nothing loaded.</p>
      </div>
    )
  }
  const days = res.days

  const byDate = new Map(days.map(d => [d.date, d]))
  // Today and tomorrow are ALWAYS shown, worked or not — "am I working today /
  // tomorrow" is the question this page exists for, and an absent row answers
  // it with silence a worker can't tell apart from "didn't load". Days further
  // out appear only when they hold work (fourteen rows of nothing is noise).
  const upcoming = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { iso, d, i, row: byDate.get(iso) }
  }).filter(x => x.row || x.i < 2)

  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-ink">Your next two weeks</h1>
        {/* The summary counts only days that HOLD work — today/tomorrow are
            pinned below for orientation even when empty, and an empty pinned
            day is not a workday. */}
        <p className="mt-0.5 text-xs text-ink-muted">
          {(() => {
            const worked = upcoming.filter(x => (x.row?.stops ?? 0) > 0)
            const totalStops = worked.reduce((s, x) => s + (x.row?.stops ?? 0), 0)
            return worked.length === 0 ? 'Nothing booked yet.' : `${totalStops} stops across ${worked.length} day${worked.length === 1 ? '' : 's'}`
          })()}
        </p>
      </header>

      {upcoming.every(x => (x.row?.stops ?? 0) === 0) && (
        <div className="rounded-card border border-border bg-bg-secondary p-4 text-center">
          <CalendarDays className="mx-auto w-6 h-6 text-ink-faint" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-ink">No work booked</p>
          <p className="mt-1 text-xs text-ink-muted">Nothing is assigned to your crew for the next two weeks.</p>
        </div>
      )}
      {(
        <ul className="space-y-2">
          {upcoming.map(({ iso, d, i, row }) => (
            <CrewWeekDay
              key={iso}
              iso={iso}
              relLabel={i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : null}
              weekday={d.toLocaleDateString(undefined, { weekday: 'short' })}
              dayNum={d.getDate()}
              stops={row?.stops ?? 0}
              doneCount={row?.done ?? 0}
              hours={Math.round(((row?.minutes ?? 0) / 60) * 10) / 10}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
