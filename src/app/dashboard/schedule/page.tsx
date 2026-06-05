'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Customer, Job, JobFormValues } from '@/types'
import { Calendar, CalendarView } from '@/components/schedule/Calendar'
import { JobForm, Recurrence } from '@/components/schedule/JobForm'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { format, addMonths, addWeeks, addDays, subMonths, subWeeks, subDays } from 'date-fns'
import { Plus, X, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'

export default function SchedulePage() {
  const supabase = createClient()
  const [jobs, setJobs] = useState<Job[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<CalendarView>('month')
  const [cursor, setCursor] = useState(new Date())
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [formDate, setFormDate] = useState<string>('')

  const fetchJobs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    const [jRes, cRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*, customers(id, name, phone), properties(id, address, lat, lng)')
        .eq('user_id', user!.id)
        .order('scheduled_date'),
      supabase.from('customers').select('*').eq('user_id', user!.id).order('name'),
    ])
    setJobs((jRes.data as Job[]) || [])
    setCustomers((cRes.data as Customer[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  async function handleAdd(values: JobFormValues, recurrence: Recurrence) {
    const { data: { user } } = await supabase.auth.getUser()
    const base = {
      user_id: user!.id,
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      title: values.title,
      service_type: values.service_type || null,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: values.status,
      notes: values.notes || null,
    }
    const count = recurrence.repeat === 'none' ? 1 : Math.max(1, recurrence.occurrences)
    const stepDays = recurrence.repeat === 'biweekly' ? 14 : 7
    const startDate = new Date(values.scheduled_date + 'T00:00:00')
    const rows = Array.from({ length: count }, (_, i) => ({
      ...base,
      scheduled_date: format(addDays(startDate, i * stepDays), 'yyyy-MM-dd'),
    }))
    await supabase.from('jobs').insert(rows)
    await fetchJobs()
    setShowForm(false)
    setFormDate('')
  }

  async function handleEdit(values: JobFormValues) {
    if (!editing) return
    await supabase.from('jobs').update({
      customer_id: values.customer_id || null,
      property_id: values.property_id || null,
      title: values.title,
      service_type: values.service_type || null,
      scheduled_date: values.scheduled_date,
      start_time: values.start_time || null,
      end_time: values.end_time || null,
      duration_minutes: values.duration_minutes ? Number(values.duration_minutes) : null,
      crew_size: Number(values.crew_size) || 1,
      status: values.status,
      notes: values.notes || null,
    }).eq('id', editing.id)
    await fetchJobs()
    setEditing(null)
  }

  async function handleDelete() {
    if (!editing) return
    await supabase.from('jobs').delete().eq('id', editing.id)
    await fetchJobs()
    setEditing(null)
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

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
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
              <button
                onClick={() => { setShowForm(false); setEditing(null); setFormDate('') }}
                className="text-ink-faint hover:text-ink transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </CardHeader>
          <CardBody>
            <JobForm
              customers={customers}
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
              } : { scheduled_date: formDate }}
              onSubmit={editing ? handleEdit : handleAdd}
              onCancel={() => { setShowForm(false); setEditing(null); setFormDate('') }}
              isEdit={!!editing}
            />
          </CardBody>
        </Card>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading schedule...</div>
      ) : (
        <Calendar
          view={view}
          cursor={cursor}
          jobs={jobs}
          onSelectDay={openNewJob}
          onSelectJob={(job) => { setEditing(job); setShowForm(false) }}
        />
      )}
    </div>
  )
}