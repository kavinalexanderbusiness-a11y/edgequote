'use client'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { Customer, CustomerFormValues } from '@/types'
import { CustomerList } from '@/components/customers/CustomerList'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { applyConsent } from '@/lib/consent'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { PageHeader } from '@/components/layout/PageHeader'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Plus, X, Upload, Archive, RotateCcw, Trash2 } from 'lucide-react'

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [archived, setArchived] = useState<Customer[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [uid, setUid] = useState<string | null>(null)
  // Just-created customer with contact info → offer the introduction right away
  // (THE shared Send-Message dialog, preselected — one tap to send or cancel).
  const [introFor, setIntroFor] = useState<Customer | null>(null)

  const supabase = useMemo(() => createClient(), [])

  async function fetchCustomers() {
    // Local session read — no auth round-trip before the RLS-scoped queries below.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    setUid(user.id)
    // Active (non-archived) customers only — archived ones are preserved but hidden.
    const [activeRes, archRes] = await Promise.all([
      supabase.from('customers').select('*').eq('user_id', user.id).is('archived_at', null).order('name'),
      supabase.from('customers').select('*').eq('user_id', user.id).not('archived_at', 'is', null).order('name'),
    ])
    setCustomers(activeRes.data || [])
    setArchived(archRes.data || [])
    // Cache only the first screenful for an instant revisit paint — never serialize
    // thousands of customer rows into sessionStorage. The full list follows immediately.
    writeCache('customers-list', (activeRes.data || []).slice(0, 100))
    setLoading(false)
  }

  // Instant revisit: paint the cached active list immediately (no skeleton), then
  // revalidate in the background — realtime keeps it live. Reuses the shared clientCache.
  useEffect(() => {
    const cached = readCache<Customer[]>('customers-list', CACHE_TTL.short)
    if (cached) { setCustomers(cached); setLoading(false) }
    fetchCustomers()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Command-palette "New Customer" deep-links here with ?new=1 → open the form.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1') {
      setShowForm(true); setEditing(null)
      window.history.replaceState({}, '', '/dashboard/customers')
    }
  }, [])

  // Live: new/edited/deleted customers (import, API, another device) appear instantly.
  useRealtimeRefresh('customers', uid ? `user_id=eq.${uid}` : null, fetchCustomers)

  function normalize(values: CustomerFormValues) {
    // Consent is applied AFTER insert through the shared consent engine (which
    // writes the audit row) — keep it OUT of the raw insert so nothing bypasses
    // that trail. The customer is born with consent off (DB default).
    const rest = { ...values }
    delete rest.sms_opt_in
    delete rest.email_opt_in
    return {
      ...rest,
      acquisition_source: values.acquisition_source || null,
      referred_by_customer_id: values.referred_by_customer_id || null,
      birthday: values.birthday || null,
      anniversary: values.anniversary || null,
    }
  }

  async function handleAdd(values: CustomerFormValues) {
    const { data: { user } } = await supabase.auth.getUser()

    // Insert customer
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({ ...normalize(values), user_id: user!.id })
      .select()
      .single()

    if (error || !newCustomer) {
      toast.error('Could not create the customer: ' + (error?.message ?? 'please try again.'))
      return
    }
    const c = newCustomer as Customer

    // Auto-create a primary property from the customer's address
    if (values.address) {
      await supabase.from('properties').insert({
        customer_id: c.id,
        user_id: user!.id,
        address: values.address,
        city: values.city || null,
        province: values.province || 'AB',
        postal_code: values.postal_code || null,
        is_primary: true,
      })
    }

    // Persist the consent captured on the form through the shared engine (writes
    // the audit trail) — only for a channel that actually has a contact method.
    const wantSms = !!values.sms_opt_in && !!c.phone
    const wantEmail = !!values.email_opt_in && !!c.email
    if (wantSms || wantEmail) {
      const targets = [{ id: c.id, sms_opt_in: false, email_opt_in: false }]
      const by = user!.email || user!.id
      if (wantSms) await applyConsent(supabase, { targets, channel: 'sms', value: true, userId: user!.id, changedBy: by, source: 'single' })
      if (wantEmail) await applyConsent(supabase, { targets, channel: 'email', value: true, userId: user!.id, changedBy: by, source: 'single' })
    }

    await fetchCustomers()
    setShowForm(false)

    // Guide, never silently create: only offer the introduction when we can
    // actually reach them; otherwise say exactly how to enable messaging.
    const first = c.name.split(' ')[0] || 'Customer'
    if (wantSms || wantEmail) {
      setIntroFor({ ...c, sms_opt_in: wantSms, email_opt_in: wantEmail })
    } else if (c.phone || c.email) {
      toast(`${first} added. To message ${first}, turn on texts or email on their profile — you'll confirm consent there.`, { duration: 7000 })
    } else {
      toast.success(`${first} added.`)
    }
  }

  async function handleEdit(values: CustomerFormValues) {
    if (!editing) return
    const { error } = await supabase.from('customers').update(normalize(values)).eq('id', editing.id)
    if (error) { toast.error('Could not save the customer: ' + error.message); return }   // keep the form open to retry

    // If address changed, update the primary property address too
    if (values.address) {
      await supabase
        .from('properties')
        .update({
          address: values.address,
          city: values.city || null,
          province: values.province || 'AB',
          postal_code: values.postal_code || null,
        })
        .eq('customer_id', editing.id)
        .eq('is_primary', true)
    }

    await fetchCustomers()
    setEditing(null)
  }

  // Delete from the active list ALWAYS archives (one rule, no branches): everything
  // is preserved, one click can never wipe history, and Undo restores instantly.
  // The only true permanent delete lives INSIDE the Archived list (below) — nowhere else.
  async function handleDelete(id: string) {
    const name = customers.find(c => c.id === id)?.name || 'Customer'
    const { error } = await supabase.from('customers').update({ archived_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error('Could not archive the customer: ' + error.message); return }
    await fetchCustomers()
    toast.undo(`Archived ${name} — everything preserved`, async () => {
      await supabase.from('customers').update({ archived_at: null }).eq('id', id); await fetchCustomers()
    })
  }

  async function handleRestore(id: string) {
    const { error } = await supabase.from('customers').update({ archived_at: null }).eq('id', id)
    if (error) { toast.error('Could not restore the customer: ' + error.message); return }
    await fetchCustomers()
  }

  // Permanent delete — offered ONLY inside the Archived list. It's the one truly
  // irreversible action, so it keeps an explicit confirm (the deliberate escape hatch
  // from the safe archive-by-default). Past quotes/invoices/jobs are preserved but
  // unlinked (their customer_id FKs are set null).
  async function handleDeletePermanently(id: string) {
    const name = archived.find(c => c.id === id)?.name || 'this customer'
    const ok = await confirmDialog({
      title: `Permanently delete ${name}?`,
      message: 'The customer record is removed for good. Their past quotes, invoices and jobs are kept but will no longer be linked to a customer. This cannot be undone.',
      confirmLabel: 'Delete permanently', destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('customers').delete().eq('id', id)
    if (error) { toast.error('Could not delete: ' + error.message); return }
    await fetchCustomers()
    toast.success(`${name} permanently deleted.`)
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Customers"
        description={`${customers.length} customer${customers.length !== 1 ? 's' : ''} in your database`}
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/customers/import"
              className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-surface border border-border-strong text-ink hover:bg-surface-raised active:scale-[0.98] px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <Upload className="w-4 h-4" /> Import
            </Link>
            <Button onClick={() => { setShowForm(true); setEditing(null) }}>
              <Plus className="w-4 h-4" /> Add customer
            </Button>
          </div>
        }
      />

      {(showForm || editing) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              {editing ? 'Edit Customer' : 'New Customer'}
            </h2>
            <button
              onClick={() => { setShowForm(false); setEditing(null) }}
              aria-label="Close form"
              className="h-7 w-7 rounded-lg flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="w-4 h-4" />
            </button>
          </CardHeader>
          <CardBody>
            <CustomerForm
              customers={editing ? customers.filter(c => c.id !== editing.id) : customers}
              defaultValues={editing ? {
                name: editing.name || '',
                email: editing.email || '',
                phone: editing.phone || '',
                address: editing.address || '',
                city: editing.city || '',
                province: editing.province || '',
                postal_code: editing.postal_code || '',
                notes: editing.notes || '',
                acquisition_source: editing.acquisition_source || '',
                referred_by_customer_id: editing.referred_by_customer_id || '',
                birthday: editing.birthday || '',
                anniversary: editing.anniversary || '',
              } : undefined}
              onSubmit={editing ? handleEdit : handleAdd}
              onCancel={() => { setShowForm(false); setEditing(null) }}
              isEdit={!!editing}
              autosaveKey={editing ? `customer:${editing.id}` : 'customer:new'}
            />
          </CardBody>
        </Card>
      )}

      {loading ? (
        <SkeletonRows count={6} />
      ) : (
        <CustomerList
          customers={customers}
          onEdit={c => { setEditing(c); setShowForm(false) }}
          onDelete={handleDelete}
          onRefresh={fetchCustomers}
          onAdd={() => { setShowForm(true); setEditing(null) }}
        />
      )}

      {/* Archived customers — fully preserved, restorable any time */}
      {!loading && archived.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <button onClick={() => setShowArchived(s => !s)} className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Archive className="w-4 h-4" /> {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="mt-3 divide-y divide-border">
              {archived.map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{c.name}</p>
                    <p className="text-[11px] text-ink-faint">Archived{c.archived_at ? ` ${new Date(c.archived_at).toLocaleDateString()}` : ''} · all history preserved</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="secondary" onClick={() => handleRestore(c.id)}><RotateCcw className="w-3.5 h-3.5" /> Restore</Button>
                    <Button size="sm" variant="danger" onClick={() => handleDeletePermanently(c.id)}><Trash2 className="w-3.5 h-3.5" /> Delete permanently</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Just added a reachable customer → one-tap introduction. The composer shows
          the exact message that will be sent (editable); channel(s) reflect the
          consent just captured. */}
      {introFor && (
        <SendMessageDialog
          open
          recipients={[{ customerId: introFor.id, name: introFor.name, phone: introFor.phone }]}
          defaultTemplate="introduction"
          title={`Introduce your business to ${introFor.name.split(' ')[0]}`}
          onClose={() => setIntroFor(null)}
        />
      )}
    </div>
  )
}