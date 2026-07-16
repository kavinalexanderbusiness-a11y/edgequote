'use client'

import { useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExpenseCategory, ExpenseWithRelations } from '@/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Toggle } from '@/components/ui/Toggle'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { Menu } from '@/components/ui/Menu'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency } from '@/lib/utils'
import { createCategory, updateCategory, archiveCategory, restoreCategory } from '@/lib/accounting/categories'
import { Plus, Pencil, Trash2, MoreHorizontal, Info } from 'lucide-react'

// ── Expense categories ───────────────────────────────────────────────────────
// The spine of the P&L. Two things here are load-bearing rather than decorative:
//
//  • `tax_deductible` — an owner draw is money out but not a claimable cost. The
//    toggle is the owner telling the P&L which is which.
//  • `external_account` — free text, and the ONLY thing that will need to exist
//    when a QuickBooks/Xero export is built. It's here now so the mapping is the
//    owner's, made once, rather than a guess made later by an importer.

interface Props {
  sb: SupabaseClient
  userId: string | null
  categories: ExpenseCategory[]
  expenses: ExpenseWithRelations[]
  onChanged: () => void | Promise<void>
}

interface Values { name: string; tax_deductible: boolean; external_account: string }
const blank = (): Values => ({ name: '', tax_deductible: true, external_account: '' })

export function CategoryManager({ sb, userId, categories, expenses, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ExpenseCategory | null>(null)
  const [values, setValues] = useState<Values>(blank())
  const [saving, setSaving] = useState(false)

  const usage = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>()
    for (const e of expenses) {
      if (!e.category_id) continue
      const cur = m.get(e.category_id) || { total: 0, count: 0 }
      cur.total += Number(e.amount) || 0
      cur.count++
      m.set(e.category_id, cur)
    }
    return m
  }, [expenses])

  function openNew() { setEditing(null); setValues(blank()); setOpen(true) }
  function openEdit(c: ExpenseCategory) {
    setEditing(c)
    setValues({ name: c.name, tax_deductible: c.tax_deductible, external_account: c.external_account || '' })
    setOpen(true)
  }

  async function save() {
    if (!userId || saving) return
    setSaving(true)
    const res = editing
      ? await updateCategory(sb, editing.id, values)
      : await createCategory(sb, {
          userId, name: values.name, tax_deductible: values.tax_deductible,
          external_account: values.external_account, sort_order: categories.length,
        })
    setSaving(false)
    if (res.error) { toast.error(res.error); return }
    await onChanged()
    setOpen(false)
    toast.success(editing ? 'Category updated' : `Added ${values.name.trim()}`)
  }

  async function archive(c: ExpenseCategory) {
    const used = usage.get(c.id)
    if (used?.count) {
      const go = await confirm({
        title: `Archive ${c.name}?`,
        message: `${used.count} expense${used.count === 1 ? '' : 's'} worth ${formatCurrency(used.total)} stay filed under it, so past reports don't change. It just won't appear when logging new spend.`,
      })
      if (!go) return
    }
    const { error } = await archiveCategory(sb, c.id)
    if (error) { toast.error(error); return }
    await onChanged()
    toast.undo(`Archived ${c.name}`, async () => {
      const { error: e2 } = await restoreCategory(sb, c.id)
      if (e2) { toast.error(e2); return }
      await onChanged()
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" icon={Info}>
        Categories group every report. Mark anything you can&apos;t claim — owner draws, personal
        spend — as not deductible: it still leaves the bank, but it isn&apos;t a business cost.
      </Banner>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={openNew}><Plus className="w-4 h-4" /> Add category</Button>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Category</Th>
                <Th>Accounting code</Th>
                <Th className="text-right">Spend</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {categories.map(c => {
                const u = usage.get(c.id)
                return (
                  <tr key={c.id} className={tableRowHover}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="text-ink font-medium">{c.name}</span>
                        {!c.tax_deductible && <Badge tone="neutral">not deductible</Badge>}
                      </span>
                    </Td>
                    <Td className="text-ink-faint">{c.external_account || '—'}</Td>
                    <Td className="text-right">
                      {u ? (
                        <>
                          <span className="tabular-nums text-ink">{formatCurrency(u.total)}</span>
                          <span className="block text-xs text-ink-faint tabular-nums">{u.count} expense{u.count === 1 ? '' : 's'}</span>
                        </>
                      ) : <span className="text-ink-faint">—</span>}
                    </Td>
                    <Td className="text-right">
                      <Menu
                        align="end"
                        width={180}
                        ariaLabel="Category actions"
                        items={[
                          { key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => openEdit(c) },
                          { key: 'archive', label: 'Archive', icon: Trash2, danger: true, onSelect: () => archive(c) },
                        ]}
                      >
                        {({ toggle, triggerProps }) => (
                          <Button variant="ghost" size="sm" onClick={toggle} {...triggerProps} aria-label="Category actions">
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit category' : 'Add category'}
        onSubmit={save}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} loading={saving}>{editing ? 'Save' : 'Add category'}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={values.name}
            onChange={e => setValues(p => ({ ...p, name: e.target.value }))}
            autoFocus
            placeholder="Fuel"
          />
          <div className="flex items-start justify-between gap-4 p-3 rounded-xl border border-line">
            <div>
              <p className="text-sm font-medium text-ink">Tax deductible</p>
              <p className="text-xs text-ink-muted">Off for owner draws and personal spend — money out, but not a business cost.</p>
            </div>
            <Toggle
              checked={values.tax_deductible}
              onChange={v => setValues(p => ({ ...p, tax_deductible: v }))}
              ariaLabel="Tax deductible"
            />
          </div>
          <Input
            label="Accounting code"
            value={values.external_account}
            onChange={e => setValues(p => ({ ...p, external_account: e.target.value }))}
            placeholder="e.g. 5400"
            hint="Optional — the account this maps to in QuickBooks or Xero, for when you export."
          />
        </div>
      </Modal>
    </div>
  )
}
