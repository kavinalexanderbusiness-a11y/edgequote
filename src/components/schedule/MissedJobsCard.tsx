'use client'

import type { Job } from '@/types'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn, formatDate } from '@/lib/utils'
import { dayDelta } from '@/lib/recurrence'
import { CalendarClock, AlertTriangle, ArrowRight, CheckCircle2, Pencil } from 'lucide-react'

// Past-due visits — a still-open job whose day has passed (see isMissed). The Day
// Ops board only renders the day being viewed, so a Saturday stop nobody worked was
// invisible on Monday: the dashboard's "Resolve missed jobs" row even points here,
// then lands on today with nothing to resolve. This card closes that loop — it
// surfaces the stranded visits and resolves each with the SAME handlers the rest of
// the board uses (Bring to today = the move engine, Complete = the completion +
// draft-invoice engine, Open = the edit form). No new status, no new engine.
interface Props {
  jobs: Job[]           // already filtered to isMissed, most-overdue first is nice-to-have
  today: string         // 'YYYY-MM-DD' — the SAME boundary isMissed was filtered on
  busyId?: string | null
  onBringToToday: (job: Job) => void
  onComplete: (job: Job) => void
  onOpen: (job: Job) => void
}

export function MissedJobsCard({ jobs, today, busyId, onBringToToday, onComplete, onOpen }: Props) {
  if (jobs.length === 0) return null
  // Worst first — the visit the customer has waited longest for is the one to fix.
  const ordered = [...jobs].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))

  return (
    <Card className="border-red-500/30">
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <h2 className="text-sm font-semibold tracking-tight text-ink">Past-due visits</h2>
          <span className="ml-auto text-xs font-semibold rounded-full px-2 py-0.5 border text-red-400 bg-red-500/10 border-red-500/20">
            {ordered.length} missed
          </span>
        </div>

        <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-ink-muted">
          {/* STATUS ONLY. `jobs` here is isMissed's output — date/status alone
              (still open, day already passed) — with no billing evidence and
              no recurrence check, so it can include a one-off visit with no
              cycle at all. The old copy claimed "never billed" and "the
              customer is a cycle behind" for every row, which is a claim
              about invoicing and recurrence this card's inputs cannot back —
              a false statement on some real jobs, not a rounding error. Say
              only what isMissed actually establishes. */}
          These visits are still open after their scheduled date. Bring one to today if it still needs doing, or mark it complete if the work is already done.
        </div>

        <div className="space-y-2">
          {ordered.map(job => {
            const overdue = dayDelta(job.scheduled_date, today)
            const busy = busyId === job.id
            return (
              <div key={job.id} className="rounded-xl border border-red-500/25 bg-red-500/5 p-3">
                <div className="flex items-start gap-2.5">
                  <CalendarClock className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-red-300 truncate">{job.customers?.name || job.title}</p>
                    <p className="text-xs text-ink-muted mt-0.5 tabular-nums">
                      {formatDate(job.scheduled_date)}
                      <span className="text-ink-faint"> · {overdue} day{overdue !== 1 ? 's' : ''} overdue</span>
                      {job.status === 'in_progress' && <span className="text-amber-400"> · started, not finished</span>}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <Button size="sm" onClick={() => onBringToToday(job)} disabled={busy}>
                        <ArrowRight className="w-3.5 h-3.5" /> Bring to today
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => onComplete(job)} loading={busy}>
                        <CheckCircle2 className="w-3.5 h-3.5" /> Complete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onOpen(job)} disabled={busy}>
                        <Pencil className="w-3.5 h-3.5" /> Open
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}
