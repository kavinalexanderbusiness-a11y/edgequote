'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Paperclip, X, FileText, Loader2, Plus } from 'lucide-react'
import type {
  ExpenseWithRelations, ExpenseFormValues, Vendor, ExpenseCategory,
} from '@/types'
import { EXPENSE_PAYMENT_METHODS } from '@/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import {
  blankExpense, expenseToForm, validateExpense, parseMoney, createExpense, updateExpense,
} from '@/lib/accounting/expenses'
import { findOrCreateVendor } from '@/lib/accounting/vendors'
import {
  replaceReceipt, removeReceipt, signedReceiptUrl, validateReceipt,
  RECEIPT_ACCEPT, isPdfReceipt,
} from '@/lib/accounting/receipts'

// ── Capture one expense ──────────────────────────────────────────────────────
// The whole module earns its keep here: if logging a receipt is slow, the books
// stay empty and every report downstream is a confident lie about a business that
// spends money. So: amount and date first, everything else optional, vendor
// creatable inline (no "go make a vendor first" detour), and the receipt attaches
// AFTER the row is saved — money recorded beats a photo that failed to upload on
// bad signal in a parking lot.

interface Props {
  open: boolean
  onClose: () => void
  sb: SupabaseClient
  userId: string
  todayISO: string
  vendors: Vendor[]
  categories: ExpenseCategory[]
  jobs: { id: string; label: string }[]
  /** null = create. */
  editing: ExpenseWithRelations | null
  /** Pre-link to a job when opened from a job. */
  defaultJobId?: string
  onSaved: () => void | Promise<void>
  onVendorCreated: () => void | Promise<void>
}

