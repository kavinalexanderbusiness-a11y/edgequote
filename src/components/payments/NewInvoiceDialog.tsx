'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { PropertySelect } from '@/components/ui/PropertySelect'
import { toast } from '@/lib/toast'
import { localTodayISO } from '@/lib/utils'
import { nextInvoiceNumber } from '@/lib/invoicing'
import type { Customer, Property } from '@/types'
import { ReceiptText } from 'lucide-react'

// ── Manual invoice creation ──────────────────────────────────────────────────
// Bills work that never came from a job: mints an EMPTY draft against a real
// customer, then hands straight off to the existing DraftInvoiceEditor for line
// items, discount and notes. Deliberately does NOT re-implement any of that —
// the draft editor, the totals engine, the PDF, the ledger, the reminder cron and
// the send pipeline all already work on a draft invoice; the only thing missing
// was a way to make one that isn't tied to a job.
//
// customer_id is the whole point of the picker: it's what puts the invoice on the
// customer's profile timeline, lets the reminder cron reach them, and makes the
// portal show it. A typed-in name alone would produce an orphan document.

const DUE_DAYS = 14

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function NewInvoiceDialog({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  /** Fires with the new invoice id so the page can open its draft editor. */
  onCreated: (invoiceId: string) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [customerId, setCustomerId] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [service, setService] = useState('')
  const [due, setDue] = useState(() => addDaysISO(localTodayISO(), DUE_DAYS))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const { data } = await supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', uid).is('archived_at', null).order('name')
      setCustomers((data as Customer[]) || [])
    })()
  }, [open, supabase])

  // Properties are per-customer and optional — an invoice can be for the person,
  // not a specific address.
  useEffect(() => {
    if (!customerId) { setProperties([]); setPropertyId(''); return }
    ;(async () => {
      const { data } = await supabase.from('properties').select('*').eq('customer_id', customerId).order('is_primary', { ascending: false })
      const list = (data as Property[]) || []
      setProperties(list)
      setPropertyId(list.find(p => p.is_primary)?.id || '')
    })()
  }, [customerId, supabase])

  async function create() {
    const customer = customers.find(c => c.id === customerId)
    if (!customer) { setError('Choose the customer this invoice is for.'); return }
    setSaving(true); setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in.')
      const property = properties.find(p => p.id === propertyId) || null
      const today = localTodayISO()
      // ONE numbering engine — shared with the auto-draft and quote conversion, so
      // a manual invoice can never collide with a generated one.
      const invoice_number = await nextInvoiceNumber(supabase, user.id)

      const { data, error: err } = await supabase.from('invoices').insert({
        user_id: user.id,
        customer_id: customer.id,
        property_id: property?.id ?? null,
        job_id: null,          // the point of this dialog: an invoice with no job
        quote_id: null,
        invoice_number,
        customer_name: customer.name,
        address: property?.address ?? customer.address ?? null,
        service_type: service.trim() || null,
        amount: 0,             // the draft editor sets the real figure from the lines
        // Seed ONE empty line. The draft editor shows its itemised UI only when a
        // draft already has lines (line_items.length > 0) — an empty array opened
        // the editor on the single "Amount" box instead, hiding the qty/unit-price
        // rows that are the whole reason to bill manually behind an "+ Add line
        // item" link. A manual invoice starts as a line item, because it is one.
        // Seeded WITH a description, matching the editor's own "+ Add line item"
        // fallback: the editor drops blank-description lines on save, so a blank
        // seed is a trapdoor — you price it, and the line disappears.
        line_items: [{ description: service.trim() || 'Service', amount: 0, kind: 'service' }],
        status: 'draft',
        issued_date: today,
        due_date: due || null,
      }).select('id').single()

      if (err || !data) throw new Error(err?.message || 'Could not create the invoice.')
      toast.success(`Draft ${invoice_number} created — add the line items.`)
      onCreated((data as { id: string }).id)
      // Reset so the next open starts clean.
      setCustomerId(''); setPropertyId(''); setService(''); setDue(addDaysISO(localTodayISO(), DUE_DAYS))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invoice.')
    } finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={() => !saving && onClose()} title="New invoice" icon={ReceiptText} size="md" onSubmit={() => !saving && create()}>
      <div className="space-y-4">
        <CustomerPicker
          label="Customer *"
          customers={customers}
          value={customerId}
          onChange={setCustomerId}
          allowManual={false}
          hint="The invoice lands on their profile, portal and reminder schedule."
        />

        {/* THE shared property picker. This was a hand-built <Select> that had already
            drifted from JobForm's copy of the same idea (" · primary" here vs
            " (primary)" there) — and a <select> of every address stops working the
            moment a landlord shows up. Adding inline means a new address can be billed
            without abandoning the invoice. */}
        {customerId && (
          <PropertySelect
            label="Property"
            properties={properties}
            value={propertyId}
            onChange={setPropertyId}
            customerId={customerId}
            onCreated={p => setProperties(prev => [...prev, p])}
            allowNone
            noneLabel="No specific property"
            hint="Optional — leave blank to bill the customer, not a specific address."
          />
        )}

        <Input label="Service" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Spring cleanup" hint="Optional — shown on the invoice." />
        <Input label="Due date" type="date" value={due} onChange={e => setDue(e.target.value)} hint={`Defaults to ${DUE_DAYS} days out. Reminders chase from this date.`} />

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={create} loading={saving} disabled={!customerId}>Create draft</Button>
        </div>
      </div>
    </Modal>
  )
}
