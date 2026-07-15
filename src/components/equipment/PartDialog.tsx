'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Part, PartCategory, PART_CATEGORIES, PART_UNITS, restockPart } from '@/lib/parts'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Package } from 'lucide-react'

// Add / edit a part. Deliberately does NOT set qty_on_hand — stock is derived by
// the DB trigger from the movement ledger, so the only way to put stock on the
// shelf is a movement. On create we offer an opening count, which is recorded as
// a real restock movement rather than a silent number.
export function PartDialog({ open, userId, part, onClose, onSaved }: {
  open: boolean
  userId: string
  part: Part | null          // null = create
  onClose: () => void
  onSaved: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const isEdit = !!part
  const [saving, setSaving] = useState(false)
  const [v, setV] = useState({
    name: part?.name ?? '',
    sku: part?.sku ?? '',
    category: (part?.category ?? 'blade') as PartCategory,
    unit: part?.unit ?? 'each',
    unit_cost: part?.unit_cost != null ? String(part.unit_cost) : '',
    reorder_at: part?.reorder_at != null ? String(part.reorder_at) : '',
    supplier: part?.supplier ?? '',
    notes: part?.notes ?? '',
    opening_qty: '',   // create-only: becomes a restock movement
  })
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV(s => ({ ...s, [k]: val }))
  const numOrNull = (s: string) => { const n = Number(s); return s.trim() && Number.isFinite(n) ? n : null }

  async function save() {
    if (!v.name.trim()) { toast.error('Give the part a name you\'d recognise on the shelf.'); return }
    setSaving(true)
    const row = {
      user_id: userId,
      name: v.name.trim(),
      sku: v.sku.trim() || null,
      category: v.category,
      unit: v.unit,
      unit_cost: numOrNull(v.unit_cost),
      reorder_at: numOrNull(v.reorder_at),
      supplier: v.supplier.trim() || null,
      notes: v.notes.trim() || null,
    }
    const q = isEdit
      ? supabase.from('parts').update(row).eq('id', part!.id).select().single()
      : supabase.from('parts').insert(row).select().single()
    const { data, error } = await q
    if (error || !data) { setSaving(false); toast.error(`Could not save: ${error?.message ?? 'please try again.'}`); return }

    // Opening stock is a real movement, so the ledger explains where it came from.
    const opening = numOrNull(v.opening_qty)
    if (!isEdit && opening && opening > 0) {
      const res = await restockPart(supabase, {
        userId, partId: (data as Part).id, qty: opening,
        unitCost: numOrNull(v.unit_cost), notes: 'Opening count',
      })
      if (res.error) {
        setSaving(false)
        toast.error('Part saved, but the opening count failed: ' + res.error)
        onSaved(); return
      }
    }
    setSaving(false)
    toast.success(`${row.name} ${isEdit ? 'updated' : 'added'}.`)
    onSaved()
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} icon={Package} size="lg" onSubmit={save}
      title={isEdit ? `Edit ${part!.name}` : 'Add part'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving}>{isEdit ? 'Save changes' : 'Add part'}</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Name *" autoFocus value={v.name} onChange={e => set('name', e.target.value)}
            placeholder="Toro 60in blade" hint="What you'd call it on the shelf." />
          <Input label="Part number" value={v.sku} onChange={e => set('sku', e.target.value)}
            placeholder="110-6837" hint="Makes reordering one search." />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Select label="Type" value={v.category} onChange={e => set('category', e.target.value as PartCategory)}
            options={PART_CATEGORIES.map(c => ({ value: c.value, label: c.label }))} />
          <Select label="Unit" value={v.unit} onChange={e => set('unit', e.target.value)}
            options={PART_UNITS.map(u => ({ value: u, label: u }))} />
          <Input label="Cost per unit" type="number" min="0" step="0.01" inputMode="decimal"
            value={v.unit_cost} onChange={e => set('unit_cost', e.target.value)} placeholder="0.00"
            hint="Values the shelf and prefills service cost." />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Reorder at" type="number" min="0" step="any" inputMode="decimal"
            value={v.reorder_at} onChange={e => set('reorder_at', e.target.value)}
            placeholder="2" hint="We'll flag it as low at or below this. Blank = not tracked." />
          <Input label="Supplier" value={v.supplier} onChange={e => set('supplier', e.target.value)}
            placeholder="Toro dealer — Calgary SE" />
        </div>

        {!isEdit && (
          <div className="rounded-xl border border-border bg-surface/40 p-4">
            <Input label="Opening count" type="number" min="0" step="any" inputMode="decimal"
              value={v.opening_qty} onChange={e => set('opening_qty', e.target.value)}
              placeholder="0"
              hint="How many you have right now. Recorded as a restock so the ledger always explains the count." />
          </div>
        )}

        <Textarea label="Notes" value={v.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Fits the 60in decks, torque spec, which shelf…" />
      </div>
    </Modal>
  )
}
