'use client'

import { useMemo, useState } from 'react'
import { Customer, Property, BusinessSettings, Invoice, InvoiceLineItem } from '@/types'
import { invoiceTotals, applyDiscount, type DiscountType } from '@/lib/invoiceTotals'
import { formatCurrency, localTodayISO, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { useAutosave } from '@/hooks/useAutosave'
import { AutosaveStatus, DraftRestoreBanner } from '@/components/ui/Autosave'
import { addDays, format as formatDfn, parseISO } from 'date-fns'
import { Plus, Trash2, Eye, Send, Save, Receipt, StickyNote } from 'lucide-react'

// ── Manual invoice builder ────────────────────────────────────────────────────
// Bill a customer without a job. Every number comes from the SAME engines the
// automatic invoices use: applyDiscount → the stored net `amount`, and
// invoiceTotals → the displayed subtotal/discount/GST/total. Nothing is
// recalculated here, so a hand-built invoice is byte-identical in shape to a
// generated one and inherits payments, reminders, the portal, AutoPay, the PDF
// and the customer timeline for free.

export interface BuilderLine { description: string; qty: string; unit_price: string }
export interface InvoiceBuilderValues {
  customer_id: string
  property_id: string
  service_type: string
  lines: BuilderLine[]
  discount_type: DiscountType | ''
  discount_value: string
  due_date: string
  notes: string
}

const emptyLine = (): BuilderLine => ({ description: '', qty: '1', unit_price: '' })

export function blankInvoiceValues(): InvoiceBuilderValues {
  return {
    customer_id: '', property_id: '', service_type: '',
    lines: [emptyLine()],
    discount_type: '', discount_value: '',
    due_date: formatDfn(addDays(parseISO(localTodayISO()), 14), 'yyyy-MM-dd'),
    notes: '',
  }
}

const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : 0 }
const round2 = (n: number) => Math.round(n * 100) / 100

/** The line total every engine reads. Exported so the page stores the same maths. */
export function lineAmount(l: BuilderLine): number { return round2(num(l.qty) * num(l.unit_price)) }

/** Builder state → the exact `line_items` jsonb shape (amount = the line total). */
export function toLineItems(lines: BuilderLine[]): InvoiceLineItem[] {
  return lines
    .filter(l => l.description.trim() && lineAmount(l) !== 0)
    .map(l => ({
      description: l.description.trim(),
      amount: lineAmount(l),
      kind: 'service' as const,
      qty: num(l.qty) || null,
      unit_price: num(l.unit_price) || null,
    }))
}

/** Gross (pre-discount) subtotal — the sum of the line totals. */
export function grossOf(lines: BuilderLine[]): number {
  return round2(lines.reduce((s, l) => s + lineAmount(l), 0))
}

/** The stored `amount`: ALWAYS the net, post-discount subtotal (the invariant). */
export function netOf(lines: BuilderLine[], type: DiscountType | '', value: string): number {
  const gross = grossOf(lines)
  if (!type) return gross
  return applyDiscount(gross, { type, value: num(value) }).net
}

