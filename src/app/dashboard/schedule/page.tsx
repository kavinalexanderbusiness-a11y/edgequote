'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, Job, JobFormValues, Quote, RecurrenceScope } from '@/types'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { JobForm, Recurrence, SuggestionMeta } from '@/components/schedule/JobForm'
import { ScopeDialog } from '@/components/schedule/ScopeDialog'
import { generateOccurrences, jobsInScope, shiftDate, dayDelta, recurrenceLabel } from '@/lib/recurrence'
import type { JobRecurrence } from '@/types'
import { createDraftInvoiceForCompletedJob } from '@/lib/invoicing'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { format, addMonths, addWeeks, addDays, subMonths, subWeeks, subDays } from 'date-fns'
import { Plus, X, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type PendingAction =
  | { type: 'edit'; job: Job; values: JobFormValues }
  | { type: 'move'; job: Job; newDate: string }
  | { type: 'delete'; job: Job }

export default function SchedulePage() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()
  const quoteId = searchParams.get('quote')
  const customerParam = searchParams.get('customer')

  const [jobs, setJobs] = useState<Job[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<CalendarView>(() =>
    typeof window !== 'undefined' && window.innerWidth < 1024 ? 'day' : 'month'
  )
  const [cursor, setCursor] = useState(new Date())
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [formDate, setFormDate] = useState<string>('')
  const [moveMode, setMoveMode] = useState(false)
  const [movingJob, setMovingJob] = useState<Job | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [recurrenceLabels, setRecurrenceLabels] = useState<Record<string, string>>({})

  // When arriving from an accepted quote (?quote=…), open a prefilled new-job form.
  const [quoteCtx, setQuoteCtx] = useState<Quote | null>(null)
  const [quotePrefill, setQuotePrefill] = useState<Partial<JobFormValues> | null>(null)
  // When arriving from a customer (?customer=…), open a new-job form for them.
  const [customerPrefill, setCustomerPrefill] = useState<Partial<JobFormValues> | null>(null)

  const fetchJobs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, cRes, rRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*, customers(id, name, phone), properties(id, address, lat, lng)')
        .eq('user_id', user!.id)
        .order('scheduled_date'),
      supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
      supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
    ])
    setJobs((jRes.data as Job[]) || [])
    setCustomers((cRes.data as Customer[]) || [])
    const labels: Record<string, string> = {}
    for (const r of (rRes.data as JobRecurrence[]) || []) {
      labels[r.id] = recurrenceLabel(r.interval_unit, r.interval_count, r.freq)
    }
    setRecurrenceLabels(labels)
    setLoading(false)
  }, [supabase])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  useEffect(() => {
    if (!quoteId) return
    let active = true
    async function loadQuote() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: q } = await supabase.from('quotes').select('*').eq('id', quoteId).eq('user_id', user!.id).single()
      if (!q || !active) return
      let propertyId: string | null = q.property_id
      if (!propertyId && q.customer_id) {
        const { data: props } = await supabase
          .from('properties').select('id').eq('customer_id', q.customer_id)
          .order('is_primary', { ascending: false }).limit(1)
        if (props && props.length > 0) propertyId = props[0].id
      }
      if (!active) return
      setQuoteCtx(q as Quote)
      setQuotePrefill({
        customer_id: q.customer_id || '',
        property_id: propertyId || '',
        title: `${q.service_type} — ${q.customer_name}`,
        service_type: q.service_type,
        scheduled_date: localToday(),
        duration_minutes: Math.round(Number(q.hours) * 60),
        crew_size: q.crew_size,
        status: 'scheduled',
        notes: q.notes || '',
      })
      setEditing(null)
      setShowForm(true)
    }
    loadQuote()
    return () => { active = false }
  }, [quoteId, supabase])

  useEffect(() => {
    if (!customerParam || quoteId) return
    setEditing(null)
    setQuotePrefill(null)
    setCustomerPrefill({ customer_id: customerParam, scheduled_date: localToday() })
    setShowForm(true)
  }, [customerParam, quoteId])

  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setFormDate('')
    if (quoteCtx || customerPrefill) {
      setQuoteCtx(null)
      setQuotePrefill(null)
      setCustomerPrefill(null)
      router.replace('/dashboard/schedule')
    }
  }

  async function handleAdd(values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta) {
    const { data: { user } } = await supabase.auth.getUser()
    const base = {
      user_id: user!.id,
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      quote_id: quoteCtx?.id ?? null,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: values.status,
      notes: values.notes || null,
      actual_minutes: values.actual_minutes ? Number(values.actual_minutes) : null,
      suggested_date: meta?.suggestedDate ?? null,
      suggested_nearby_count: meta?.suggestedNearby ?? null,
    }

    if (!recurrence.unit) {
      const { error } = await supabase.from('jobs').insert({ ...base, scheduled_date: values.scheduled_date, recurrence_id: null })
      if (error) { setBanner('Could not save the job: ' + error.message); return }
    } else {
      // Keep legacy `freq` populated where the interval maps to an old value.
      const legacyFreq =
        recurrence.unit === 'week' && recurrence.count === 1 ? 'weekly'
        : recurrence.unit === 'week' && recurrence.count === 2 ? 'biweekly'
        : recurrence.unit === 'month' && recurrence.count === 1 ? 'monthly'
        : null
      const { data: rec, error: recError } = await supabase
        .from('job_recurrences')
        .insert({
          user_id: user!.id,
          freq: legacyFreq,
          interval_unit: recurrence.unit,
          interval_count: recurrence.count,
          start_date: values.scheduled_date,
          end_date: recurrence.endDate,
          end_count: recurrence.endCount,
          customer_id: values.customer_id || null,
        })
        .select()
        .single()
      if (recError) { setBanner('Could not save the recurrence: ' + recError.message); return }
      const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
      const rows = dates.map((d: string) => ({ ...base, scheduled_date: d, recurrence_id: rec?.id ?? null }))
      const { error } = await supabase.from('jobs').insert(rows)
      if (error) { setBanner('Could not save the jobs: ' + error.message); return }
    }

    if (quoteCtx && quoteCtx.status === 'accepted') {
      await supabase.from('quotes').update({ status: 'scheduled' }).eq('id', quoteCtx.id)
    }

    await fetchJobs()
    closeForm()
  }

  // Apply field edits (and a date shift for future/all) across a recurrence scope.
  async function applyEdit(job: Job, values: JobFormValues, scope: RecurrenceScope) {
    // Fields that propagate across the chosen recurrence scope.
    const fields = {
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      notes: values.notes || null,
    }
    // Per-visit outcome — status and actual time belong ONLY to the visit being
    // edited, never stamped across siblings (that would fabricate actuals).
    const perVisit = {
      status: values.status,
      actual_minutes: values.actual_minutes ? Number(values.actual_minutes) : null,
    }
    const targets = jobsInScope(job, jobs, scope)
    const delta = dayDelta(job.scheduled_date, values.scheduled_date)
    const results = await Promise.all(targets.map(t => supabase.from('jobs').update({
      ...fields,
      ...(t.id === job.id ? perVisit : {}),
      scheduled_date: scope === 'this' ? values.scheduled_date : shiftDate(t.scheduled_date, delta),
    }).eq('id', t.id)))
    const failed = results.find(r => r.error)
    if (failed?.error) setBanner('Could not save the job: ' + failed.error.message)

    // Completing a recurring visit auto-creates a draft invoice for that visit.
    if (values.status === 'completed' && job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Draft invoice ${res.invoiceNumber} created from the completed visit — review it in Invoices.`)
      else if (res.reason === 'exists') setBanner('That visit already has an invoice.')
    }

    await fetchJobs()
    setEditing(null)
  }

  async function applyMove(job: Job, newDate: string, scope: RecurrenceScope) {
    const delta = dayDelta(job.scheduled_date, newDate)
    const targets = jobsInScope(job, jobs, scope)
    await Promise.all(targets.map(t =>
      supabase.from('jobs').update({ scheduled_date: shiftDate(t.scheduled_date, delta) }).eq('id', t.id)
    ))
    await fetchJobs()
  }

  async function applyDelete(job: Job, scope: RecurrenceScope) {
    const targets = jobsInScope(job, jobs, scope)
    await supabase.from('jobs').delete().in('id', targets.map(t => t.id))
    if (scope === 'all' && job.recurrence_id) {
      await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    }
    await fetchJobs()
    setEditing(null)
  }

  async function handleEdit(values: JobFormValues) {
    if (!editing) return
    if (editing.recurrence_id) {
      setPendingAction({ type: 'edit', job: editing, values })
      return
    }
    await applyEdit(editing, values, 'this')
  }

  async function handleDelete() {
    if (!editing) return
    if (editing.recurrence_id) {
      setPendingAction({ type: 'delete', job: editing })
      return
    }
    await supabase.from('jobs').delete().eq('id', editing.id)
    await fetchJobs()
    setEditing(null)
  }

  async function moveJobToDate(job: Job, date: Date) {
    const newDate = format(date, 'yyyy-MM-dd')
    if (newDate === job.scheduled_date) { setMovingJob(null); return }
    setMovingJob(null)
    if (job.recurrence_id) {
      setPendingAction({ type: 'move', job, newDate })
      return
    }
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: newDate } : j))
    await supabase.from('jobs').update({ scheduled_date: newDate }).eq('id', job.id)
  }

  async function handleScopeChoice(scope: RecurrenceScope) {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.type === 'edit') await applyEdit(action.job, action.values, scope)
    else if (action.type === 'move') await applyMove(action.job, action.newDate, scope)
    else if (action.type === 'delete') await applyDelete(action.job, scope)
  }

  function handleDayTap(day: Date) {
    if (moveMode) {
      if (movingJob) moveJobToDate(movingJob, day)
      return
    }
    openNewJob(day)
  }

  function handleJobTap(job: Job) {
    if (moveMode) {
      setMovingJob(prev => prev?.id === job.id ? null : job)
      return
    }
    setEditing(job)
    setShowForm(false)
  }

  function navigate(dir: 1 | -1) {
    if (view === 'month') setCursor(c => dir === 1 ? addMonths(c, 1) : subMonths(c, 1))
    else if (view === 'week') setCursor(c => dir === 1 ? addWeeks(c, 1) : subWeeks(c, 1))
    else setCursor(c => dir === 1 ? addDays(c, 1) : subDays(c, 1))
  }

  function openNewJob(date: Date) {
    setEditing(null)
    setFormDate(format(date, 'yyyy-MM-dd'))
    setShowForm(true)
  }

  const headingLabel =
    view === 'month' ? format(cursor, 'MMMM yyyy')
    : view === 'week' ? `Week of ${format(cursor, 'MMM d, yyyy')}`
    : format(cursor, 'MMMM d, yyyy')

  const viewButtons: CalendarView[] = ['month', 'week', 'day']

  const pendingVerb = pendingAction?.type === 'delete' ? 'Delete'
    : pendingAction?.type === 'move' ? 'Move' : 'Save changes to'

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="Schedule"
        description={`${jobs.length} job${jobs.length !== 1 ? 's' : ''} on the calendar`}
        action={
          <Button onClick={() => openNewJob(new Date())}>
            <Plus className="w-4 h-4" /> Add Job
          </Button>
        }
      />

      {quoteCtx && (
        <div className="text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          Scheduling from accepted quote <span className="font-semibold">{quoteCtx.quote_number}</span> — pick a date and set recurrence below.
        </div>
      )}

      {banner && (
        <div className="flex items-center justify-between gap-3 text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          <span>{banner}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => router.push('/dashboard/invoices')} className="underline font-medium">Invoices</button>
            <button onClick={() => setBanner(null)} className="text-ink-faint hover:text-ink">✕</button>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="secondary" size="sm" onClick={() => navigate(1)}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <span className="text-sm font-semibold text-ink ml-2">{headingLabel}</span>
        </div>
        <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-xl p-1">
          {viewButtons.map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition-all',
                view === v ? 'bg-accent text-black' : 'text-ink-muted hover:text-ink'
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <Button
          variant={moveMode ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => { setMoveMode(m => !m); setMovingJob(null) }}
        >
          {moveMode ? 'Done Moving' : 'Move Jobs'}
        </Button>
      </div>

      {/* Form */}
      {(showForm || editing) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit Job' : 'New Job'}</h2>
            <div className="flex items-center gap-2">
              {editing && (
                <button onClick={handleDelete} className="text-ink-faint hover:text-red-400 transition-colors" title="Delete job">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button onClick={closeForm} className="text-ink-faint hover:text-ink transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </CardHeader>
          <CardBody>
            <JobForm
              customers={customers}
              excludeJobId={editing?.id}
              defaultValues={editing ? {
                customer_id: editing.customer_id || '',
                property_id: editing.property_id || '',
                title: editing.title,
                service_type: editing.service_type || '',
                scheduled_date: editing.scheduled_date,
                start_time: editing.start_time || '',
                end_time: editing.end_time || '',
                duration_minutes: editing.duration_minutes || 60,
                crew_size: editing.crew_size,
                status: editing.status,
                notes: editing.notes || '',
                actual_minutes: editing.actual_minutes || 0,
              } : (quotePrefill ?? customerPrefill ?? { scheduled_date: formDate })}
              onSubmit={editing ? handleEdit : handleAdd}
              onCancel={closeForm}
              isEdit={!!editing}
            />
          </CardBody>
        </Card>
      )}

      {moveMode && (
        <div className="text-sm text-accent bg-accent/10 border border-accent/20 rounded-xl px-4 py-2.5">
          {movingJob
            ? <>Moving <span className="font-semibold">{movingJob.title}</span> — tap a day to drop it. (Tap the job again to cancel.)</>
            : 'Move mode on — tap a job to pick it up, then tap the day to move it to.'}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading schedule...</div>
      ) : (
        <Calendar
          view={view}
          cursor={cursor}
          jobs={jobs}
          onSelectDay={handleDayTap}
          onSelectJob={handleJobTap}
          movingJobId={movingJob?.id ?? null}
          recurrenceLabels={recurrenceLabels}
        />
      )}

      {pendingAction && (
        <ScopeDialog
          title={pendingAction.job.title}
          verb={pendingVerb}
          destructive={pendingAction.type === 'delete'}
          onChoose={handleScopeChoice}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  )
}
