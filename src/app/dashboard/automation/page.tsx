'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  Bot, Radar, ListChecks, Activity, AlertTriangle, Stethoscope, Gauge,
  CheckCircle2, XCircle, Clock, Info, RotateCw, Ban,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { FilterPill } from '@/components/ui/FilterPill'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { cn, localTodayISO } from '@/lib/utils'
import { toneSoft, type Tone } from '@/lib/tone'
import { AUTOMATION_RULES, ruleFor, rulesForSignal } from '@/lib/automation/rules'
import type { AutomationRule, RuleMode } from '@/lib/automation/types'
// The vocabulary this page and the subject timeline BOTH speak. Shared rather than
// copied: two screens over one ledger that label the same row differently are two
// answers to one question — see ./shared.
import {
  REASON_META, PayloadChips, SubjectLink, signalLabel,
  type Reason, type SignalRow, type RunRow,
} from './shared'
import { loadOwnerContext } from '@/lib/automation/owner'
import { SENT_STATES } from '@/lib/comms/delivery'
import { statusMeta, TONE_CLASS } from '@/lib/comms/logStatus'
import { resolveFollowUpPolicy, followUpsExhausted, type FollowUpPolicy } from '@/lib/followup'
import { resolveReminderPolicy, remindersExhausted, type ReminderPolicy, type RemindableInvoice } from '@/lib/payments/dunning'
import type { Quote } from '@/types'

// ── Automation Center ─────────────────────────────────────────────────────────
// The owner-facing READ surface over the automation engine. It is a window, not a
// control panel: it renders what the engine recorded and nothing else.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO:
//
//  1. IT NEVER RE-DERIVES A CONDITION. Every number comes from the engine's own
//     tables (`automation_signals`, `automation_runs`) or its own registry
//     (lib/automation/rules) — never from re-running a detector here. Re-deriving
//     is exactly how six screens once disagreed about who had churned; a read
//     surface that computes its own churn is a seventh.
//
//  2. IT NEVER WRITES. No insert/update/delete, no send path, and — the important
//     one — NO PROMOTION CONTROL. A rule's `mode` is code-defined in
//     lib/automation/rules.ts and reviewed as a change; offering a button here
//     would make this page a promotion path, which is the one thing the engine's
//     whole design (two independent gates, an empty DISPATCHERS map) exists to
//     prevent. `mode` renders as a Badge and stops there.
//
// The state you will actually see today: both tables are applied but EMPTY (the
// crons live on this branch and aren't deployed). Every section therefore has to
// explain WHY it is empty rather than show a zero that looks like a bug.

// ── Bounds ───────────────────────────────────────────────────────────────────
// PostgREST caps a response at 1000 rows and does NOT error — an unbounded select
// silently truncates, which has caused a real bug in this stack (the schedule
// page's furthest-future work simply vanished). Every query below is bounded, and
// where a cap could make a NUMBER wrong (not just a list short) the UI says so.
const LIST_ROWS = 500     // signals / runs viewers
const TREND_ROWS = 2000   // 14-day trend + today's tiles
const STATS_ROWS = 5000   // 30-day per-rule aggregates
const LOG_ROWS = 1000     // notification_log, 7d
const RETRY_ROWS = 200    // quotes / invoices mid-chase
// .in() lists ride the request URI — keep them short (same reason lib/crm/
// campaignStats chunks at 100; a long list overflows the URI and 414s).
const IN_CHUNK = 100

const TREND_DAYS = 14
const STATS_DAYS = 30
const LOG_DAYS = 7
const FRESH_WINDOW_HOURS = 48

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return format(d, 'yyyy-MM-dd')
}

// ── The engine's vocabulary, rendered ────────────────────────────────────────
// Presentation only. These maps put WORDS on values the engine defines; they never
// decide anything. Keying them off the engine's own unions means a new mode or a
// new suppression reason is a TYPE ERROR here rather than a silently unlabelled
// row (the same reason lib/comms/reach has no `default:` case).

const MODE_META: Record<RuleMode, { label: string; tone: Tone; hint: string }> = {
  // `suggest` is NOT an error and NOT an off state — it is the product working as
  // designed: the condition was real, the rule saw it, and nobody has granted it
  // authority to act. It reads as calm information (info), never as a fault.
  suggest: {
    label: 'Watching — not acting yet',
    tone: 'info',
    hint: 'The rule detects this condition and logs every evaluation. It has not been granted authority to act, so it sends nothing. This is the intended state.',
  },
  off: {
    label: 'Off',
    tone: 'neutral',
    hint: 'Deliberately disabled. The engine records the evaluation and stops there.',
  },
  auto: {
    label: 'Acting automatically',
    tone: 'success',
    hint: 'Granted authority to act, within the constraints listed here.',
  },
}

interface StatRow { rule_key: string; decision: string; suppressed_reason: Reason | null }
/** The cron heartbeat (automation_sweeps). ONLY the columns `authenticated` is granted:
 *  `owners`/`detected`/`written`/`ms` are global cross-tenant aggregates and are
 *  service-role-only by column grant — selecting one here would 403 the whole query,
 *  not just drop a field. */
