'use client'

import { HealthIssue } from '@/lib/scheduleHealth'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { ShieldCheck, ShieldAlert, AlertTriangle, Repeat, Eye, Trash2, GitMerge, EyeOff, CheckCircle2 } from 'lucide-react'

interface Props {
  issues: HealthIssue[]
  busyKey?: string | null
  onReview: (issue: HealthIssue) => void
  onDelete: (issue: HealthIssue) => void
  onMerge: (issue: HealthIssue) => void
  onIgnore: (issue: HealthIssue) => void
}

// Surfaces scheduling mistakes (duplicate / conflicting / overlapping visits)
// BEFORE they reach Day Ops, each with one-click fixes.
export function ScheduleHealthCard({ issues, busyKey, onReview, onDelete, onMerge, onIgnore }: Props) {
  const dup = issues.filter(i => i.kind === 'duplicate-day')
  const stops = dup.reduce((s, i) => s + i.removableJobIds.length, 0)
  const minutes = dup.reduce((s, i) => s + i.minutesSaved, 0)
  const allMow = dup.length > 0 && dup.every(i => i.isMow)
  const high = issues.filter(i => i.severity === 'high').length

  return (
    <Card className={cn(issues.length === 0 ? 'border-emerald-500/25' : high > 0 ? 'border-red-500/30' : 'border-amber-500/30')}>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          {issues.length === 0
            ? <ShieldCheck className="w-4 h-4 text-emerald-400" />
            : <ShieldAlert className={cn('w-4 h-4', high > 0 ? 'text-red-400' : 'text-amber-400')} />}
          <h2 className="text-sm font-semibold text-ink">Schedule Health</h2>
          {issues.length > 0 && (
            <span className={cn('ml-auto text-xs font-semibold rounded-full px-2 py-0.5 border',
              high > 0 ? 'text-red-400 bg-red-500/10 border-red-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20')}>
              {issues.length} issue{issues.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {issues.length === 0 ? (
          <p className="text-sm text-ink-muted flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> Your schedule looks healthy — no duplicate or conflicting visits.
          </p>
        ) : (
          <>
            {stops > 0 && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-ink-muted">
                Resolving {stops} duplicate {allMow ? 'mowing ' : ''}visit{stops !== 1 ? 's' : ''} would remove {stops} stop{stops !== 1 ? 's' : ''}
                {minutes > 0 && <> and save approximately <span className="font-semibold text-ink">{minutes} minutes</span></>}.
              </div>
            )}

            <div className="space-y-2">
              {issues.map(issue => {
                const busy = busyKey === issue.key
                return (
                  <div key={issue.key}
                    className={cn('rounded-xl border p-3', issue.severity === 'high' ? 'border-red-500/25 bg-red-500/5' : 'border-amber-500/25 bg-amber-500/5')}>
                    <div className="flex items-start gap-2.5">
                      {issue.kind === 'multiple-plans'
                        ? <Repeat className={cn('w-4 h-4 shrink-0 mt-0.5', issue.severity === 'high' ? 'text-red-400' : 'text-amber-400')} />
                        : <AlertTriangle className={cn('w-4 h-4 shrink-0 mt-0.5', issue.severity === 'high' ? 'text-red-400' : 'text-amber-400')} />}
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-sm font-semibold', issue.severity === 'high' ? 'text-red-300' : 'text-amber-300')}>{issue.title}</p>
                        <p className="text-xs text-ink-muted mt-0.5">{issue.detail}</p>
                        {issue.kind === 'duplicate-day' && issue.minutesSaved > 0 && (
                          <p className="text-[11px] text-ink-faint mt-0.5">Removing the duplicate frees ~{issue.minutesSaved} min that day.</p>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          {issue.actions.includes('review') && (
                            <Button size="sm" variant="secondary" onClick={() => onReview(issue)} disabled={busy}>
                              <Eye className="w-3.5 h-3.5" /> Review
                            </Button>
                          )}
                          {issue.actions.includes('delete') && (
                            <Button size="sm" variant="danger" onClick={() => onDelete(issue)} loading={busy}>
                              <Trash2 className="w-3.5 h-3.5" /> {issue.kind === 'duplicate-day' ? `Delete duplicate${issue.removableJobIds.length > 1 ? 's' : ''}` : 'Delete extra visit'}
                            </Button>
                          )}
                          {issue.actions.includes('merge') && (
                            <Button size="sm" variant="secondary" onClick={() => onMerge(issue)} loading={busy}>
                              <GitMerge className="w-3.5 h-3.5" /> Merge plans
                            </Button>
                          )}
                          {issue.actions.includes('ignore') && (
                            <Button size="sm" variant="secondary" onClick={() => onIgnore(issue)} disabled={busy}>
                              <EyeOff className="w-3.5 h-3.5" /> Ignore
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
