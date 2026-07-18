'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { localTodayISO, formatCurrency } from '@/lib/utils'
import { loadAccountingData, type AccountingData } from '@/lib/accounting/data'
import { composeReport, REPORT_KINDS, type ReportKind, type ScheduledReport } from '@/lib/reports/schedule'
import { summarize } from '@/lib/reports/summary'
import { summaryRows, SUMMARY_COLUMNS, PAYMENT_COLUMNS, reportFilename } from '@/lib/reports/exports'
import { paymentsInPeriod } from '@/lib/accounting/report'
import { exportRowsToCsv } from '@/lib/csv'
import { downloadBlob } from '@/lib/portalPdf'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Tabs } from '@/components/ui/Tabs'
import { Toggle } from '@/components/ui/Toggle'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast } from '@/lib/toast'
import { FileDown, Download, Mail, AlertTriangle, Info, Calendar } from 'lucide-react'

// ── Scheduled reports ────────────────────────────────────────────────────────
// Pick a cadence, see EXACTLY what gets emailed, turn it on.
//
// The preview is not a mock-up of the email — it renders `summarize(report)`, the
// same function the cron sends and the PDF prints. So "what will I get?" is
// answered by showing the artefact itself rather than a description of it.
//
// Not one arithmetic operation in this file: every figure is read off the engine
// result via summarize(). `npm run verify:reports` asserts that property.

interface ScheduleRow {
  id: string
  kind: ReportKind
  enabled: boolean
  recipient: string | null
  last_sent_at: string | null
  last_period_to: string | null
  last_error: string | null
}