interface SweepRow { job: string; ran_on: string; ran_at: string; ok: boolean; error: string | null }
interface LogRow {
  id: string
  status: string
  template: string
  channel: string
  detail: string | null
  created_at: string
}
interface QuoteRetryRow {
  id: string; quote_number: string; customer_name: string; status: string
  follow_up_count: number | null; last_followed_up_at: string | null
}
interface InvoiceRetryRow {
  id: string; invoice_number: string; customer_name: string; status: string
  reminder_count: number | null; last_reminded_at: string | null
}
interface CommsTest {
  enabled: { sms: boolean; email: boolean; push: boolean }
  vars: Record<string, boolean>
  twilioFrom: string | null
  resendFrom: string | null
  twilioCreds: { valid: boolean; detail: string } | null
  resendCreds: { valid: boolean; detail: string } | null
  recentSends: {
    windowHours: number
    error?: string
    total?: number
    byStatus?: Record<string, number>
    lastByTemplate?: Record<string, string>
    lastSendAt?: string | null
    truncated?: boolean
  }
  appUrl: string | null
}

const TABS: TabItem[] = [
  { key: 'overview', label: 'Overview', icon: Gauge },
  { key: 'rules', label: 'Rules', icon: ListChecks },
  { key: 'signals', label: 'Signals', icon: Radar },
  { key: 'runs', label: 'Runs', icon: Activity },
  { key: 'failures', label: 'Failures & retries', icon: AlertTriangle },
  { key: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
]

export default function AutomationPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('overview')

  const [signals, setSignals] = useState<SignalRow[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [trendSignals, setTrendSignals] = useState<{ detected_on: string }[]>([])
  const [trendRuns, setTrendRuns] = useState<{ evaluated_on: string; decision: string }[]>([])
  const [ruleStats, setRuleStats] = useState<StatRow[]>([])
  const [logs, setLogs] = useState<LogRow[]>([])
  const [quoteRetries, setQuoteRetries] = useState<QuoteRetryRow[]>([])
  const [invoiceRetries, setInvoiceRetries] = useState<InvoiceRetryRow[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [diag, setDiag] = useState<CommsTest | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  // Cron liveness comes from the jobs' own heartbeat, never inferred from this owner's
  // rows — see Liveness.
  const [signalSweep, setSignalSweep] = useState<SweepRow | null>(null)
  const [engineSweep, setEngineSweep] = useState<SweepRow | null>(null)
  // The caps the AUTOMATIC chasers actually enforce. Resolved from the owner's
  // business_settings.automations through the chasers' OWN resolvers — not the bare
  // FOLLOW_UP_MAX/REMINDER_MAX constants, because an owner who tuned their cadence
  // has a different real cap and a page that showed the default would be lying about
  // the number that matters ("1 of 2 used" when it is really "1 of 3").
  const [followUpPolicy, setFollowUpPolicy] = useState<FollowUpPolicy | null>(null)
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicy | null>(null)

  // Filters
  const [signalFilter, setSignalFilter] = useState<string>('all')
  const [decisionFilter, setDecisionFilter] = useState<string>('all')
  const [reasonFilter, setReasonFilter] = useState<string>('all')

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const uid = user.id

    const since14 = isoDaysAgo(TREND_DAYS - 1)
    const since30 = isoDaysAgo(STATS_DAYS - 1)
    const sinceLog = new Date(Date.now() - LOG_DAYS * 86_400_000).toISOString()

    const [sRes, rRes, tsRes, trRes, stRes, lRes, qRes, iRes, owner, diagRes, ssRes, esRes] = await Promise.all([
      // Newest first. `created_at` is the tiebreak: detected_on is a DATE, so dozens
      // of rows share one value and without it paging/ordering isn't deterministic.
      supabase.from('automation_signals')
        .select('id, signal, subject_type, subject_id, detected_on, payload, created_at')
        .eq('user_id', uid).order('detected_on', { ascending: false }).order('created_at', { ascending: false })
        .limit(LIST_ROWS),
      supabase.from('automation_runs')
        .select('id, rule_key, subject_type, subject_id, evaluated_on, decision, suppressed_reason, created_at')
        .eq('user_id', uid).order('evaluated_on', { ascending: false }).order('created_at', { ascending: false })
        .limit(LIST_ROWS),
      supabase.from('automation_signals').select('detected_on')
        .eq('user_id', uid).gte('detected_on', since14).order('detected_on', { ascending: false }).limit(TREND_ROWS),
      // `decision` rides along so today's `fired` tile costs no extra query.
      supabase.from('automation_runs').select('evaluated_on, decision')
        .eq('user_id', uid).gte('evaluated_on', since14).order('evaluated_on', { ascending: false }).limit(TREND_ROWS),
      supabase.from('automation_runs').select('rule_key, decision, suppressed_reason')
        .eq('user_id', uid).gte('evaluated_on', since30).order('evaluated_on', { ascending: false }).limit(STATS_ROWS),
      // ONE 7-day read serves both the 48h overview tiles and the 7d failure list.
      supabase.from('notification_log').select('id, status, template, channel, detail, created_at')
        .eq('user_id', uid).gte('created_at', sinceLog).order('created_at', { ascending: false }).limit(LOG_ROWS),
      supabase.from('quotes').select('id, quote_number, customer_name, status, follow_up_count, last_followed_up_at')
        .eq('user_id', uid).gt('follow_up_count', 0).order('last_followed_up_at', { ascending: false, nullsFirst: false })
        .limit(RETRY_ROWS),
      supabase.from('invoices').select('id, invoice_number, customer_name, status, reminder_count, last_reminded_at')
        .eq('user_id', uid).gt('reminder_count', 0).order('last_reminded_at', { ascending: false, nullsFirst: false })
        .limit(RETRY_ROWS),
      // THE shared per-owner settings read — same one every chaser cron uses.
      loadOwnerContext(supabase, uid),
      // Reuse the existing diagnostic endpoint rather than re-implementing the env /
      // credential checks. It validates Twilio + Resend WITHOUT sending.
      fetch('/api/comms/test').then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).catch((e: Error) => e),
      // The newest heartbeat per job. One query each rather than one ordered read
      // sliced by job: a job that stopped a month before the other would otherwise sit
      // outside any fixed row cap and read as "never ran" — the exact false claim this
      // table was added to retire. NOT filtered by user_id: the sweep is global, so a
      // per-owner liveness query was never a fact about the cron.
      supabase.from('automation_sweeps').select('job, ran_on, ran_at, ok, error')
        .eq('job', 'signals').order('ran_on', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('automation_sweeps').select('job, ran_on, ran_at, ok, error')
        .eq('job', 'engine').order('ran_on', { ascending: false }).limit(1).maybeSingle(),
    ])

    const sRows = (sRes.data as SignalRow[] | null) || []
    const rRows = (rRes.data as RunRow[] | null) || []
    setSignals(sRows)
    setRuns(rRows)
    setTrendSignals((tsRes.data as { detected_on: string }[] | null) || [])
    setTrendRuns((trRes.data as { evaluated_on: string; decision: string }[] | null) || [])
    setRuleStats((stRes.data as StatRow[] | null) || [])
    setLogs((lRes.data as LogRow[] | null) || [])
    setQuoteRetries((qRes.data as QuoteRetryRow[] | null) || [])
    setInvoiceRetries((iRes.data as InvoiceRetryRow[] | null) || [])
    setFollowUpPolicy(resolveFollowUpPolicy(owner.automationsRaw))
    setReminderPolicy(resolveReminderPolicy(owner.automationsRaw))
    setSignalSweep((ssRes.data as SweepRow | null) ?? null)
    setEngineSweep((esRes.data as SweepRow | null) ?? null)

    if (diagRes instanceof Error) setDiagError(diagRes.message)
    else setDiag(diagRes as CommsTest)

    // Subject → name in ONE batched query per chunk (never N+1). Chunked because a
    // long .in() list rides the request URI and 414s.
    const ids = Array.from(new Set([
      ...sRows.filter(s => s.subject_type === 'customer').map(s => s.subject_id),
      ...rRows.filter(r => r.subject_type === 'customer' && r.subject_id).map(r => r.subject_id as string),
    ]))
    if (ids.length) {
      const map: Record<string, string> = {}
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const { data } = await supabase.from('customers').select('id, name')
          .eq('user_id', uid).in('id', ids.slice(i, i + IN_CHUNK))
        for (const c of (data as { id: string; name: string }[] | null) || []) map[c.id] = c.name
      }
      setNames(map)
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const today = localTodayISO()

  // ── Overview aggregates ────────────────────────────────────────────────────
  const overview = useMemo(() => {
    const signalsToday = trendSignals.filter(s => s.detected_on === today).length
    const evalsToday = trendRuns.filter(r => r.evaluated_on === today).length
    const firedToday = trendRuns.filter(r => r.evaluated_on === today && r.decision === 'fired').length

    const cutoff = Date.now() - FRESH_WINDOW_HOURS * 3600_000
    const recent = logs.filter(l => new Date(l.created_at).getTime() >= cutoff)
    // "Sent" and "failed" come from the ONE status model (lib/comms/logStatus), not
    // a list spelled out here — so a status added there is counted correctly with no
    // change to this page.
    const sent48 = recent.filter(l => statusMeta(l.status).tone === 'ok').length
    const failed48 = recent.filter(l => statusMeta(l.status).tone === 'fail').length

    // 14-day trend, oldest → newest.
    const days: { day: string; signals: number; evals: number }[] = []
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const day = isoDaysAgo(i)
      days.push({
        day,
        signals: trendSignals.filter(s => s.detected_on === day).length,
        evals: trendRuns.filter(r => r.evaluated_on === day).length,
      })
    }
    return { signalsToday, evalsToday, firedToday, sent48, failed48, days }
  }, [trendSignals, trendRuns, logs, today])

  // Cron liveness is the HEARTBEAT's to answer, and only its. This used to be
  // `signals[0]?.detected_on` — the newest row THIS owner had — which conflated two
  // unrelated facts: a cron that never ran, and a cron that ran and correctly found
  // nothing. Zero rows is the plausible happy path here (two rules, narrow conditions),
  // so the page confidently reported "never run" on a healthy night, and would have
  // gone on doing so while the sweep was provably alive for everyone else.
  const neverRan = !loading && signalSweep === null && engineSweep === null

  // ── Per-rule stats (30d), straight off automation_runs ──────────────────────
  const statsByRule = useMemo(() => {
    const m: Record<string, { evals: number; fired: number; suppressed: number; reasons: Record<string, number> }> = {}
    for (const r of ruleStats) {
      const e = (m[r.rule_key] ||= { evals: 0, fired: 0, suppressed: 0, reasons: {} })
      e.evals++
      if (r.decision === 'fired') e.fired++
      else {
        e.suppressed++
        const k = r.suppressed_reason ?? 'unknown'
        e.reasons[k] = (e.reasons[k] || 0) + 1
      }
    }
    return m
  }, [ruleStats])

  const filteredSignals = useMemo(
    () => signalFilter === 'all' ? signals : signals.filter(s => s.signal === signalFilter),
    [signals, signalFilter],
  )
  const filteredRuns = useMemo(() => runs.filter(r =>
    (decisionFilter === 'all' || r.decision === decisionFilter) &&
    (reasonFilter === 'all' || r.suppressed_reason === reasonFilter),
  ), [runs, decisionFilter, reasonFilter])

  // Every signal key the registry watches, plus anything actually observed — so a
  // signal no rule consumes is still filterable rather than invisible.
  const signalKeys = useMemo(
    () => Array.from(new Set([...AUTOMATION_RULES.map(r => r.signal), ...signals.map(s => s.signal)])),
    [signals],
  )
  const reasonKeys = useMemo(
    () => Array.from(new Set(runs.map(r => r.suppressed_reason).filter((x): x is Reason => !!x))),
    [runs],
  )

  // ── Failures (7d) ──────────────────────────────────────────────────────────
  const failures = useMemo(() => logs.filter(l => statusMeta(l.status).tone === 'fail'), [logs])

  // Nothing of this owner's to show. Says NOTHING about whether the crons ran — that
  // is `neverRan` above, and keeping the two apart is the point: "it has never run" and
  // "it ran and found nothing" produce the identical empty screen and must not produce
  // the identical sentence.
  const nothingDetected = !loading && signals.length === 0 && runs.length === 0

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader title="Automation Center" description="What the automation engine saw, decided and did — and why it stayed quiet." />
        <SkeletonTiles count={5} />
        <SkeletonRows count={6} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Automation Center"
        description="What the automation engine saw, decided and did — and why it stayed quiet."
      />

      {/* The page's honest framing. Rules are code-defined and reviewed as a change;
          there is nothing to switch on here, and saying so is kinder than leaving
          people hunting for a toggle that shouldn't exist. */}
      <Banner tone="info" icon={Info}>
        This is a read-only window on the engine. Rules are defined in code and reviewed as a change —
        nothing on this page sends, changes or promotes anything.
      </Banner>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="space-y-6 animate-rise">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatTile label="Signals today" value={overview.signalsToday} icon={Radar}
              sub={`sweep ${sweepSub(signalSweep, today)}`} />
            <StatTile label="Evaluations today" value={overview.evalsToday} icon={Activity}
              sub={`engine ${sweepSub(engineSweep, today)}`} />
            {/* 0 is the CORRECT answer while every rule is `suggest`, so the tile says
                so rather than presenting a zero that reads as breakage. */}
            <StatTile label="Fired today" value={overview.firedToday} icon={CheckCircle2}
              tone={overview.firedToday > 0 ? 'success' : undefined}
              sub={overview.firedToday === 0 ? 'expected — every rule is watching only' : 'a rule acted'} />
            <StatTile label={`Messages sent (${FRESH_WINDOW_HOURS}h)`} value={overview.sent48} icon={CheckCircle2} />
            <StatTile label={`Failures (${FRESH_WINDOW_HOURS}h)`} value={overview.failed48} icon={XCircle}
              tone={overview.failed48 > 0 ? 'danger' : undefined} />
          </div>

          <Card>
            <CardHeader>
              <SectionHeading icon={Gauge} title={`Last ${TREND_DAYS} days`}
                sub="Signals detected and rule evaluations per day — straight from the engine's two tables." className="mb-0" />
            </CardHeader>
            <CardBody>
              {nothingDetected ? (
                <InlineEmpty icon={Radar}>
                  {neverRan
                    ? 'Nothing to chart — the signal sweep has never run, so there are no days to compare.'
                    : 'Nothing to chart — the sweep has been running and has found nothing to flag for your customers in this window.'}
                </InlineEmpty>
              ) : (
                <div className="space-y-5">
                  <TrendBars label="Signals detected" days={overview.days} pick={d => d.signals} tone="info" />
                  <TrendBars label="Rule evaluations" days={overview.days} pick={d => d.evals} tone="accent" />
                </div>
              )}
              {(trendSignals.length >= TREND_ROWS || trendRuns.length >= TREND_ROWS) && (
                <p className="text-[11px] text-amber-400 mt-4">
                  More than {TREND_ROWS.toLocaleString()} rows in this window — the trend shows the most recent and undercounts the oldest days.
                </p>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'rules' && (
        <div className="space-y-3 animate-rise">
          {AUTOMATION_RULES.map((rule, i) => (
            // The heartbeat, not `runs.length > 0` — this owner having no verdicts is
            // not evidence the engine never ran, and that was the wrong half of the
            // sentence to get from the right table.
            <RuleCard key={rule.key} rule={rule} stats={statsByRule[rule.key]} index={i}
              engineHasRun={engineSweep !== null} />
          ))}
          {ruleStats.length >= STATS_ROWS && (
            <p className="text-[11px] text-amber-400">
              More than {STATS_ROWS.toLocaleString()} evaluations in {STATS_DAYS} days — these counts are the most recent and undercount the oldest days.
            </p>
          )}
        </div>
      )}

      {tab === 'signals' && (
        <Card className="animate-rise">
          <CardHeader className="space-y-3">
            <SectionHeading icon={Radar} title="Detected signals"
              sub="What the nightly sweep found to be true. Rules read these — they never re-derive the condition." className="mb-0" />
            <div className="flex flex-wrap gap-1.5">
              <FilterPill active={signalFilter === 'all'} onClick={() => setSignalFilter('all')}>
                All ({signals.length})
              </FilterPill>
              {signalKeys.map(k => (
                <FilterPill key={k} active={signalFilter === k} onClick={() => setSignalFilter(k)}>
                  {signalLabel(k)} ({signals.filter(s => s.signal === k).length})
                </FilterPill>
              ))}
            </div>
          </CardHeader>
          {signals.length === 0 ? (
            // Two different facts, two different sentences. An owner with nothing wrong
            // and an owner whose sweep never ran both see zero rows here, and telling
            // the second story to the first owner is how day one teaches them to ignore
            // the one warning that matters.
            <EmptyState icon={Radar} title={neverRan ? 'The signal sweep hasn’t run yet' : 'Nothing to flag'}
              description={neverRan ? (
                <>
                  <code className="text-ink">automation_signals</code> is empty and no sweep has recorded a heartbeat. The nightly
                  sweep (<code className="text-ink">/api/cron/signals</code>) writes one row per condition, per customer, per day —
                  it hasn’t run yet, so there is nothing to show.
                </>
              ) : (
                <>
                  The sweep has been running{signalSweep ? ` — last on ${signalSweep.ran_on}` : ''} and has found nothing to flag.
                  Signals appear when a customer’s recurring work runs out or their visits drift past their usual cadence.
                  An empty table means neither is true right now.
                </>
              )} />
          ) : filteredSignals.length === 0 ? (
            <InlineEmpty icon={Radar}>No signals match this filter in the last {LIST_ROWS} rows.</InlineEmpty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr>
                    <Th>Signal</Th><Th>Subject</Th><Th>Detected</Th><Th>Detail</Th><Th>Watched by</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredSignals.map(s => {
                    // rulesForSignal — the registry answers which rules consume this
                    // signal. A signal nothing watches is worth seeing plainly.
                    const watchers = rulesForSignal(s.signal)
                    return (
                      <tr key={s.id} className={tableRowHover}>
                        <Td className="font-medium">{signalLabel(s.signal)}</Td>
                        {/* Through to this subject's whole timeline — what else was
                            detected about them, and what every rule decided. */}
                        <Td><SubjectLink type={s.subject_type} id={s.subject_id} names={names} /></Td>
                        <Td className="text-ink-muted tabular-nums whitespace-nowrap">{s.detected_on}</Td>
                        <Td><PayloadChips payload={s.payload} /></Td>
                        <Td className="text-xs text-ink-muted">
                          {watchers.length ? watchers.map(w => w.label).join(', ') : <span className="text-ink-faint">no rule watches this</span>}
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {signals.length >= LIST_ROWS && (
                <p className="text-[11px] text-ink-faint px-4 py-3">Showing the {LIST_ROWS} most recent signals.</p>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'runs' && (
        <Card className="animate-rise">
          <CardHeader className="space-y-3">
            <SectionHeading icon={Activity} title="Rule evaluations"
              sub="Every evaluation, fired or suppressed. The suppressed rows are the point — they are why the engine stayed quiet." className="mb-0" />
            <div className="flex flex-wrap gap-1.5">
              <FilterPill active={decisionFilter === 'all'} onClick={() => setDecisionFilter('all')}>All decisions</FilterPill>
              <FilterPill active={decisionFilter === 'fired'} onClick={() => setDecisionFilter('fired')}>
                Fired ({runs.filter(r => r.decision === 'fired').length})
              </FilterPill>
              <FilterPill active={decisionFilter === 'suppressed'} onClick={() => setDecisionFilter('suppressed')}>
                Suppressed ({runs.filter(r => r.decision === 'suppressed').length})
              </FilterPill>
            </div>
            {reasonKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <FilterPill active={reasonFilter === 'all'} onClick={() => setReasonFilter('all')}>All reasons</FilterPill>
                {reasonKeys.map(k => (
                  <FilterPill key={k} active={reasonFilter === k} onClick={() => setReasonFilter(k)}>
                    {REASON_META[k].label} ({runs.filter(r => r.suppressed_reason === k).length})
                  </FilterPill>
                ))}
              </div>
            )}
          </CardHeader>
          {runs.length === 0 ? (
            <EmptyState icon={Activity} title={neverRan ? 'The engine hasn’t run yet' : 'Nothing to evaluate'}
              description={neverRan ? (
                <>
                  <code className="text-ink">automation_runs</code> is empty and no run has recorded a heartbeat. The engine
                  (<code className="text-ink">/api/cron/engine</code>) reads each day’s signals and records a verdict per rule —
                  it hasn’t run yet.
                </>
              ) : (
                <>
                  The engine has been running{engineSweep ? ` — last on ${engineSweep.ran_on}` : ''} and has had no signals of yours
                  to evaluate. It records a verdict per rule per signal, and nothing has been detected for your customers — so an
                  empty run log is exactly right.
                </>
              )} />
          ) : filteredRuns.length === 0 ? (
            <InlineEmpty icon={Activity}>No evaluations match these filters in the last {LIST_ROWS} rows.</InlineEmpty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-border">
                  <tr><Th>Rule</Th><Th>Subject</Th><Th>Decision</Th><Th>Why</Th><Th>Evaluated</Th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredRuns.map(r => {
                    // ruleFor — the registry names the rule. A run whose rule_key is no
                    // longer registered still renders (as its raw key) instead of blank.
                    const rule = ruleFor(r.rule_key)
                    const reason = r.suppressed_reason ? REASON_META[r.suppressed_reason] : null
                    return (
                      <tr key={r.id} className={tableRowHover}>
                        <Td className="font-medium">
                          {rule?.label ?? <span className="text-ink-muted">{r.rule_key} <span className="text-ink-faint">(unregistered)</span></span>}
                        </Td>
                        {/* subject_id is nullable here (unlike automation_signals), so
                            SubjectLink renders the plain '—' rather than a dead link. */}
                        <Td><SubjectLink type={r.subject_type} id={r.subject_id} names={names} /></Td>
                        <Td>
                          {r.decision === 'fired'
                            ? <Badge tone="success" icon={CheckCircle2}>Fired</Badge>
                            : <Badge tone="neutral" icon={Clock}>Held</Badge>}
                        </Td>
                        <Td>
                          {reason
                            ? <span title={reason.hint}><Badge tone={reason.tone}>{reason.label}</Badge></span>
                            : <span className="text-xs text-ink-faint">—</span>}
                        </Td>
                        <Td className="text-ink-muted tabular-nums whitespace-nowrap">{r.evaluated_on}</Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {runs.length >= LIST_ROWS && (
                <p className="text-[11px] text-ink-faint px-4 py-3">Showing the {LIST_ROWS} most recent evaluations.</p>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'failures' && (
        <div className="space-y-6 animate-rise">
          <Card>
            <CardHeader>
              <SectionHeading icon={AlertTriangle} title={`Delivery failures — last ${LOG_DAYS} days`}
                sub="From notification_log. A send-time error never reached a provider and stays retryable; a provider failure is terminal." className="mb-0" />
            </CardHeader>
            {failures.length === 0 ? (
              <InlineEmpty icon={CheckCircle2}>
                {logs.length === 0
                  ? `Nothing has been sent in the last ${LOG_DAYS} days, so there is nothing that could have failed.`
                  : `No failures in the last ${LOG_DAYS} days — all ${logs.length} logged sends came back clean.`}
              </InlineEmpty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-border">
                    <tr><Th>Status</Th><Th>Retry</Th><Th>Template</Th><Th>Channel</Th><Th>Detail</Th><Th>When</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {failures.map(l => {
                      const meta = statusMeta(l.status)
                      const retryable = isRetryable(l.status)
                      return (
                        <tr key={l.id} className={tableRowHover}>
                          <Td>
                            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', TONE_CLASS[meta.tone])}>
                              <meta.Icon className="w-3 h-3" /> {meta.label}
                            </span>
                          </Td>
                          <Td>
                            {retryable
                              ? <Badge tone="warn" icon={RotateCw}>Will retry</Badge>
                              : <Badge tone="neutral" icon={Ban}>Terminal</Badge>}
                          </Td>
                          <Td className="text-ink-muted">{l.template}</Td>
                          <Td className="text-ink-muted">{l.channel}</Td>
                          {/* The provider's own words, verbatim. Deliberately NOT run
                              through describeSkip — that resolves SKIP reasons, and a
                              failure detail like "invalid phone number" would be
                              rewritten into "no phone on file", inventing a cause. */}
                          <Td className="text-xs text-ink-muted max-w-xs truncate" title={l.detail ?? ''}>{l.detail || '—'}</Td>
                          <Td className="text-ink-muted tabular-nums whitespace-nowrap">{format(new Date(l.created_at), 'MMM d, HH:mm')}</Td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {logs.length >= LOG_ROWS && (
                  <p className="text-[11px] text-amber-400 px-4 py-3">
                    More than {LOG_ROWS.toLocaleString()} log rows in {LOG_DAYS} days — older failures in this window aren’t shown.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader>
              <SectionHeading icon={RotateCw} title="Chases in progress"
                sub="How many automatic nudges each quote and invoice has used, against the cap the chaser actually enforces." className="mb-0" />
            </CardHeader>
            <CardBody className="space-y-5">
              <ChaseList
                title="Quotes chased"
                emptyText="No quote has been followed up yet — nothing has used a chase."
                rows={quoteRetries.map(q => ({
                  id: q.id,
                  label: q.customer_name || 'Unnamed',
                  sub: `${q.quote_number} · ${q.status}`,
                  count: q.follow_up_count ?? 0,
                  max: followUpPolicy?.maxCount ?? 0,
                  // The ENGINE decides exhaustion, not a `count >= max` retyped here.
                  // followUpsExhausted only reads follow_up_count; the cast keeps the
                  // call honest without selecting the whole Quote (the chaser cron
                  // casts the same way).
                  exhausted: followUpPolicy ? followUpsExhausted(q as unknown as Quote, followUpPolicy) : false,
                  at: q.last_followed_up_at,
                }))}
              />
              <ChaseList
                title="Invoices reminded"
                emptyText="No invoice has been reminded yet — nothing has used a reminder."
                rows={invoiceRetries.map(inv => ({
                  id: inv.id,
                  label: inv.customer_name || 'Unnamed',
                  sub: `${inv.invoice_number} · ${inv.status}`,
                  count: inv.reminder_count ?? 0,
                  max: reminderPolicy?.maxCount ?? 0,
                  // RemindableInvoice is exactly the shape the dunning engine asks for,
                  // so this needs no cast at all.
                  exhausted: reminderPolicy
                    ? remindersExhausted({ reminder_count: inv.reminder_count } as RemindableInvoice, reminderPolicy)
                    : false,
                  at: inv.last_reminded_at,
                }))}
              />
              <p className="text-[11px] text-ink-faint">
                Caps come from each chaser’s own policy resolver, so they reflect any cadence you’ve tuned in Settings —
                not a default written into this page.
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'diagnostics' && (
        <div className="space-y-6 animate-rise">
          {/* Cron liveness, stated only as far as the evidence goes. */}
          <Card>
            <CardHeader>
              <SectionHeading icon={Clock} title="Scheduled jobs"
                sub="Each job’s own heartbeat, written at every exit — success, partial or failure. This is the only honest proof they ran." className="mb-0" />
            </CardHeader>
            <CardBody className="space-y-3">
              <Liveness name="Signal sweep" path="/api/cron/signals" schedule="daily 11:00" sweep={signalSweep} today={today} />
              <Liveness name="Automation engine" path="/api/cron/engine" schedule="daily 11:30" sweep={engineSweep} today={today} />
              {neverRan && (
                <Banner tone="warn" icon={AlertTriangle}>
                  Neither job has recorded a heartbeat, so neither has ever run here. Every section on this page is
                  empty for that reason rather than because there was nothing to find.
                </Banner>
              )}
              {!neverRan && nothingDetected && (
                <Banner tone="info" icon={Info}>
                  The jobs are running. They just haven’t found anything to flag for your customers yet — which is the
                  healthy answer, not an empty screen waiting to fill.
                </Banner>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <SectionHeading icon={Stethoscope} title="Delivery configuration"
                sub="Live from /api/comms/test — it validates the Twilio and Resend credentials without sending anything." className="mb-0" />
            </CardHeader>
            <CardBody className="space-y-4">
              {diagError && <Banner tone="danger" icon={XCircle}>Could not reach the diagnostics endpoint — {diagError}</Banner>}
              {!diag && !diagError && <InlineEmpty icon={Stethoscope}>No diagnostics returned.</InlineEmpty>}
              {diag && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <StatTile label="SMS" value={diag.enabled.sms ? 'Configured' : 'Disabled'}
                      tone={diag.enabled.sms ? 'success' : 'neutral'} tonedSurface
                      sub={diag.twilioFrom ? `from ${diag.twilioFrom}` : 'no sending number set'} />
                    <StatTile label="Email" value={diag.enabled.email ? 'Configured' : 'Disabled'}
                      tone={diag.enabled.email ? 'success' : 'neutral'} tonedSurface
                      sub={diag.resendFrom ? `from ${diag.resendFrom}` : 'no sending address set'} />
                  </div>

                  {diag.twilioCreds && (
                    <Banner tone={diag.twilioCreds.valid ? 'success' : 'danger'} icon={diag.twilioCreds.valid ? CheckCircle2 : XCircle}>
                      <span className="font-semibold">Twilio:</span> {diag.twilioCreds.detail}
                    </Banner>
                  )}
                  {diag.resendCreds && (
                    <Banner tone={diag.resendCreds.valid ? 'success' : 'danger'} icon={diag.resendCreds.valid ? CheckCircle2 : XCircle}>
                      <span className="font-semibold">Resend:</span> {diag.resendCreds.detail}
                    </Banner>
                  )}

                  <div>
                    <SectionHeading eyebrow title="Environment" />
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(diag.vars).map(([k, present]) => (
                        <span key={k} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                          toneSoft[present ? 'success' : 'neutral'])}>
                          {present ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {k}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <SectionHeading eyebrow title={`What the senders actually did (${diag.recentSends.windowHours}h)`} />
                    {diag.recentSends.error ? (
                      // "Nothing sent" and "we couldn't look" are different answers, and
                      // the endpoint distinguishes them. Don't flatten that here.
                      <Banner tone="danger" icon={XCircle}>Could not read the send log — {diag.recentSends.error}</Banner>
                    ) : (diag.recentSends.total ?? 0) === 0 ? (
                      <InlineEmpty icon={Clock}>
                        Nothing has been sent in the last {diag.recentSends.windowHours} hours. The log was readable — it is genuinely empty.
                      </InlineEmpty>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(diag.recentSends.byStatus ?? {}).map(([status, n]) => {
                          const meta = statusMeta(status)
                          return (
                            <span key={status} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', TONE_CLASS[meta.tone])}>
                              <meta.Icon className="w-3 h-3" /> {meta.label} <span className="tabular-nums">{n}</span>
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {diag.recentSends.truncated && (
                      <p className="text-[11px] text-amber-400 mt-2">The window was busy enough to hit the scan cap — these counts are a floor, not a total.</p>
                    )}
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** 'error' is a SEND-TIME failure: it never reached a provider, which is exactly
 *  why lib/comms/delivery omits it from SENT_STATES — it must stay retryable.
 *  Everything IN SENT_STATES already went out (including 'failed' and 'bounced'),
 *  so retrying it would just spam. Derived from the engine's own constant rather
 *  than a hand-listed `status === 'error'`, so the two can never drift apart. */
function isRetryable(status: string): boolean {
  return !(SENT_STATES as readonly string[]).includes((status || '').toLowerCase())
}

/** The heartbeat in a few words, for a tile's sub-line. Four states, because the
 *  heartbeat can now distinguish them: no row at all, a run that failed, a run today,
 *  and a run on a day we can name. */
function sweepSub(sweep: SweepRow | null, today: string): string {
  if (!sweep) return 'has never run'
  if (!sweep.ok) return `last run failed (${sweep.ran_on})`
  return sweep.ran_on === today ? 'ran today' : `last ran ${sweep.ran_on}`
}

function TrendBars({ label, days, pick, tone }: {
  label: string
  days: { day: string; signals: number; evals: number }[]
  pick: (d: { day: string; signals: number; evals: number }) => number
  tone: Tone
}) {
  const max = Math.max(1, ...days.map(pick))
  const total = days.reduce((s, d) => s + pick(d), 0)
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
        <p className="text-xs text-ink-faint tabular-nums">{total} total</p>
      </div>
      <div className="flex items-end gap-1 h-16">
        {days.map(d => {
          const v = pick(d)
          return (
            <div key={d.day} className="flex-1 flex flex-col justify-end h-full" title={`${d.day} — ${v}`}>
              <div
                className={cn('w-full rounded-sm border', v === 0 ? 'bg-bg-tertiary border-border' : toneSoft[tone])}
                style={{ height: v === 0 ? 2 : `${Math.max(8, (v / max) * 100)}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-[10px] text-ink-faint tabular-nums">{days[0]?.day}</span>
        <span className="text-[10px] text-ink-faint tabular-nums">{days[days.length - 1]?.day}</span>
      </div>
    </div>
  )
}

function RuleCard({ rule, stats, index, engineHasRun }: {
  rule: AutomationRule
  stats?: { evals: number; fired: number; suppressed: number; reasons: Record<string, number> }
  index: number
  engineHasRun: boolean
}) {
  const mode = MODE_META[rule.mode]
  const [from, to] = rule.constraints.sendWindowHours
  const cap = rule.constraints.maxPerCustomerPer
  return (
    <Card className={cn('animate-rise', `stagger-${Math.min(index + 1, 6)}`)}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink tracking-tight">{rule.label}</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Watches <span className="text-ink">{signalLabel(rule.signal)}</span>
            {' · '}
            {rule.action.kind === 'notify' ? `notifies (${rule.action.notificationType})` : `messages (${rule.action.template})`}
          </p>
        </div>
        <span title={mode.hint} className="shrink-0">
          <Badge tone={mode.tone}>{mode.label}</Badge>
        </span>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-muted">{mode.hint}</p>

        <div>
          <SectionHeading eyebrow title="Guard rails" />
          <div className="flex flex-wrap gap-1.5">
            <Chip>Send window {from}:00–{to}:00</Chip>
            <Chip>Max {cap.count} per customer / {cap.days}d</Chip>
            <Chip>Max {rule.constraints.maxPerRun} per run</Chip>
            <Chip>{rule.holdMinutes > 0 ? `${rule.holdMinutes} min undo window` : 'No undo window'}</Chip>
          </div>
        </div>

        <div>
          <SectionHeading eyebrow title={`Last ${STATS_DAYS} days`} />
          {!stats ? (
            // A bare "0" here would read as "this rule is broken". Say which of the two
            // real causes it is instead.
            <InlineEmpty icon={Clock} className="py-4">
              {engineHasRun
                ? 'The engine has run, but no signal has matched this rule yet — so there was nothing to evaluate.'
                : 'The engine hasn’t run yet, so this rule has never been evaluated.'}
            </InlineEmpty>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Evaluations" value={stats.evals} />
                <StatTile label="Fired" value={stats.fired} tone={stats.fired > 0 ? 'success' : undefined} />
                <StatTile label="Suppressed" value={stats.suppressed} />
              </div>
              {stats.suppressed > 0 && (
                <div className="mt-3">
                  <SectionHeading eyebrow title="Why it stayed quiet" />
                  <div className="space-y-1.5">
                    {Object.entries(stats.reasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([key, n]) => {
                        const meta = REASON_META[key as Reason]
                        return (
                          <div key={key} className="flex items-center gap-2">
                            <span className="shrink-0" title={meta?.hint}>
                              <Badge tone={meta?.tone ?? 'neutral'}>{meta?.label ?? key}</Badge>
                            </span>
                            <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                              <div className={cn('h-full rounded-full', toneSoft[meta?.tone ?? 'neutral'])}
                                style={{ width: `${Math.round((n / stats.suppressed) * 100)}%` }} />
                            </div>
                            <span className="text-xs text-ink-muted tabular-nums shrink-0 w-14 text-right">
                              {n} · {Math.round((n / stats.suppressed) * 100)}%
                            </span>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted whitespace-nowrap">
      {children}
    </span>
  )
}

function Liveness({ name, path, schedule, sweep, today }: {
  name: string; path: string; schedule: string; sweep: SweepRow | null; today: string
}) {
  const ranToday = sweep?.ran_on === today
  const failed = sweep !== null && !sweep.ok
  // FOUR honest answers, where the evidence used to support none of them: the job
  // records a heartbeat at every exit, so its absence means it truly never ran, and
  // `ok=false` is a run that happened and broke — a state the old inference could not
  // see at all (a crashed sweep writes no signals, so it looked exactly like a quiet
  // healthy one). "Anything warmer than the evidence would be a claim" — the evidence
  // is now the job's own word for it.
  const tone: Tone = sweep === null ? 'warn' : failed ? 'danger' : ranToday ? 'success' : 'warn'
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{name}</p>
        <p className="text-xs text-ink-faint"><code>{path}</code> · {schedule}</p>
      </div>
      <div className="text-right min-w-0">
        <Badge tone={tone}>
          {sweep === null ? 'Never run' : failed ? `Ran and failed ${sweep.ran_on}` : ranToday ? 'Ran today' : `Last ran ${sweep.ran_on}`}
        </Badge>
        {failed && sweep.error && (
          <p className="text-[11px] text-red-400 mt-1 max-w-xs truncate" title={sweep.error}>{sweep.error}</p>
        )}
        {sweep !== null && !failed && !ranToday && (
          <p className="text-[11px] text-ink-faint mt-1">It hasn’t run today.</p>
        )}
        {sweep !== null && (
          <p className="text-[11px] text-ink-faint mt-1 tabular-nums">
            last heartbeat {format(new Date(sweep.ran_at), 'MMM d, HH:mm')}
          </p>
        )}
      </div>
    </div>
  )
}

function ChaseList({ title, rows, emptyText }: {
  title: string
  emptyText: string
  rows: { id: string; label: string; sub: string; count: number; max: number; exhausted: boolean; at: string | null }[]
}) {
  return (
    <div>
      <SectionHeading eyebrow title={`${title} (${rows.length})`} />
      {rows.length === 0 ? (
        <InlineEmpty icon={Clock} className="py-4">{emptyText}</InlineEmpty>
      ) : (
        <div className="rounded-card border border-border divide-y divide-border overflow-hidden">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-ink truncate">{r.label}</p>
                <p className="text-[11px] text-ink-faint truncate">{r.sub}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-ink-muted tabular-nums">
                  {r.count} of {r.max} {r.max === 1 ? 'chase' : 'chases'} used
                </span>
                {r.exhausted
                  ? <Badge tone="warn" icon={Ban}>Exhausted</Badge>
                  : <Badge tone="neutral">{r.max - r.count} left</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