export function ExpenseForm({
  open, onClose, sb, userId, todayISO, vendors, categories, jobs,
  editing, defaultJobId, onSaved, onVendorCreated,
}: Props) {
  const [values, setValues] = useState<ExpenseFormValues>(blankExpense(todayISO))
  const [errors, setErrors] = useState<Partial<Record<keyof ExpenseFormValues, string>>>({})
  const [saving, setSaving] = useState(false)

  // Vendor-by-name, so a new supplier never bounces the owner to another screen.
  const [vendorName, setVendorName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [receiptPath, setReceiptPath] = useState<string | null>(null)
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    if (editing) {
      setValues(expenseToForm(editing))
      setVendorName(editing.vendors?.name || '')
      setReceiptPath(editing.receipt_path)
    } else {
      setValues({ ...blankExpense(todayISO), job_id: defaultJobId || '' })
      setVendorName('')
      setReceiptPath(null)
    }
    setErrors({})
    setFile(null)
    setReceiptUrl(null)
  }, [open, editing, todayISO, defaultJobId])

  // Signed URL for an existing receipt — the bucket is private, so this is the
  // only way to show it. Minted on open, not stored.
  useEffect(() => {
    let alive = true
    if (open && receiptPath && !file) {
      signedReceiptUrl(sb, receiptPath, 120).then(u => { if (alive) setReceiptUrl(u) })
    }
    return () => { alive = false }
  }, [open, receiptPath, file, sb])

  const localPreview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (localPreview) URL.revokeObjectURL(localPreview) }, [localPreview])

  const set = (k: keyof ExpenseFormValues, v: string) => {
    setValues(prev => ({ ...prev, [k]: v }))
    if (errors[k]) setErrors(prev => ({ ...prev, [k]: undefined }))
  }

  // Live net, shown only once it means something. This is the one place the
  // gross/tax convention is visible to the owner, so it says so in words.
  const amount = parseMoney(values.amount)
  const tax = parseMoney(values.tax_amount)
  const net = amount != null && tax != null && tax <= amount ? amount - tax : null

  function pickFile(f: File | null) {
    if (!f) return
    const bad = validateReceipt(f)
    if (bad) { toast.error(bad); return }
    setFile(f)
    setReceiptUrl(null)
  }

  async function handleSubmit() {
    if (saving) return
    const v = validateExpense(values)
    if (!v.ok) { setErrors(v.errors); return }
    setSaving(true)

    try {
      // Vendor first: typed name → row, matched case-insensitively so "home depot"
      // joins the existing Home Depot instead of splitting its history.
      let vendorId: string | null = values.vendor_id || null
      const typed = vendorName.trim()
      if (typed) {
        const existing = vendors.find(x => x.name.toLowerCase() === typed.toLowerCase())
        if (existing) {
          vendorId = existing.id
        } else {
          const { vendor, error } = await findOrCreateVendor(sb, { userId, name: typed })
          if (error || !vendor) { toast.error(error || 'Could not save that vendor.'); setSaving(false); return }
          vendorId = vendor.id
          await onVendorCreated()
        }
      } else {
        vendorId = null
      }

      const withVendor: ExpenseFormValues = { ...values, vendor_id: vendorId || '' }

      let expenseId = editing?.id
      if (editing) {
        const { error } = await updateExpense(sb, editing.id, withVendor)
        if (error) { toast.error(error); setSaving(false); return }
      } else {
        const { expense, error } = await createExpense(sb, { userId, values: withVendor })
        if (error || !expense) { toast.error(error || 'Could not save the expense.'); setSaving(false); return }
        expenseId = expense.id
      }

      // The receipt attaches AFTER the money is recorded. If this fails the expense
      // still exists and the owner is told what's missing — rather than losing both
      // to one failed upload.
      if (file && expenseId) {
        const { error } = await replaceReceipt(sb, {
          userId, expenseId, file, previousPath: editing?.receipt_path ?? null,
        })
        if (error) {
          toast.error(`Expense saved, but the receipt didn't upload: ${error}`)
          await onSaved()
          onClose()
          setSaving(false)
          return
        }
      }

      toast.success(editing ? 'Expense updated' : `Logged ${formatCurrency(amount ?? 0)}`)
      await onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function detachReceipt() {
    if (!editing || !receiptPath) { setFile(null); return }
    const { error } = await removeReceipt(sb, { expenseId: editing.id, path: receiptPath })
    if (error) { toast.error(error); return }
    setReceiptPath(null)
    setReceiptUrl(null)
    setFile(null)
    await onSaved()
    toast.success('Receipt removed')
  }

  const vendorListId = 'expense-vendor-options'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit expense' : 'Log an expense'}
      size="lg"
      onSubmit={handleSubmit}
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save changes' : 'Log expense'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Amount + date lead: they are the only required facts. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input
            label="Amount"
            inputMode="decimal"
            placeholder="0.00"
            value={values.amount}
            onChange={e => set('amount', e.target.value)}
            error={errors.amount}
            autoFocus
          />
          <Input
            label="Tax included"
            inputMode="decimal"
            placeholder="0.00"
            value={values.tax_amount}
            onChange={e => set('tax_amount', e.target.value)}
            error={errors.tax_amount}
            hint={net != null ? <>Net {formatCurrency(net)}</> : 'Leave blank if none'}
          />
          <Input
            label="Date"
            type="date"
            value={values.spent_at}
            onChange={e => set('spent_at', e.target.value)}
            error={errors.spent_at}
          />
        </div>

        <Input
          label="What was it?"
          placeholder="Fuel, blades, trailer tires…"
          value={values.description}
          onChange={e => set('description', e.target.value)}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* A datalist rather than a picker + "new vendor" modal: type the name,
              press on. Matching and creation both go through findOrCreateVendor. */}
          <div className="flex flex-col gap-1.5">
            <Input
              label="Vendor"
              list={vendorListId}
              placeholder="Home Depot"
              value={vendorName}
              onChange={e => setVendorName(e.target.value)}
              hint={
                vendorName.trim() && !vendors.some(v => v.name.toLowerCase() === vendorName.trim().toLowerCase())
                  ? <span className="inline-flex items-center gap-1"><Plus className="w-3 h-3" />New vendor — saved when you log this</span>
                  : 'Type to match or add'
              }
            />
            <datalist id={vendorListId}>
              {vendors.map(v => <option key={v.id} value={v.name} />)}
            </datalist>
          </div>

          <Select
            label="Category"
            placeholder="Uncategorised"
            options={categories.map(c => ({ value: c.id, label: c.tax_deductible ? c.name : `${c.name} (not deductible)` }))}
            value={values.category_id}
            onChange={e => set('category_id', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Paid with"
            placeholder="—"
            options={EXPENSE_PAYMENT_METHODS}
            value={values.payment_method}
            onChange={e => set('payment_method', e.target.value)}
          />
          <Input
            label="Reference"
            placeholder="Receipt or invoice #"
            value={values.reference}
            onChange={e => set('reference', e.target.value)}
          />
        </div>

        {/* Job link = job costing, with no second table and no second screen. */}
        <Select
          label="Link to a job"
          placeholder="Not job-specific (overhead)"
          options={jobs.map(j => ({ value: j.id, label: j.label }))}
          value={values.job_id}
          onChange={e => set('job_id', e.target.value)}
          hint="Linked spend shows up as that job's real cost"
        />

        {/* ── Receipt ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink-muted">Receipt</span>
          {file || receiptPath ? (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-line bg-surface-sunken">
              {file && localPreview && !file.type.includes('pdf') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={localPreview} alt="" className="w-12 h-12 rounded-lg object-cover" />
              ) : receiptUrl && receiptPath && !isPdfReceipt(receiptPath) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={receiptUrl} alt="" className="w-12 h-12 rounded-lg object-cover" />
              ) : (
                <span className="w-12 h-12 rounded-lg bg-surface grid place-items-center text-ink-faint">
                  {receiptPath && !receiptUrl && !file ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-5 h-5" />}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink truncate">{file ? file.name : 'Attached receipt'}</p>
                {receiptUrl && !file && (
                  <a href={receiptUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">
                    Open
                  </a>
                )}
                {file && <p className="text-xs text-ink-faint">Uploads when you save</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={file ? () => setFile(null) : detachReceipt} aria-label="Remove receipt">
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 p-3 rounded-xl border border-dashed border-line text-sm text-ink-muted hover:border-accent hover:text-ink transition-colors"
            >
              <Paperclip className="w-4 h-4" />
              Attach a photo or PDF
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={RECEIPT_ACCEPT}
            className="hidden"
            onChange={e => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <Textarea
          label="Notes"
          rows={2}
          value={values.notes}
          onChange={e => set('notes', e.target.value)}
        />
      </div>
    </Modal>
  )
}