export default function ScheduledReportsPage() {
  const supabase = useMemo(() => createClient(), [])
  const todayISO = useMemo(() => localTodayISO(), [])

  const [data, setData] = useState<AccountingData | null>(null)
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)
  const [kind, setKind] = useState<ReportKind>('weekly')
  const [busy, setBusy] = useState<null | 'pdf' | 'csv' | 'payments'>(null)
  const [savingKind, setSavingKind] = useState<ReportKind | null>(null)

  const load = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) { setAuthError(true); setLoading(false); return }
    const [acct, sched] = await Promise.all([
      loadAccountingData(supabase, uid),
      supabase.from('report_schedules').select('id, kind, enabled, recipient, last_sent_at, last_period_to, last_error').eq('user_id', uid),
    ])
    setData(acct)
    setSchedules((sched.data ?? []) as ScheduleRow[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  // The report the owner is looking at is the CLOSED period — the one a schedule
  // would actually send. Previewing the period in progress would show a figure the
  // email will never contain.
  const report: ScheduledReport | null = useMemo(() => {
    if (!data) return null
    return composeReport(kind, todayISO, {
      payments: data.payments, expenses: data.expenses, settings: data.settings, errors: data.errors,
    }, { closed: true })
  }, [data, kind, todayISO])

  const s = report ? summarize(report) : null
  const scheduleFor = (k: ReportKind) => schedules.find(r => r.kind === k)
  const current = scheduleFor(kind)

  async function toggleSchedule(k: ReportKind, on: boolean) {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) return
    setSavingKind(k)
    // Upsert on (user_id, kind) — the UNIQUE constraint the migration adds is what
    // makes this safe to double-click.
    const { error } = await supabase
      .from('report_schedules')
      .upsert({ user_id: uid, kind: k, enabled: on }, { onConflict: 'user_id,kind' })
    setSavingKind(null)
    if (error) { toast.error(`Couldn’t save: ${error.message}`); return }
    toast.success(on ? `${REPORT_KINDS.find(r => r.value === k)?.label} report on` : 'Turned off')
    load()
  }

  async function saveRecipient(k: ReportKind, value: string) {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) return
    const recipient = value.trim() || null
    const { error } = await supabase
      .from('report_schedules')
      .upsert({ user_id: uid, kind: k, recipient }, { onConflict: 'user_id,kind' })
    if (error) { toast.error(`Couldn’t save: ${error.message}`); return }
    toast.success(recipient ? `Sending to ${recipient}` : 'Sending to your account email')
    load()
  }

  async function downloadPdf() {
    if (!report || !data) return
    setBusy('pdf')
    try {
      // Loaded on demand: @react-pdf/renderer is heavy, and a page you open to read
      // a number shouldn't pay for a renderer you might never click.
      const { renderReportBlob } = await import('@/components/reports/ScheduledReportPDF')
      downloadBlob(await renderReportBlob(report, data.settings), reportFilename(report, 'pdf'))
    } catch (e) {
      toast.error(`Couldn’t build the PDF: ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally { setBusy(null) }
  }

  function downloadSummaryCsv() {
    if (!report) return
    setBusy('csv')
    exportRowsToCsv(reportFilename(report, 'csv'), summaryRows(report), SUMMARY_COLUMNS)
    setBusy(null)
  }

  function downloadPaymentsCsv() {
    if (!report || !data) return
    setBusy('payments')
    // The rows BEHIND the figures — filtered by the engine's own period function,
    // never a hand-rolled date compare.
    const rows = paymentsInPeriod(data.payments, report.period)
    exportRowsToCsv(`payments-${report.kind}-${report.period.from}.csv`, rows, PAYMENT_COLUMNS)
    setBusy(null)
  }

  if (authError) {
    return (
      <div className="rise">
        <PageHeader title="Scheduled reports" description="Your money, on a schedule." crumb={{ label: 'Reports', href: '/dashboard/reports' }} />
        <Banner tone="danger" icon={AlertTriangle}>Session expired — sign in again.</Banner>
      </div>
    )
  }

  return (
    <div className="rise">
      <PageHeader
        title="Scheduled reports"
        description="Pick a cadence, see exactly what lands in your inbox, turn it on."
        crumb={{ label: 'Reports', href: '/dashboard/reports' }}
      />

      <Tabs
        tabs={REPORT_KINDS.map(r => ({ key: r.value, label: r.label }))}
        active={kind}
        onChange={k => setKind(k as ReportKind)}
        className="mb-4"
      />

      {loading ? (
        <><SkeletonTiles count={3} /><SkeletonRows count={5} className="mt-4" /></>
      ) : !report || !s ? null : (
        <div className="flex flex-col gap-4">
          {/* A failed query must never read as a quiet week. */}
          {!report.complete && (
            <Banner tone="warn" icon={AlertTriangle}>
              {s.warning} {report.errors.join('; ')}
            </Banner>
          )}

          {/* THE REPORT — the same lines the email and the PDF render. */}
          <Card>
            <CardBody>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold">{s.title}</h2>
                  <p className="text-sm text-muted mt-0.5">{s.subtitle}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={downloadPdf} loading={busy === 'pdf'}><FileDown className="w-4 h-4" />PDF</Button>
                  <Button variant="secondary" size="sm" onClick={downloadSummaryCsv} loading={busy === 'csv'}><Download className="w-4 h-4" />CSV</Button>
                </div>
              </div>

              <div className="mt-4 flex flex-col">
                {s.lines.map(l => (
                  <div key={l.label} className="flex items-start justify-between gap-4 py-2.5 border-b border-subtle last:border-0">
                    <div>
                      <div className="text-sm text-muted">{l.label}</div>
                      {l.note && <div className="text-xs text-faint mt-0.5">{l.note}</div>}
                    </div>
                    <div className="text-base font-semibold tabular-nums shrink-0">{l.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-faint flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  Cash-basis, {report.period.from} to {report.period.to} — the same figures as the Accounting statements for this period.
                </p>
                <Button variant="ghost" size="sm" onClick={downloadPaymentsCsv} loading={busy === 'payments'}>
                  <Download className="w-4 h-4" />Payments behind this ({paymentsInPeriod(data!.payments, report.period).length})
                </Button>
              </div>
            </CardBody>
          </Card>

          {/* THE SCHEDULE */}
          <Card>
            <CardBody>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h3 className="font-semibold flex items-center gap-2"><Mail className="w-4 h-4" /> Email this report</h3>
                  <p className="text-sm text-muted mt-0.5">
                    {REPORT_KINDS.find(r => r.value === kind)?.blurb}
                  </p>
                </div>
                <Toggle
                  checked={!!current?.enabled}
                  onChange={on => toggleSchedule(kind, on)}
                  disabled={savingKind === kind}
                  ariaLabel={`Email the ${kind} report`}
                />
              </div>

              {current?.enabled && (
                <div className="mt-4 flex flex-col gap-3">
                  <div>
                    <label className="text-xs text-muted mb-1 block">Send to</label>
                    <Input
                      type="email"
                      defaultValue={current.recipient ?? ''}
                      placeholder={data?.settings?.email_primary || 'your account email'}
                      onBlur={e => { if (e.target.value.trim() !== (current.recipient ?? '')) saveRecipient(kind, e.target.value) }}
                    />
                    <p className="text-xs text-faint mt-1">
                      {current.recipient
                        ? 'Overrides your account email for this report.'
                        : data?.settings?.email_primary
                          ? `Leave blank to use ${data.settings.email_primary}.`
                          : 'Add an email in Settings, or type one here — otherwise this report has nowhere to go.'}
                    </p>
                  </div>

                  {current.last_error && (
                    <Banner tone="warn" icon={AlertTriangle}>{current.last_error}</Banner>
                  )}

                  <p className="text-xs text-faint flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 shrink-0" />
                    {current.last_sent_at
                      ? `Last sent ${current.last_sent_at.slice(0, 10)}, covering the period ending ${current.last_period_to}.`
                      : 'Sends after the next period closes.'}
                  </p>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Every cadence at a glance, so "what am I subscribed to?" needs no clicking. */}
          <Card>
            <CardBody>
              <h3 className="font-semibold mb-3">All reports</h3>
              <div className="flex flex-col">
                {REPORT_KINDS.map(r => {
                  const row = scheduleFor(r.value)
                  return (
                    <div key={r.value} className="flex items-center justify-between gap-4 py-2.5 border-b border-subtle last:border-0">
                      <div>
                        <div className="text-sm font-medium">{r.label}</div>
                        <div className="text-xs text-faint">{r.blurb}</div>
                      </div>
                      <Toggle
                        checked={!!row?.enabled}
                        onChange={on => toggleSchedule(r.value, on)}
                        disabled={savingKind === r.value}
                        ariaLabel={`Email the ${r.value} report`}
                      />
                    </div>
                  )
                })}
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  )
}
