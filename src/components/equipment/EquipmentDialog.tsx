'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Equipment, EquipmentCategory, EQUIPMENT_CATEGORIES } from '@/lib/equipment'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Wrench } from 'lucide-react'

// Add / edit one machine. Deliberately does NOT touch last_service_at or
// last_service_hours — those are derived by the DB trigger from the service log,
// so the form can never put a machine's due-date out of step with its history.
export function EquipmentDialog({ open, userId, equipment, onClose, onSaved }: {
  open: boolean
  userId: string
  equipment: Equipment | null          // null = create
  onClose: () => void
  onSaved: (eq: Equipment) => void
}) {
  const supabase = useState(() => createClient())[0]
  const isEdit = !!equipment
  const [saving, setSaving] = useState(false)
  const [v, setV] = useState({
    name: equipment?.name ?? '',
    category: (equipment?.category ?? 'mower') as EquipmentCategory,
    make: equipment?.make ?? '',
    model: equipment?.model ?? '',
    serial_number: equipment?.serial_number ?? '',
    purchase_date: equipment?.purchase_date ?? '',
    purchase_price: equipment?.purchase_price != null ? String(equipment.purchase_price) : '',
    hours: equipment?.hours != null ? String(equipment.hours) : '0',
    service_interval_hours: equipment?.service_interval_hours != null ? String(equipment.service_interval_hours) : '',
    service_interval_days: equipment?.service_interval_days != null ? String(equipment.service_interval_days) : '',
    notes: equipment?.notes ?? '',
  })
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV(s => ({ ...s, [k]: val }))
  const numOrNull = (s: string) => { const n = Number(s); return s.trim() && Number.isFinite(n) ? n : null }

  async function save() {
    if (!v.name.trim()) { toast.error('Give the machine a name so you can spot it in the list.'); return }
    setSaving(true)
    const row = {
      user_id: userId,
      name: v.name.trim(),
      category: v.category,
      make: v.make.trim() || null,
      model: v.model.trim() || null,
      serial_number: v.serial_number.trim() || null,
      purchase_date: v.purchase_date || null,
      purchase_price: numOrNull(v.purchase_price),
      hours: numOrNull(v.hours) ?? 0,
      service_interval_hours: numOrNull(v.service_interval_hours),
      service_interval_days: numOrNull(v.service_interval_days),
      notes: v.notes.trim() || null,
    }
    const q = isEdit
      ? supabase.from('equipment').update(row).eq('id', equipment!.id).select().single()
      : supabase.from('equipment').insert(row).select().single()
    const { data, error } = await q
    setSaving(false)
    if (error || !data) { toast.error(`Could not save: ${error?.message ?? 'please try again.'}`); return }
    toast.success(`${row.name} ${isEdit ? 'updated' : 'added'}.`)
    onSaved(data as Equipment)
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} icon={Wrench} size="lg"
      onSubmit={save}
      title={isEdit ? `Edit ${equipment!.name}` : 'Add equipment'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving}>{isEdit ? 'Save changes' : 'Add machine'}</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Name *" autoFocus value={v.name} onChange={e => set('name', e.target.value)}
            placeholder="Toro 60in Zero-Turn" hint="What you'd call it out loud." />
          <Select label="Type" value={v.category} onChange={e => set('category', e.target.value as EquipmentCategory)}
            options={EQUIPMENT_CATEGORIES.map(c => ({ value: c.value, label: c.label }))} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input label="Make" value={v.make} onChange={e => set('make', e.target.value)} placeholder="Toro" />
          <Input label="Model" value={v.model} onChange={e => set('model', e.target.value)} placeholder="TimeCutter" />
          <Input label="Serial number" value={v.serial_number} onChange={e => set('serial_number', e.target.value)}
            placeholder="For warranty & insurance" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input label="Purchase date" type="date" value={v.purchase_date} onChange={e => set('purchase_date', e.target.value)} />
          <Input label="Purchase price" type="number" min="0" step="0.01" inputMode="decimal"
            value={v.purchase_price} onChange={e => set('purchase_price', e.target.value)} placeholder="0.00" />
          <Input label="Engine hours" type="number" min="0" step="0.1" inputMode="decimal"
            value={v.hours} onChange={e => set('hours', e.target.value)}
            hint="Update as you run it — drives cost/hour." />
        </div>

        <div className="rounded-xl border border-border bg-surface/40 p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-ink">Service schedule</p>
            <p className="text-xs text-ink-muted mt-0.5">Whichever comes first. Leave a field blank to skip that axis — set neither and this machine simply isn't tracked for service.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Every N engine hours" type="number" min="0" step="1" inputMode="numeric"
              value={v.service_interval_hours} onChange={e => set('service_interval_hours', e.target.value)}
              placeholder="50" hint="Typical: 50 h for a mower oil change." />
            <Input label="Every N days" type="number" min="0" step="1" inputMode="numeric"
              value={v.service_interval_days} onChange={e => set('service_interval_days', e.target.value)}
              placeholder="180" hint="Typical: 180 days for a seasonal tune-up." />
          </div>
        </div>

        <Textarea label="Notes" value={v.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Blade size, oil type, dealer, warranty expiry…" />
      </div>
    </Modal>
  )
}
