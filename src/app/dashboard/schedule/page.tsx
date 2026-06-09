'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, Job, JobFormValues, Quote, RecurrenceScope, RecurUnit } from '@/types'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { DayOpsPanel, QuoteLite, QuickPatch } from '@/components/schedule/DayOpsPanel'
import { Coord, geocodeAddress } from '@/lib/geo'
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
  | { type: 'edit'; job: Job; values: JobFormValues; recurrence: Recurrence }
  | { type: 'move'; job: Job; newDate: string }
  | { type: 'delete'; job: Job }

// Map an interval back to the legacy `freq` column where it lines up.
function legacyFreqFor(unit: RecurUnit | null, count: number): string | null {
  if (unit === 'week' && count === 1) return 'weekly'
  if (unit === 'week' && count === 2) return 'biweekly'
  if (unit === 'month' && count === 1) return 'monthly'
  return null
}

// A series row → the form's Recurrence shape (handles legacy freq-only rows).
function recFromRow(r: JobRecurrence): Recurrence {
  if (r.interval_unit) return { unit: r.interval_unit, count: r.interval_count ?? 1, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'weekly') return { unit: 'week', count: 1, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'biweekly') return { unit: 'week', count: 2, endDate: r.end_date, endCount: r.end_count }
  if (r.freq === 'monthly') return { unit: 'month', count: 1, endDate: r.end_date, endCount: r.end_count }
  return { unit: null, count: 1, endDate: null, endCount: null }
}

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
  const [formSeq, setFormSeq] = useState(0) // bump to remount a fresh add form
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  // One-click undo for the last move/delete/done.
  const [undoAction, setUndoAction] = useState<{ label: string; run: () => Promise<void> } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [recurrenceLabels, setRecurrenceLabels] = useState<Record<string, string>>({})
  const [recurrences, setRecurrences] = useState<Record<string, JobRecurrence>>({})
  const [quotesById, setQuotesById] = useState<Record<string, QuoteLite>>({})
  const [baseCoord, setBaseCoord] = useState<Coord | null>(null)

  // When arriving from an accepted quote (?quote=…), open a prefilled new-job form.
  const [quoteCtx, setQuoteCtx] = useState<Quote | null>(null)
  const [quotePrefill, setQuotePrefill] = useState<Partial<JobFormValues> | null>(null)
  // When arriving from a customer (?customer=…), open a new-job form for them.
  const [customerPrefill, setCustomerPrefill] = useState<Partial<JobFormValues> | null>(null)

  const fetchJobs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, cRes, rRes, qRes, sRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*, customers(id, name, phone), properties(id, address, lat, lng)')
        .eq('user_id', user!.id)
        .order('scheduled_date'),
      supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
      supabase.from('job_recurrences').select('*').eq('user_id', user!.id),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('business_settings').select('base_lat, base_lng, base_address').eq('user_id', user!.id).maybeSingle(),
    ])
    setJobs((jRes.data as Job[]) || [])
    setCustomers((cRes.data as Customer[]) || [])
    const labels: Record<string, string> = {}
    const recMap: Record<string, JobRecurrence> = {}
    for (const r of (rRes.data as JobRecurrence[]) || []) {
      labels[r.id] = recurrenceLabel(r.interval_unit, r.interval_count, r.freq)
      recMap[r.id] = r
    }
    setRecurrenceLabels(labels)
    setRecurrences(recMap)

    const qMap: Record<string, QuoteLite> = {}
    for (const q of (qRes.data as QuoteLite[]) || []) qMap[q.id] = q
    setQuotesById(qMap)

    // Base coordinate for route optimization (geocode the address once if needed).
    const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null } | null
    if (s?.base_lat != null && s?.base_lng != null) {
      setBaseCoord({ lat: s.base_lat, lng: s.base_lng })
    } else if (s?.base_address) {
      const c = await geocodeAddress(s.base_address)
      if (c) {
        setBaseCoord(c)
        supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id)
      }
    }
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

  async function handleAdd(values: JobFormValues, recurrence: Recurrence, meta?: SuggestionMeta, opts?: { addAnother?: boolean }) {
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
    // Save & Add Another: keep the date, open a fresh form immediately.
    if (opts?.addAnother && !quoteCtx && !customerPrefill) {
      setFormDate(values.scheduled_date)
      setEditing(null)
      setShowForm(true)
      setFormSeq(s => s + 1)
      setBanner('Job added — add another.')
    } else {
      closeForm()
    }
  }

  // The propagating field set for a generated occurrence (no per-visit outcome).
  function occurrenceBase(values: JobFormValues, userId: string, recurrenceId: string, quoteId: string | null) {
    return {
      user_id: userId,
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      quote_id: quoteId,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: 'scheduled' as const,
      notes: values.notes || null,
      recurrence_id: recurrenceId,
    }
  }

  // Apply field edits (+ per-visit outcome on the anchor, + date shift) across a
  // recurrence scope. Writes only — the orchestrator handles refresh.
  async function applyFieldEdits(job: Job, values: JobFormValues, scope: RecurrenceScope) {
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
    // Status and actual time belong ONLY to the edited visit, never its siblings.
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

    if (values.status === 'completed' && job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Draft invoice ${res.invoiceNumber} created from the completed visit — review it in Invoices.`)
      else if (res.reason === 'exists') setBanner('That visit already has an invoice.')
    }
  }

  // Turn a one-time job into a recurring series — the current job stays as the
  // first visit; future visits are generated. No scope prompt (it's one job).
  async function convertToRecurring(job: Job, values: JobFormValues, recurrence: Recurrence) {
    if (!recurrence.unit) return
    const { data: { user } } = await supabase.auth.getUser()
    const { data: rec, error: recErr } = await supabase.from('job_recurrences').insert({
      user_id: user!.id,
      freq: legacyFreqFor(recurrence.unit, recurrence.count),
      interval_unit: recurrence.unit,
      interval_count: recurrence.count,
      start_date: values.scheduled_date,
      end_date: recurrence.endDate,
      end_count: recurrence.endCount,
      customer_id: values.customer_id || null,
    }).select().single()
    if (recErr || !rec) { setBanner('Could not create the recurring series: ' + (recErr?.message ?? '')); return }

    await applyFieldEdits(job, values, 'this')
    await supabase.from('jobs').update({ recurrence_id: rec.id }).eq('id', job.id)

    const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
    const future = dates.slice(1) // skip the anchor — it already exists
    if (future.length) {
      const base = occurrenceBase(values, user!.id, rec.id, job.quote_id)
      const { error } = await supabase.from('jobs').insert(future.map(d => ({ ...base, scheduled_date: d })))
      if (error) { setBanner('Series created, but adding future visits failed: ' + error.message); return }
    }
    setBanner(`Now recurring — ${recurrenceLabel(recurrence.unit, recurrence.count)}. ${future.length} future visit${future.length !== 1 ? 's' : ''} added.`)
  }

  // Detach/delete recurrence per scope, turning the anchor into a one-time job.
  async function removeRecurrence(job: Job, scope: RecurrenceScope) {
    if (!job.recurrence_id) return
    if (scope === 'this') {
      await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
      setBanner('This visit is now a one-time job.')
      return
    }
    if (scope === 'future') {
      const laterIds = jobs.filter(j => j.recurrence_id === job.recurrence_id && j.scheduled_date > job.scheduled_date).map(j => j.id)
      if (laterIds.length) await supabase.from('jobs').delete().in('id', laterIds)
      await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
      setBanner(`Recurrence ended — ${laterIds.length} future visit${laterIds.length !== 1 ? 's' : ''} removed.`)
      return
    }
    const siblingIds = jobs.filter(j => j.recurrence_id === job.recurrence_id && j.id !== job.id).map(j => j.id)
    if (siblingIds.length) await supabase.from('jobs').delete().in('id', siblingIds)
    await supabase.from('jobs').update({ recurrence_id: null }).eq('id', job.id)
    await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    setBanner('Recurrence removed — this is now a one-time job.')
  }

  // Change the cadence/end of an existing series: keep past visits, regenerate
  // forward from the anchor with the new rule.
  async function changeRecurrence(job: Job, values: JobFormValues, recurrence: Recurrence) {
    if (!job.recurrence_id || !recurrence.unit) return
    const { data: { user } } = await supabase.auth.getUser()
    const futureIds = jobs
      .filter(j => j.recurrence_id === job.recurrence_id && j.id !== job.id && j.scheduled_date > job.scheduled_date)
      .map(j => j.id)
    if (futureIds.length) await supabase.from('jobs').delete().in('id', futureIds)
    await supabase.from('job_recurrences').update({
      freq: legacyFreqFor(recurrence.unit, recurrence.count),
      interval_unit: recurrence.unit,
      interval_count: recurrence.count,
      end_date: recurrence.endDate,
      end_count: recurrence.endCount,
    }).eq('id', job.recurrence_id)
    const dates = generateOccurrences(values.scheduled_date, recurrence.unit, recurrence.count, recurrence.endDate, recurrence.endCount)
    const future = dates.slice(1)
    if (future.length) {
      const base = occurrenceBase(values, user!.id, job.recurrence_id, job.quote_id)
      await supabase.from('jobs').insert(future.map(d => ({ ...base, scheduled_date: d })))
    }
    setBanner(`Schedule updated to ${recurrenceLabel(recurrence.unit, recurrence.count)}.`)
  }

  // Orchestrator for an edit on a recurring job (or a one-time → one-time edit):
  // field edits + any add/change/remove of recurrence, scoped Apple-style.
  async function applyEdit(job: Job, values: JobFormValues, recurrence: Recurrence, scope: RecurrenceScope) {
    const was = !!job.recurrence_id
    const will = recurrence.unit !== null
    const existing = was && job.recurrence_id ? recurrences[job.recurrence_id] : undefined
    const existingRec = existing ? recFromRow(existing) : null
    const ruleChanged = !!(will && existingRec && (
      existingRec.unit !== recurrence.unit ||
      existingRec.count !== recurrence.count ||
      (existingRec.endDate || null) !== (recurrence.endDate || null) ||
      (existingRec.endCount || null) !== (recurrence.endCount || null)
    ))

    if (!was || (will && !ruleChanged)) {
      await applyFieldEdits(job, values, scope)
    } else if (!will) {
      await applyFieldEdits(job, values, 'this')
      await removeRecurrence(job, scope)
    } else {
      await applyFieldEdits(job, values, 'this')
      await changeRecurrence(job, values, recurrence)
    }
    await fetchJobs()
    setEditing(null)
  }

  async function applyMove(job: Job, newDate: string, scope: RecurrenceScope) {
    const delta = dayDelta(job.scheduled_date, newDate)
    const targets = jobsInScope(job, jobs, scope)
    const prev = targets.map(t => ({ id: t.id, scheduled_date: t.scheduled_date }))
    await Promise.all(targets.map(t =>
      supabase.from('jobs').update({ scheduled_date: shiftDate(t.scheduled_date, delta) }).eq('id', t.id)
    ))
    await fetchJobs()
    offerUndo(`Moved ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      await Promise.all(prev.map(p => supabase.from('jobs').update({ scheduled_date: p.scheduled_date }).eq('id', p.id)))
    })
  }

  async function applyDelete(job: Job, scope: RecurrenceScope) {
    const targets = jobsInScope(job, jobs, scope)
    const snapshot = targets.map(jobInsertRow)
    const r = (scope === 'all' && job.recurrence_id) ? recurrences[job.recurrence_id] : null
    const recRow = r ? {
      id: r.id, user_id: r.user_id, freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count,
      start_date: r.start_date, end_date: r.end_date, end_count: r.end_count, customer_id: r.customer_id,
    } : null
    await supabase.from('jobs').delete().in('id', targets.map(t => t.id))
    if (recRow) await supabase.from('job_recurrences').delete().eq('id', job.recurrence_id)
    await fetchJobs()
    setEditing(null)
    offerUndo(`Deleted ${targets.length} visit${targets.length !== 1 ? 's' : ''}`, async () => {
      if (recRow) await supabase.from('job_recurrences').insert(recRow)
      if (snapshot.length) await supabase.from('jobs').insert(snapshot)
    })
  }

  async function handleEdit(values: JobFormValues, recurrence: Recurrence) {
    if (!editing) return
    const was = !!editing.recurrence_id
    const will = recurrence.unit !== null
    if (!was && !will) {
      // One-time edit, stays one-time — no scope prompt.
      await applyEdit(editing, values, recurrence, 'this')
      return
    }
    if (!was && will) {
      // One-time → recurring — no scope prompt (it's a single job).
      await convertToRecurring(editing, values, recurrence)
      await fetchJobs()
      setEditing(null)
      return
    }
    // Editing an existing recurring job → choose which visits this affects.
    setPendingAction({ type: 'edit', job: editing, values, recurrence })
  }

  async function handleDelete() {
    if (!editing) return
    if (editing.recurrence_id) {
      setPendingAction({ type: 'delete', job: editing })
      return
    }
    const row = jobInsertRow(editing)
    await supabase.from('jobs').delete().eq('id', editing.id)
    await fetchJobs()
    setEditing(null)
    offerUndo('Job deleted', async () => { await supabase.from('jobs').insert(row) })
  }

  // One-tap "Done" from the calendar — marks ONLY this visit (no scope prompt),
  // and drafts an invoice for a completed recurring visit.
  async function markJobDone(job: Job) {
    const prevStatus = job.status
    const { error } = await supabase.from('jobs').update({ status: 'completed' }).eq('id', job.id)
    if (error) { setBanner('Could not mark done: ' + error.message); return }
    let invoiceCreated = false
    if (job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) { invoiceCreated = true; setBanner(`Draft invoice ${res.invoiceNumber} created. Review in Invoices.`) }
    }
    await fetchJobs()
    offerUndo('Marked done', async () => {
      await supabase.from('jobs').update({ status: prevStatus }).eq('id', job.id)
      if (invoiceCreated) await supabase.from('invoices').delete().eq('job_id', job.id).eq('status', 'draft')
    })
  }

  // Inline quick-edit from the day panel — small per-visit changes, no full form.
  async function quickSaveJob(job: Job, patch: QuickPatch) {
    const { error } = await supabase.from('jobs').update({
      start_time: patch.start_time,
      crew_size: patch.crew_size,
      duration_minutes: patch.duration_minutes,
      status: patch.status,
      notes: patch.notes,
    }).eq('id', job.id)
    if (error) { setBanner('Could not save the job: ' + error.message); return }
    if (patch.status === 'completed' && job.status !== 'completed' && job.recurrence_id) {
      const res = await createDraftInvoiceForCompletedJob(supabase, { ...job, status: 'completed' })
      if (res.created) setBanner(`Saved — draft invoice ${res.invoiceNumber} created.`)
    }
    await fetchJobs()
  }

  // ── Undo ────────────────────────────────────────────────────────────────────
  function offerUndo(label: string, run: () => Promise<void>) {
    setUndoAction({ label, run })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndoAction(null), 8000)
  }
  async function runUndo() {
    const a = undoAction
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndoAction(null)
    if (a) { await a.run(); await fetchJobs() }
  }
  // Insertable job row (strips joined customers/properties) for delete-undo.
  function jobInsertRow(j: Job) {
    return {
      id: j.id, user_id: j.user_id, customer_id: j.customer_id, property_id: j.property_id,
      quote_id: j.quote_id, recurrence_id: j.recurrence_id, title: j.title, service_type: j.service_type,
      scheduled_date: j.scheduled_date, start_time: j.start_time, end_time: j.end_time,
      duration_minutes: j.duration_minutes, crew_size: j.crew_size, status: j.status, notes: j.notes,
      actual_minutes: j.actual_minutes, suggested_date: j.suggested_date, suggested_nearby_count: j.suggested_nearby_count,
    }
  }

  async function moveJobToDate(job: Job, date: Date) {
    const newDate = format(date, 'yyyy-MM-dd')
    if (newDate === job.scheduled_date) return
    if (job.recurrence_id) {
      setPendingAction({ type: 'move', job, newDate })
      return
    }
    const prevDate = job.scheduled_date
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, scheduled_date: newDate } : j))
    await supabase.from('jobs').update({ scheduled_date: newDate }).eq('id', job.id)
    offerUndo('Job moved', async () => {
      await supabase.from('jobs').update({ scheduled_date: prevDate }).eq('id', job.id)
    })
  }

  async function handleScopeChoice(scope: RecurrenceScope) {
    const action = pendingAction
    setPendingAction(null)
    if (!action) return
    if (action.type === 'edit') await applyEdit(action.job, action.values, action.recurrence, scope)
    else if (action.type === 'move') await applyMove(action.job, action.newDate, scope)
    else if (action.type === 'delete') await applyDelete(action.job, scope)
  }

  function handleDayTap(day: Date) {
    // In month/week, tapping a day EXPANDS it (shows all its jobs) instead of
    // jumping straight to a new-job form. In day view, tapping adds a job.
    if (view === 'day') {
      openNewJob(day)
    } else {
      setCursor(day)
      setView('day')
    }
  }

  function handleJobTap(job: Job) {
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
          <Button onClick={() => openNewJob(cursor)}>
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

      {/* Undo toast — restore the last move / delete / done */}
      {undoAction && (
        <div className="flex items-center justify-between gap-3 text-sm bg-ink text-bg border border-border-strong rounded-xl px-4 py-2.5 shadow-lg">
          <span className="font-medium">{undoAction.label}</span>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={runUndo} className="font-bold underline">Undo</button>
            <button onClick={() => setUndoAction(null)} className="opacity-60 hover:opacity-100">✕</button>
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
              key={editing?.id ?? `new-${formSeq}`}
              customers={customers}
              excludeJobId={editing?.id}
              allowAddAnother={!editing && !quoteCtx && !customerPrefill}
              initialRecurrence={editing?.recurrence_id && recurrences[editing.recurrence_id]
                ? recFromRow(recurrences[editing.recurrence_id])
                : undefined}
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

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading schedule...</div>
      ) : view === 'day' ? (
        <DayOpsPanel
          date={format(cursor, 'yyyy-MM-dd')}
          dateLabel={format(cursor, 'EEEE, MMMM d, yyyy')}
          jobs={jobs.filter(j => j.scheduled_date === format(cursor, 'yyyy-MM-dd'))}
          quotesById={quotesById}
          recurrences={recurrences}
          baseCoord={baseCoord}
          onOpenJob={(job) => { setEditing(job); setShowForm(false) }}
          onMarkDone={markJobDone}
          onMove={(job, iso) => moveJobToDate(job, new Date(iso + 'T00:00:00'))}
          onAddJob={() => openNewJob(cursor)}
          onQuickSave={quickSaveJob}
        />
      ) : (
        <Calendar
          view={view}
          cursor={cursor}
          jobs={jobs}
          onSelectDay={handleDayTap}
          onSelectJob={handleJobTap}
          onMarkDone={markJobDone}
          onMoveJob={(job, iso) => moveJobToDate(job, new Date(iso + 'T00:00:00'))}
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
