'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  Radar, Activity, CheckCircle2, Clock, Info, AlertTriangle, Unlink, History,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { ruleFor, rulesForSignal } from '@/lib/automation/rules'
import {
  REASON_META, PayloadChips, signalLabel, subjectName,
  type SignalRow, type RunRow,
} from '../../../shared'

// ── Subject timeline ─────────────────────────────────────────────────────────
// Everything the automation engine has ever seen and decided about ONE subject,
// as a causal chain: what was detected → which rules watched it → what each one
// decided, and why.
//
// The index page answers "what did the engine do?" across the book. It cannot
// answer "why has nothing happened for THIS customer?", because the two tables are
// listed side by side there and the link between them — automation_runs.signal_id
// — is never selected. Selecting it is the whole point of this view: it is the
// only place the ledger's own causality is rendered.
//
// The same two prohibitions as the index, for the same reasons:
//
//  1. IT NEVER RE-DERIVES. Nothing here imports a detector from lib/signals or
//     calls decide(). This page renders the RECORDED verdict — what the sweep
//     wrote and what the engine decided. A read surface that recomputes the
//     condition is just a seventh screen with its own opinion about who churned,
//     and it would disagree with the ledger it claims to be showing.
//
//  2. IT NEVER WRITES, and offers NO PROMOTION CONTROL. A rule's mode is
//     code-defined in lib/automation/rules.ts and reviewed as a change. Nothing on
//     this page sends, changes or promotes anything.

// The subject-scoped indexes applied on 2026-07-15 —
//   automation_signals_subject (user_id, subject_id, detected_on desc)
//   automation_runs_subject    (user_id, subject_id, evaluated_on desc)
// — are exactly the shape of the two queries below: equality on user_id +
// subject_id, ordered by the date descending. Keep them that way.
//
// PostgREST caps a response at 1000 rows and does NOT error — an unbounded select
// silently truncates, which has caused a real bug in this stack. 1000 is generous
// here: the unique indexes allow at most one signal per (signal, subject, day) and
// one run per (rule, subject, day), so with today's two detectors this is ~500 days
// of one subject's history. Unreachable in practice — but "unreachable" is not
// "impossible", and a truncated timeline would show a MISSING CAUSAL LINK as an
// unlinked run, so the UI says when it hit the cap rather than quietly lying.
const TIMELINE_ROWS = 1000

// subject_id is a uuid COLUMN. A hand-typed or stale URL segment that isn't one
// makes PostgREST reject the filter with a 400, which would surface as an empty
// timeline — "nothing ever happened here" — instead of "that isn't a subject".
// Those are very different answers, so the malformed case never reaches the query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The index page's RunRow plus the column that makes this view possible. */
interface TimelineRunRow extends RunRow {
  signal_id: string | null
}