export function InvoiceBuilder({
  values, onChange, customers, properties, settings, onSaveDraft, onSaveAndSend, saving,
}: {
  values: InvoiceBuilderValues
  onChange: (v: InvoiceBuilderValues) => void
  customers: Customer[]
  properties: Property[]
  settings: BusinessSettings | null
  onSaveDraft: () => void | Promise<void>
  onSaveAndSend: () => void | Promise<void>
  saving: 'draft' | 'send' | null
}) {
  const [previewing, setPreviewing] = useState(false)
  const set = <K extends keyof InvoiceBuilderValues>(k: K, v: InvoiceBuilderValues[K]) => onChange({ ...values, [k]: v })

  // Autosave the whole builder — survives refresh / crash. Shared engine.
  const autosave = useAutosave<InvoiceBuilderValues>({
    key: 'invoice:new',
    value: values,
    isEmpty: v => !v.customer_id && !v.lines.some(l => l.description.trim() || num(l.unit_price)),
  })

  const customer = customers.find(c => c.id === values.customer_id) || null
  // Only this customer's properties — an invoice's property must belong to them.
  const propOptions = useMemo(() => [
    { value: '', label: properties.length ? 'No specific property' : 'No properties on file' },
    ...properties.filter(p => p.customer_id === values.customer_id).map(p => ({ value: p.id, label: p.address })),
  ], [properties, values.customer_id])

  // ── Totals: the ONE engine, same as auto invoices ──
  const gross = grossOf(values.lines)
  const net = netOf(values.lines, values.discount_type, values.discount_value)
  const totals = invoiceTotals(net, settings, { type: values.discount_type || null, value: num(values.discount_value) })

  const validLines = toLineItems(values.lines)
  const canSave = !!values.customer_id && validLines.length > 0 && net > 0

  function updateLine(i: number, patch: Partial<BuilderLine>) {
    set('lines', values.lines.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }
  function addLine() { set('lines', [...values.lines, emptyLine()]) }
  function removeLine(i: number) {
    const next = values.lines.filter((_, idx) => idx !== i)
    set('lines', next.length ? next : [emptyLine()])
  }

  // Preview the REAL PDF — builds the same Invoice shape we'd store and hands it
  // to the one renderer, so the preview is exactly the document the customer gets.
  async function previewPdf() {
    if (!canSave) { toast.error('Add a customer and at least one line item first.'); return }
    setPreviewing(true)
    try {
      const [{ renderInvoiceBlob }, { viewBlob }] = await Promise.all([
        import('@/components/quotes/InvoicePDF'), import('@/lib/portalPdf'),
      ])
      viewBlob(await renderInvoiceBlob(previewInvoice(values, customer, properties), settings))
    } catch {
      toast.error('Could not generate the preview. Please try again.')
    }
    setPreviewing(false)
  }

  return (
    <div className="space-y-5">
      {autosave.draft && (
        <DraftRestoreBanner
          savedAt={autosave.savedAt} label="unsaved invoice"
          onRestore={() => { const v = autosave.restore(); if (v) onChange(v) }}
          onDiscard={autosave.discard}
        />
      )}

      {/* Who + where */}
      <Card>
        <CardBody className="space-y-4">
          <CustomerPicker
            label="Bill to *" customers={customers} value={values.customer_id} allowManual={false}
            autoFocus hint="Invoices always attach to a customer, so payments, reminders and the portal work."
            onChange={id => onChange({ ...values, customer_id: id, property_id: '' })}
          />
          {values.customer_id && (
            <Select
              label="Property (optional)" options={propOptions}
              value={values.property_id} onChange={e => set('property_id', e.target.value)}
              hint="Ties this invoice to one address — leave blank for general work."
            />
          )}
        </CardBody>
      </Card>

      {/* Line items */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink flex items-center gap-2"><Receipt className="w-4 h-4 text-accent" /> Line items</p>
            <Button type="button" size="sm" variant="secondary" onClick={addLine}><Plus className="w-3.5 h-3.5" /> Add line</Button>
          </div>

          {/* Column headers (desktop) */}
          <div className="hidden sm:grid grid-cols-[1fr_5rem_7rem_6rem_2rem] gap-2 px-1">
            {['Description', 'Qty', 'Unit price', 'Amount', ''].map(h => (
              <p key={h} className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{h}</p>
            ))}
          </div>

          <div className="space-y-2">
            {values.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_5rem_7rem_6rem_2rem] gap-2 items-start">
                <input
                  value={l.description} onChange={e => updateLine(i, { description: e.target.value })}
                  placeholder="Spring cleanup — front & back"
                  aria-label={`Line ${i + 1} description`}
                  className="col-span-2 sm:col-span-1 h-10 bg-bg-tertiary border border-border-strong rounded-lg px-3 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                />
                <input
                  value={l.qty} onChange={e => updateLine(i, { qty: e.target.value })}
                  type="number" min="0" step="any" inputMode="decimal" placeholder="1"
                  aria-label={`Line ${i + 1} quantity`}
                  className="h-10 bg-bg-tertiary border border-border-strong rounded-lg px-3 text-sm text-ink tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                />
                <input
                  value={l.unit_price} onChange={e => updateLine(i, { unit_price: e.target.value })}
                  type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00"
                  aria-label={`Line ${i + 1} unit price`}
                  className="h-10 bg-bg-tertiary border border-border-strong rounded-lg px-3 text-sm text-ink tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                />
                <p className="h-10 flex items-center justify-end text-sm font-semibold text-ink tabular-nums px-1">
                  {formatCurrency(lineAmount(l))}
                </p>
                <button
                  type="button" onClick={() => removeLine(i)} aria-label={`Remove line ${i + 1}`}
                  className="h-10 w-8 flex items-center justify-center text-ink-faint hover:text-red-400 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          {validLines.length === 0 && (
            <InlineEmpty className="py-2">Add a description, quantity and unit price to start the invoice.</InlineEmpty>
          )}
        </CardBody>
      </Card>

      {/* Discount + totals — rendered by the SAME engine the PDF/portal use */}
      <Card>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Discount" value={values.discount_type}
              onChange={e => set('discount_type', e.target.value as DiscountType | '')}
              options={[
                { value: '', label: 'No discount' },
                { value: 'percent', label: 'Percentage (%)' },
                { value: 'amount', label: 'Fixed amount ($)' },
              ]}
            />
            {values.discount_type && (
              <Input
                label={values.discount_type === 'percent' ? 'Discount %' : 'Discount $'}
                type="number" min="0" step="0.01" inputMode="decimal"
                value={values.discount_value} onChange={e => set('discount_value', e.target.value)}
              />
            )}
          </div>

          <div className="rounded-xl border border-border bg-bg-tertiary/40 px-4 py-3 space-y-1.5">
            <Row label="Subtotal" value={formatCurrency(totals.subtotal)} />
            {totals.hasDiscount && (
              <Row label={`Discount${totals.discountLabel ? ` (${totals.discountLabel})` : ''}`}
                value={`− ${formatCurrency(totals.discountAmount)}`} tone="text-emerald-400" />
            )}
            {totals.hasGst
              ? <Row label={`GST (${totals.gstPercent}%)`} value={formatCurrency(totals.gstAmount)} />
              : <p className="text-[11px] text-ink-faint">No GST — set your GST % in Settings if you're registered.</p>}
            <div className="pt-1.5 border-t border-border flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Total</span>
              <span className="text-lg font-bold text-ink tabular-nums">{formatCurrency(totals.total)}</span>
            </div>
          </div>
          {gross !== net && (
            <p className="text-[11px] text-ink-faint">Stored as {formatCurrency(net)} net — the same way generated invoices record a discount.</p>
          )}
        </CardBody>
      </Card>

      {/* Terms + internal notes */}
      <Card>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Due date" type="date" value={values.due_date}
              onChange={e => set('due_date', e.target.value)}
              hint="Payment reminders use this date."
            />
            <Input
              label="Service summary (optional)" value={values.service_type}
              onChange={e => set('service_type', e.target.value)}
              placeholder="Spring cleanup"
              hint="Shown on lists and the portal. Defaults to your first line."
            />
          </div>
          <Textarea
            label="Internal notes" value={values.notes}
            onChange={e => set('notes', e.target.value)}
            placeholder="Only you see this — context for the office, not the customer."
          />
          <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
            <StickyNote className="w-3 h-3 shrink-0 mt-0.5" /> Internal notes stay on the invoice record and never appear on the customer's PDF or portal.
          </p>
        </CardBody>
      </Card>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <AutosaveStatus status={autosave.status} savedAt={autosave.savedAt} className="mr-auto" />
        <Button type="button" variant="ghost" onClick={previewPdf} loading={previewing} disabled={!canSave}
          title={!canSave ? 'Add a customer and a line item first' : 'Open the real invoice PDF'}>
          <Eye className="w-4 h-4" /> Preview PDF
        </Button>
        <Button type="button" variant="secondary" onClick={onSaveDraft} loading={saving === 'draft'} disabled={!canSave || !!saving}
          title={!canSave ? 'Add a customer and a line item first' : undefined}>
          <Save className="w-4 h-4" /> Save draft
        </Button>
        <Button type="button" onClick={onSaveAndSend} loading={saving === 'send'} disabled={!canSave || !!saving}
          title={!canSave ? 'Add a customer and a line item first' : undefined}>
          <Send className="w-4 h-4" /> Save &amp; send
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className={cn('tabular-nums', tone || 'text-ink')}>{value}</span>
    </div>
  )
}

/** An in-memory Invoice for the PDF preview — the same shape we persist. */
export function previewInvoice(v: InvoiceBuilderValues, customer: Customer | null, properties: Property[]): Invoice {
  const prop = properties.find(p => p.id === v.property_id) || null
  const lines = toLineItems(v.lines)
  return {
    id: 'preview', created_at: '', updated_at: '', user_id: '',
    quote_id: null, customer_id: customer?.id ?? null, property_id: v.property_id || null, job_id: null,
    invoice_number: 'DRAFT',
    customer_name: customer?.name ?? '',
    address: prop?.address ?? customer?.address ?? null,
    service_type: v.service_type.trim() || lines[0]?.description || 'Services rendered',
    amount: netOf(v.lines, v.discount_type, v.discount_value),
    status: 'draft',
    issued_date: localTodayISO(),
    due_date: v.due_date || null,
    notes: null, // internal notes never reach the customer's document
    line_items: lines,
    discount_type: v.discount_type || null,
    discount_value: v.discount_type ? num(v.discount_value) : null,
  }
}
