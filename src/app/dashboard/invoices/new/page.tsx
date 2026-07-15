'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Customer, Property, BusinessSettings, Invoice } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { formatCurrency, localTodayISO, maxNumericSuffix } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  InvoiceBuilder, blankInvoiceValues, toLineItems, netOf, type InvoiceBuilderValues,
} from '@/components/invoices/InvoiceBuilder'

// Manual invoice creation — bill a customer with no job behind it. The row we
// insert is the SAME shape the automatic invoice writers produce (quote→invoice,
// job completion), so payments, the ledger, reminders, the portal, AutoPay, the
// PDF and the customer timeline all pick it up with no special-casing.
export default function NewInvoicePage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [values, setValues] = useState<InvoiceBuilderValues>(blankInvoiceValues())
  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  // Just-created invoice awaiting its send — opens THE shared message dialog.
  const [sendFor, setSendFor] = useState<Invoice | null>(null)

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoading(false); return }
      const [cRes, pRes, sRes] = await Promise.all([
        supabase.from('customers').select('*').eq('user_id', user.id).is('archived_at', null).order('name'),
        supabase.from('properties').select('*').eq('user_id', user.id).order('address'),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      ])
      setCustomers((cRes.data as Customer[]) || [])
      setProperties((pRes.data as Property[]) || [])
      setSettings(sRes.data as BusinessSettings | null)
      setLoading(false)
    })()
  }, [supabase])

  // Deep link: /dashboard/invoices/new?customer=<id> preselects who to bill.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const c = new URLSearchParams(window.location.search).get('customer')
    if (c) setValues(v => ({ ...v, customer_id: c }))
  }, [])

  async function create(status: 'draft' | 'unpaid'): Promise<Invoice | null> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { toast.error('Session expired — sign in again.'); return null }
    const customer = customers.find(c => c.id === values.customer_id)
    if (!customer) { toast.error('Pick the customer to bill.'); return null }
    const lines = toLineItems(values.lines)
    if (!lines.length) { toast.error('Add at least one line item.'); return null }

    // Sequential INV-#### from the current max — the same numbering rule the
    // quote→invoice converter uses, so manual and generated invoices interleave.
    const { data: nums } = await supabase.from('invoices').select('invoice_number').eq('user_id', user.id)
    const next = maxNumericSuffix(((nums as { invoice_number: string }[]) || []).map(n => n.invoice_number)) + 1
    const prop = properties.find(p => p.id === values.property_id) || null

    const { data, error } = await supabase.from('invoices').insert({
      user_id: user.id,
      quote_id: null, job_id: null,
      customer_id: customer.id,
      property_id: values.property_id || null,
      invoice_number: `INV-${String(next).padStart(4, '0')}`,
      customer_name: customer.name,
      address: prop?.address ?? customer.address ?? null,
      service_type: values.service_type.trim() || lines[0].description,
      // `amount` is ALWAYS the net (post-discount) subtotal — the invariant every
      // engine relies on; the discount fields record how that net was reached.
      amount: netOf(values.lines, values.discount_type, values.discount_value),
      discount_type: values.discount_type || null,
      discount_value: values.discount_type ? Number(values.discount_value) || null : null,
      line_items: lines,
      status,
      issued_date: localTodayISO(),
      due_date: values.due_date || null,
      notes: values.notes.trim() || null,
    }).select().single()

    if (error || !data) { toast.error('Could not create the invoice: ' + (error?.message ?? 'please try again.')); return null }
    try { window.localStorage.removeItem('eq-autosave-invoice:new') } catch { /* ignore */ }
    return data as Invoice
  }

  async function saveDraft() {
    setSaving('draft')
    const inv = await create('draft')
    setSaving(null)
    if (!inv) return
    toast.success(`${inv.invoice_number} saved as a draft.`)
    router.push('/dashboard/invoices')
  }

  async function saveAndSend() {
    setSaving('send')
    const inv = await create('unpaid')
    setSaving(null)
    if (!inv) return
    setSendFor(inv)   // THE shared send dialog; marking sent happens on success
  }

  // Sending marks it Sent — the same transition the Invoices list performs.
  async function markSent(inv: Invoice) {
    await supabase.from('invoices').update({ status: 'sent' }).eq('id', inv.id)
  }

  if (loading) return <div className="max-w-3xl mx-auto space-y-6"><SkeletonRows count={6} /></div>

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader
        crumb={{ label: 'Invoices', href: '/dashboard/invoices' }}
        title="New invoice"
        description="Bill a customer directly — no job required. Payments, reminders and the portal work exactly as they do for generated invoices."
      />

      <InvoiceBuilder
        values={values} onChange={setValues}
        customers={customers} properties={properties} settings={settings}
        onSaveDraft={saveDraft} onSaveAndSend={saveAndSend} saving={saving}
      />

      {/* One-tap send through THE shared dialog (opt-in gated, threaded, logged). */}
      {sendFor?.customer_id && (
        <SendMessageDialog
          open
          customerId={sendFor.customer_id}
          customerName={sendFor.customer_name}
          defaultTemplate="invoice"
          vars={{ amount: formatCurrency(invoiceTotals(sendFor.amount, settings, { type: sendFor.discount_type, value: sendFor.discount_value }).total) }}
          onSent={() => markSent(sendFor)}
          onClose={() => { setSendFor(null); toast.success(`${sendFor.invoice_number} created.`); router.push('/dashboard/invoices') }}
        />
      )}
    </div>
  )
}