export default function SubjectTimelinePage() {
  const params = useParams<{ type: string; id: string }>()
  const type = params.type
  const id = params.id
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [signals, setSignals] = useState<SignalRow[]>([])
  const [runs, setRuns] = useState<TimelineRunRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  // Cron liveness for THIS owner, read across all subjects. Without it an empty
  // timeline has two indistinguishable causes, and the honest answer differs:
  // "the sweep has never run" vs "the sweep runs nightly and has never found this
  // subject to be in a condition worth recording". The second is the product
  // working; the first is a deploy that hasn't happened.
  const [lastSweepOn, setLastSweepOn] = useState<string | null>(null)
  const [lastEngineOn, setLastEngineOn] = useState<string | null>(null)

  const validId = UUID_RE.test(id ?? '')

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user || !validId) { setLoading(false); return }
    const uid = user.id

    const [sRes, rRes, lsRes, leRes, cRes] = await Promise.all([
      supabase.from('automation_signals')
        .select('id, signal, subject_type, subject_id, detected_on, payload, created_at')
        .eq('user_id', uid).eq('subject_id', id).eq('subject_type', type)
        // `created_at` is the tiebreak: detected_on is a DATE, so rows share one
        // value and without it the order isn't deterministic.
        .order('detected_on', { ascending: false }).order('created_at', { ascending: false })
        .limit(TIMELINE_ROWS),
      // signal_id — the column the index page never selects, and the reason this
      // view exists. It is what turns two lists into one causal chain.
      supabase.from('automation_runs')
        .select('id, rule_key, signal_id, subject_type, subject_id, evaluated_on, decision, suppressed_reason, created_at')
        .eq('user_id', uid).eq('subject_id', id).eq('subject_type', type)
        .order('evaluated_on', { ascending: false }).order('created_at', { ascending: false })
        .limit(TIMELINE_ROWS),
      supabase.from('automation_signals').select('detected_on')
        .eq('user_id', uid).order('detected_on', { ascending: false }).limit(1),
      supabase.from('automation_runs').select('evaluated_on')
        .eq('user_id', uid).order('evaluated_on', { ascending: false }).limit(1),
      // There is NO foreign key from subject_id to customers, deliberately: the
      // ledger outlives the row it describes. So this is a best-effort lookup —
      // maybeSingle, because a missing subject is an EXPECTED state (the customer
      // was deleted; their automation history was not) and must render, not throw.
      type === 'customer'
        ? supabase.from('customers').select('id, name').eq('user_id', uid).eq('id', id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    setSignals((sRes.data as SignalRow[] | null) || [])
    setRuns((rRes.data as TimelineRunRow[] | null) || [])
    setLastSweepOn((lsRes.data as { detected_on: string }[] | null)?.[0]?.detected_on ?? null)
    setLastEngineOn((leRes.data as { evaluated_on: string }[] | null)?.[0]?.evaluated_on ?? null)

    const cust = cRes.data as { id: string; name: string } | null
    if (cust) setNames({ [cust.id]: cust.name })

    setLoading(false)
  }, [supabase, id, type, validId])

  useEffect(() => { load() }, [load])

  // ── The causal chain ───────────────────────────────────────────────────────
  const timeline = useMemo(() => {
    const signalById = new Map(signals.map(s => [s.id, s]))
    const runsBySignal = new Map<string, TimelineRunRow[]>()
    const unlinked: TimelineRunRow[] = []    // signal_id IS NULL — a real, permanent state
    const outOfWindow: TimelineRunRow[] = [] // links to a signal past our cap

    for (const r of runs) {
      if (r.signal_id && signalById.has(r.signal_id)) {
        const arr = runsBySignal.get(r.signal_id)
        if (arr) arr.push(r)
        else runsBySignal.set(r.signal_id, [r])
      } else if (r.signal_id) {
        // signal_id is non-null, so the FK guarantees the signal row still EXISTS —
        // we just didn't fetch it. The only way here is the cap above. That is a
        // fetch artifact, not a state of the ledger, so it must not be presented as
        // "the engine acted without a signal".
        outOfWindow.push(r)
      } else {
        // ON DELETE SET NULL: the signal row was removed and took the link with it.
        // The run is still true — it happened — so it renders. Dropping it would be
        // deleting history to make a layout tidy.
        unlinked.push(r)
      }
    }

    interface Day { day: string; signals: SignalRow[]; unlinked: TimelineRunRow[]; outOfWindow: TimelineRunRow[] }
    const days = new Map<string, Day>()
    const bucket = (day: string): Day => {
      let d = days.get(day)
      if (!d) { d = { day, signals: [], unlinked: [], outOfWindow: [] }; days.set(day, d) }
      return d
    }

    // A LINKED run is grouped under its SIGNAL's day, not its own — the chain is the
    // subject of this view, and splitting a signal from the run it caused across two
    // date headings would break the one thing the page is for. Where the two dates
    // differ, the run says so itself (see RunLine).
    for (const s of signals) bucket(s.detected_on).signals.push(s)
    for (const r of unlinked) bucket(r.evaluated_on).unlinked.push(r)
    for (const r of outOfWindow) bucket(r.evaluated_on).outOfWindow.push(r)

    // Every run lands in exactly one place and none is dropped: linked → under its
    // signal, everything else → an explicit orphan section for its own day.
    const ordered = Array.from(days.values()).sort((a, b) => b.day.localeCompare(a.day))

    const dates = [
      ...signals.map(s => s.detected_on),
      ...runs.map(r => r.evaluated_on),
    ].sort()

    return {
      days: ordered,
      runsBySignal,
      firstSeen: dates[0] ?? null,
      lastSeen: dates[dates.length - 1] ?? null,
      fired: runs.filter(r => r.decision === 'fired').length,
    }
  }, [signals, runs])

  const label = subjectName(type ?? null, id ?? null, names)
  const deletedSubject = !loading && validId && type === 'customer' && !names[id]
  const capped = signals.length >= TIMELINE_ROWS || runs.length >= TIMELINE_ROWS
  const nothingRecorded = !loading && signals.length === 0 && runs.length === 0
  const neverSwept = lastSweepOn === null && lastEngineOn === null

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader title="Subject timeline" crumb={{ label: 'Automation Center', href: '/dashboard/automation' }}
          description="Everything the engine has seen and decided about this subject." />
        <SkeletonTiles count={5} />
        <SkeletonRows count={6} />
      </div>
    )
  }

  if (!validId) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader title="Not a subject" crumb={{ label: 'Automation Center', href: '/dashboard/automation' }} />
        <EmptyState icon={AlertTriangle} title="That isn’t a subject the ledger could hold"
          description={
            <>
              <code className="text-ink">{id}</code> isn’t a valid id, so nothing was looked up. The engine records subjects as
              a type and a uuid — this link was probably typed or truncated by hand.
            </>
          }
          action={{ label: 'Back to Automation Center', href: '/dashboard/automation' }} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title={label}
        crumb={{ label: 'Automation Center', href: '/dashboard/automation' }}
        description="Everything the automation engine has seen and decided about this subject — and why it stayed quiet."
      />

      <Banner tone="info" icon={Info}>
        A read-only window on the engine’s ledger. Every row below is what the sweep recorded and what the engine decided —
        nothing here re-checks the condition, and nothing sends, changes or promotes anything.
      </Banner>

      {/* The ledger has no FK to the subject on purpose, so this is a normal end
          state, not corruption. Say so plainly — an operator who sees "Unknown
          customer" with no explanation reasonably assumes something is broken. */}
      {deletedSubject && (
        <Banner tone="warn" icon={AlertTriangle}>
          This customer no longer exists. Their automation history does — the ledger is kept independently of the record it
          describes, so what the engine saw and decided is still readable here.
        </Banner>
      )}

      {nothingRecorded ? (
        <EmptyState icon={Radar} title="The engine has never recorded anything about this subject"
          description={
            neverSwept ? (
              <>
                Neither <code className="text-ink">automation_signals</code> nor <code className="text-ink">automation_runs</code> has
                a single row for you yet — the nightly sweep (<code className="text-ink">/api/cron/signals</code>) and the engine
                (<code className="text-ink">/api/cron/engine</code>) haven’t run here. This subject isn’t being skipped; nothing has
                been swept at all. An empty table, not a failure.
              </>
            ) : (
              <>
                The sweep has run{lastSweepOn ? <> (last wrote <span className="tabular-nums">{lastSweepOn}</span>)</> : null} and this
                subject has never been in a condition worth recording — no ran-out series, no drift past cadence. Nothing to show
                is the right answer here, not a gap.
              </>
            )
          }
          action={{ label: 'Back to Automation Center', href: '/dashboard/automation' }} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatTile label="First seen" value={timeline.firstSeen ?? '—'} icon={History} />
            <StatTile label="Last seen" value={timeline.lastSeen ?? '—'} icon={Clock} />
            <StatTile label="Signals" value={signals.length} icon={Radar} />
            <StatTile label="Evaluations" value={runs.length} icon={Activity} />
            {/* 0 is the CORRECT answer while every rule is `suggest`, so the tile says
                so rather than showing a zero that reads as breakage. */}
            <StatTile label="Times fired" value={timeline.fired} icon={CheckCircle2}
              tone={timeline.fired > 0 ? 'success' : undefined}
              sub={timeline.fired === 0 ? 'expected — every rule is watching only' : 'a rule acted'} />
          </div>

          {capped && (
            <Banner tone="warn" icon={AlertTriangle}>
              This subject has more than {TIMELINE_ROWS.toLocaleString()} recorded rows — the timeline shows the most recent and the
              oldest are not loaded. An evaluation whose signal falls outside that window is listed under “evaluated against an
              earlier signal” rather than shown in its chain.
            </Banner>
          )}

          <Card>
            <CardHeader>
              <SectionHeading icon={History} title="Timeline"
                sub="Newest first. Under each detected signal are the rules that watched it and what each one decided."
                className="mb-0" />
            </CardHeader>
            <CardBody className="space-y-6">
              {timeline.days.map(day => (
                <div key={day.day}>
                  <div className="flex items-center gap-3 mb-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink tabular-nums">{day.day}</p>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  <div className="space-y-3">
                    {day.signals.map(s => {
                      const runsHere = timeline.runsBySignal.get(s.id) ?? []
                      // rulesForSignal — the REGISTRY answers which rules consume this
                      // signal. Compared against what actually ran, it distinguishes
                      // "no rule watches this" from "a rule watches it but the engine
                      // hasn't evaluated it yet" — two very different silences.
                      const watchers = rulesForSignal(s.signal)
                      return (
                        <div key={s.id} className="rounded-card border border-border overflow-hidden">
                          <div className="px-3 py-2.5 bg-surface space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone="info" icon={Radar}>Detected</Badge>
                              <span className="text-sm font-medium text-ink">{signalLabel(s.signal)}</span>
                            </div>
                            <PayloadChips payload={s.payload} />
                          </div>

                          <div className="divide-y divide-border">
                            {runsHere.map(r => <RunLine key={r.id} run={r} signalDate={s.detected_on} />)}
                            {runsHere.length === 0 && (
                              <p className="px-3 py-2.5 text-xs text-ink-faint">
                                {watchers.length === 0
                                  ? 'No rule watches this signal — it was recorded and nothing consumed it.'
                                  : `${watchers.map(w => w.label).join(', ')} watches this, but the engine has recorded no evaluation against it.`}
                              </p>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* ON DELETE SET NULL makes this a real state of the ledger, not a
                        bug — the run happened, its signal was later removed. It renders
                        under its own evaluation date because there is no signal date to
                        borrow. */}
                    {day.unlinked.length > 0 && (
                      <div className="rounded-card border border-border border-dashed overflow-hidden">
                        <div className="px-3 py-2 bg-surface flex flex-wrap items-center gap-2">
                          <Badge tone="neutral" icon={Unlink}>Not linked to a signal</Badge>
                          <span className="text-[11px] text-ink-faint">
                            The engine recorded no signal for these, or the signal has since been deleted — the evaluation stands either way.
                          </span>
                        </div>
                        <div className="divide-y divide-border">
                          {day.unlinked.map(r => <RunLine key={r.id} run={r} />)}
                        </div>
                      </div>
                    )}

                    {/* Distinct from the above ON PURPOSE. The FK guarantees a non-null
                        signal_id still points at a live row, so this is our cap hiding
                        it — a limit of the fetch, not a missing link. Collapsing the two
                        would tell an operator the engine acted with no signal, which
                        would be a lie about their data. */}
                    {day.outOfWindow.length > 0 && (
                      <div className="rounded-card border border-border border-dashed overflow-hidden">
                        <div className="px-3 py-2 bg-surface flex flex-wrap items-center gap-2">
                          <Badge tone="warn" icon={Unlink}>Evaluated against an earlier signal</Badge>
                          <span className="text-[11px] text-ink-faint">
                            The signal exists but falls outside the {TIMELINE_ROWS.toLocaleString()} rows loaded here, so its chain isn’t shown.
                          </span>
                        </div>
                        <div className="divide-y divide-border">
                          {day.outOfWindow.map(r => <RunLine key={r.id} run={r} />)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

/** One recorded evaluation. Renders the verdict the engine WROTE — this never
 *  re-runs decide(); a page that recomputed the decision could contradict the run
 *  log it is supposed to be showing. */
function RunLine({ run, signalDate }: { run: TimelineRunRow; signalDate?: string }) {
  // ruleFor — the registry names the rule. A run whose rule_key is no longer
  // registered still renders (as its raw key) instead of blank: the evaluation
  // happened, and a rule deleted from code doesn't un-happen it.
  const rule = ruleFor(run.rule_key)
  const reason = run.suppressed_reason ? REASON_META[run.suppressed_reason] : null
  // The engine runs 30 minutes after the sweep, so same-day is the norm. When it
  // isn't, the gap is the interesting part — an evaluation against a stale signal —
  // and it is only visible because both dates are in the ledger.
  const lagged = signalDate != null && run.evaluated_on !== signalDate

  return (
    <div className="px-3 py-2.5 flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink flex-1 min-w-0 truncate">
        {rule?.label ?? <span className="text-ink-muted">{run.rule_key} <span className="text-ink-faint">(unregistered)</span></span>}
      </span>
      {run.decision === 'fired'
        ? <Badge tone="success" icon={CheckCircle2}>Fired</Badge>
        : <Badge tone="neutral" icon={Clock}>Held</Badge>}
      {reason && <span title={reason.hint}><Badge tone={reason.tone}>{reason.label}</Badge></span>}
      {lagged && (
        <span className="text-[11px] text-ink-faint tabular-nums whitespace-nowrap" title="The engine evaluated this on a later day than the signal was detected.">
          evaluated {run.evaluated_on}
        </span>
      )}
    </div>
  )
}
