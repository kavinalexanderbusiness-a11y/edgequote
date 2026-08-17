// ── Schedule an estimate ─────────────────────────────────────────────────────
//
// The 15-second path. Everything that can be assumed IS assumed — today's date,
// 30 minutes, a title built from the customer's name — so the owner standing on
// somebody's driveway types a name, taps a time and saves. Every other field is
// optional and stays out of the way until it's wanted.
//
// ⛔ There is no price field, no line item, and no service picker. An estimate
// appointment is the visit that DECIDES the price; giving it somewhere to put
// money would rebuild the $0-quote workaround this feature exists to delete.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { PropertySelect } from '@/components/ui/PropertySelect'
import { Ruler, ChevronDown } from 'lucide-react'
import type { Customer, Property } from '@/types'
import {
  DEFAULT_ESTIMATE_MIN, newEstimateDraft, validateEstimate,
  type EstimateAppointment, type EstimateInput,
} from '@/lib/estimateAppointments'

interface Assignee { id: string; name: string }

interface Props {
  open: boolean
  onClose: () => void
  /** Save handler — returns an error sentence, or null on success. */
  onSave: (input: EstimateInput) => Promise<string | null>
  customers: Customer[]
  /** Every property the owner has, filtered here to the chosen customer's. */
  properties?: Property[]
  /** Crews and people the visit can be given to. Solo owners pass neither. */
  crews?: Assignee[]
  technicians?: Assignee[]
  /** Editing an existing appointment; omit to create. */
  existing?: EstimateAppointment | null
  /** Seeds for the create case — the surface the owner came from. */
  defaultDateISO?: string
  defaultCustomerId?: string | null
  defaultPropertyId?: string | null
  /** Scheduling a visit FOR a quote that already exists. */
  quoteId?: string | null
}

const DURATIONS = [15, 30, 45, 60, 90, 120]

