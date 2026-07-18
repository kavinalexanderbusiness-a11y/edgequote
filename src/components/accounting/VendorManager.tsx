'use client'

import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Vendor, VendorFormValues, ExpenseWithRelations } from '@/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { Menu } from '@/components/ui/Menu'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency } from '@/lib/utils'
import { createVendor, updateVendor, archiveVendor, restoreVendor, blankVendor, vendorToForm } from '@/lib/accounting/vendors'
import { Store, Plus, Pencil, Trash2, MoreHorizontal, Phone, Mail } from 'lucide-react'

// ── Vendors ──────────────────────────────────────────────────────────────────
// A vendor is a reporting dimension, so the useful thing to show next to each one
// is what it has actually cost — otherwise this is an address book nobody opens.
// Spend is summed from the expenses already in hand: no query, no second total.

interface Props {
  sb: SupabaseClient
  userId: string | null
  vendors: Vendor[]
  expenses: ExpenseWithRelations[]
  onChanged: () => void | Promise<void>
}

export function VendorManager({ sb, userId, vendors, expenses, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Vendor | null>(null)
  const [values, setValues] = useState<VendorFormValues>(blankVendor())
  const [saving, setSaving] = useState(false)

  // Gross, deliberately: this answers "what have I handed this supplier", which is
  // a bank question, not a P&L one.
  const spendByVendor = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>()
    for (const e of expenses) {
      if (!e.vendor_id) continue
      const cur = m.get(e.vendor_id) || { total: 0, count: 0 }
      cur.total += Number(e.amount) || 0
      cur.count++
      m.set(e.vendor_id, cur)
    }
    return m
  }, [expenses])

  function openNew() { setEditing(null); setValues(blankVendor()); setOpen(true) }
  function openEdit(v: Vendor) { setEditing(v); setValues(vendorToForm(v)); setOpen(true) }
  const set = (k: keyof VendorFormValues, val: string) => setValues(p => ({ ...p, [k]: val }))

  async function save() {
    if (!userId || saving) return
    setSaving(true)
    const res = editing
      ? await updateVendor(sb, editing.id, values)
      : await createVendor(sb, { userId, values })
    setSaving(false)
    if (res.error) { toast.error(res.error); return }   // keep the form open to fix it
    await onChanged()
    setOpen(false)
    toast.success(editing ? 'Vendor updated' : `Added ${values.name.trim()}`)
  }

  async function archive(v: Vendor) {
    const used = spendByVendor.get(v.id)
    // Archiving a vendor with history is safe (expenses keep pointing at it), but
    // the owner deserves to know history exists before it leaves the picker.
    if (used?.count) {
      const go = await confirm({
        title: `Archive ${v.name}?`,
        message: `${used.count} expense${used.count === 1 ? '' : 's'} worth ${formatCurrency(used.total)} stay on the books and keep this vendor's name. It just won't appear when logging new spend.`,
      })
      if (!go) return
    }
    const { error } = await archiveVendor(sb, v.id)
    if (error) { toast.error(error); return }
    await onChanged()
    toast.undo(`Archived ${v.name}`, async () => {
      const { error: e2 } = await restoreVendor(sb, v.id)
      if (e2) { toast.error(e2); return }
      await onChanged()
    })
  }

  if (!vendors.length) {
    return (
      <>
        <EmptyState
          icon={Store}
          title="No vendors yet"
          description="Vendors appear here as you log expenses — or add one now. Naming them is what makes “what do I spend at Home Depot” answerable."
          action={{ label: 'Add a vendor', onClick: openNew }}
        />
        {form()}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={openNew}><Plus className="w-4 h-4" /> Add vendor</Button>
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th>Contact</Th>
                <Th className="text-right">Spend</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => {
                const s = spendByVendor.get(v.id)
                return (
                  <tr key={v.id} className={tableRowHover}>
                    <Td>
                      <span className="text-ink font-medium">{v.name}</span>
                      {v.account_number && <span className="block text-xs text-ink-faint">Acct {v.account_number}</span>}
                    </Td>
                    <Td className="text-ink-muted">
                      <span className="flex flex-col gap-0.5">
                        {v.phone && <span className="inline-flex items-center gap-1.5"><Phone className="w-3 h-3" />{v.phone}</span>}
                        {v.email && <span className="inline-flex items-center gap-1.5"><Mail className="w-3 h-3" />{v.email}</span>}
                        {!v.phone && !v.email && <span className="text-ink-faint">—</span>}
                      </span>
                    </Td>
                    <Td className="text-right">
                      {s ? (
                        <>
                          <span className="tabular-nums text-ink">{formatCurrency(s.total)}</span>
                          <span className="block text-xs text-ink-faint tabular-nums">{s.count} expense{s.count === 1 ? '' : 's'}</span>
                        </>
                      ) : <span className="text-ink-faint">—</span>}
                    </Td>
                    <Td className="text-right">
                      <Menu
                        align="end"
                        width={180}
                        ariaLabel="Vendor actions"
                        items={[
                          { key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => openEdit(v) },
                          { key: 'archive', label: 'Archive', icon: Trash2, danger: true, onSelect: () => archive(v) },
                        ]}
                      >
                        {({ toggle, triggerProps }) => (
                          <Button variant="ghost" size="sm" onClick={toggle} {...triggerProps} aria-label="Vendor actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        )}
                      </Menu>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {form()}
    </div>
  )

  function form() {
    return (
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit vendor' : 'Add vendor'}
        onSubmit={save}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} loading={saving}>{editing ? 'Save' : 'Add vendor'}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Input label="Name" value={values.name} onChange={e => set('name', e.target.value)} autoFocus placeholder="Home Depot" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Contact" value={values.contact_name} onChange={e => set('contact_name', e.target.value)} />
            <Input label="Account number" value={values.account_number} onChange={e => set('account_number', e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Phone" type="tel" value={values.phone} onChange={e => set('phone', e.target.value)} />
            <Input label="Email" type="email" value={values.email} onChange={e => set('email', e.target.value)} />
          </div>
          <Input label="Website" value={values.website} onChange={e => set('website', e.target.value)} />
          <Textarea label="Notes" rows={2} value={values.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </Modal>
    )
  }
}