export function EstimateAppointmentDialog({
  open, onClose, onSave, customers, properties = [], crews = [], technicians = [],
  existing, defaultDateISO, defaultCustomerId, defaultPropertyId, quoteId,
}: Props) {
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [form, setForm] = useState<EstimateInput>(() =>
    newEstimateDraft({ dateISO: defaultDateISO || todayISO }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showMore, setShowMore] = useState(false)

  // Re-seed whenever the dialog OPENS, never while it is open: re-seeding on a
  // prop change mid-edit would wipe what the owner is typing.
  useEffect(() => {
    if (!open) return
    if (existing) {
      setForm({
        title: existing.title,
        customer_id: existing.customer_id,
        property_id: existing.property_id,
        scheduled_date: existing.scheduled_date,
        start_time: existing.start_time ? existing.start_time.slice(0, 5) : null,
        duration_minutes: existing.duration_minutes,
        notes: existing.notes,
        customer_note: existing.customer_note,
        crew_id: existing.crew_id,
        technician_id: existing.technician_id,
        converted_quote_id: existing.converted_quote_id,
      })
      setShowMore(Boolean(existing.notes || existing.customer_note || existing.crew_id || existing.technician_id))
    } else {
      const c = customers.find(x => x.id === defaultCustomerId)
      setForm(newEstimateDraft({
        dateISO: defaultDateISO || todayISO,
        customerName: c?.name ?? null,
        customerId: defaultCustomerId ?? null,
        propertyId: defaultPropertyId ?? null,
        quoteId: quoteId ?? null,
      }))
      setShowMore(false)
    }
    setError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const set = (patch: Partial<EstimateInput>) => setForm(f => ({ ...f, ...patch }))

  const customerProperties = useMemo(
    () => properties.filter(p => p.customer_id === form.customer_id),
    [properties, form.customer_id])

  // Picking a customer names the visit — but only while the owner hasn't taken
  // the title over themselves. Overwriting a typed title would be rude.
  const pickCustomer = (id: string) => {
    const c = customers.find(x => x.id === id)
    const untouched = !form.title.trim() || /^Estimate( — .*)?$/.test(form.title)
    set({
      customer_id: id || null,
      property_id: null,
      title: untouched && c?.name ? `Estimate — ${c.name}` : form.title,
    })
  }

  const submit = async () => {
    const invalid = validateEstimate(form)
    if (invalid) { setError(invalid); return }
    setSaving(true)
    const err = await onSave({
      ...form,
      start_time: form.start_time || null,
      duration_minutes: form.duration_minutes ?? DEFAULT_ESTIMATE_MIN,
    })
    setSaving(false)
    if (err) { setError(err); return }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Edit estimate visit' : 'Schedule an estimate'}
      icon={Ruler}
      size="md"
      onSubmit={submit}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button onClick={submit} loading={saving} type="button">
            {existing ? 'Save' : 'Schedule visit'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* A standing statement, not a placeholder: it is the whole point of the
            dialog and must stay legible while the owner works. */}
        <p className="text-xs text-ink-muted bg-bg-tertiary border border-border rounded-lg px-3 py-2">
          A visit to look at the work and price it. It is <strong>not</strong> a job — nothing here
          bills, completes or counts as service.
        </p>

        <CustomerPicker
          label="Customer"
          customers={customers}
          value={form.customer_id || ''}
          onChange={pickCustomer}
          allowManual={false}
          placeholder="Search customers…"
        />

        {form.customer_id && (
          <PropertySelect
            label="Property"
            properties={customerProperties}
            customerId={form.customer_id}
            value={form.property_id || ''}
            onChange={(id: string) => set({ property_id: id || null })}
            noneLabel="No specific address"
            allowNone
          />
        )}

        <Input
          label="What to call it"
          value={form.title}
          onChange={e => set({ title: e.target.value })}
          placeholder="Estimate — Smith residence"
        />

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            value={form.scheduled_date}
            onChange={e => set({ scheduled_date: e.target.value })}
          />
          <Input
            label="Time"
            type="time"
            value={form.start_time || ''}
            onChange={e => set({ start_time: e.target.value || null })}
            hint="Optional"
          />
        </div>

        <Select
          label="How long"
          value={String(form.duration_minutes ?? DEFAULT_ESTIMATE_MIN)}
          onChange={e => set({ duration_minutes: Number(e.target.value) })}
          options={DURATIONS.map(m => ({ value: String(m), label: `${m} minutes` }))}
        />

        <button
          type="button"
          onClick={() => setShowMore(s => !s)}
          className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} />
          {showMore ? 'Fewer options' : 'Assign someone, add notes'}
        </button>

        {showMore && (
          <div className="space-y-3 pt-1">
            {(crews.length > 0 || technicians.length > 0) && (
              <Select
                label="Who's going"
                // A crew XOR a person — the same rule the database enforces, so the
                // form cannot offer a combination the row would refuse.
                value={form.crew_id ? `crew:${form.crew_id}` : form.technician_id ? `tech:${form.technician_id}` : ''}
                onChange={e => {
                  const v = e.target.value
                  set({
                    crew_id: v.startsWith('crew:') ? v.slice(5) : null,
                    technician_id: v.startsWith('tech:') ? v.slice(5) : null,
                  })
                }}
                placeholder="Me / unassigned"
                options={[
                  ...crews.map(c => ({ value: `crew:${c.id}`, label: `${c.name} (crew)` })),
                  ...technicians.map(t => ({ value: `tech:${t.id}`, label: t.name })),
                ]}
              />
            )}

            <Textarea
              label="Private note"
              hint="Only your team can see this."
              value={form.notes || ''}
              onChange={e => set({ notes: e.target.value || null })}
              rows={2}
              placeholder="Gate code, dog, where to park…"
            />

            <Textarea
              label="Note for the customer"
              hint="The customer may see this."
              value={form.customer_note || ''}
              onChange={e => set({ customer_note: e.target.value || null })}
              rows={2}
              placeholder="I'll walk the back yard with you."
            />
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Modal>
  )
}
