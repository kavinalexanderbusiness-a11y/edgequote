'use client'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { queueOrRun } from '@/lib/offline/outbox'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { Customer, CustomerFormValues } from '@/types'
import { CustomerList } from '@/components/customers/CustomerList'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { PropertySelect } from '@/components/ui/PropertySelect'
import { Modal } from '@/components/ui/Modal'
import { normalizeTags } from '@/lib/customers'
import { applyConsent } from '@/lib/consent'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { Avatar } from '@/components/ui/Avatar'
import { PageHeader } from '@/components/layout/PageHeader'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Plus, X, Upload, Archive, RotateCcw, Trash2, Home } from 'lucide-react'
import { scrollBehavior } from '@/lib/motion'

// Bound the archived DOM too — a long-lived company can accumulate hundreds of
// churned customers; render a page's worth and note the rest.
const ARCHIVED_RENDER_CAP = 50

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
  // The guided first-property step, opened right after creation (Customer V2).
  const [propertyStepFor, setPropertyStepFor] = useState<{ customer: Customer; wantSms: boolean; wantEmail: boolean } | null>(null)
  // Which customer's create-flow has already been finished — finishCreate's
  // idempotency key (state alone can't dedupe two calls in one tick).
  const createFinishedRef = useRef<string | null>(null)

  const supabase = useMemo(() => createClient(), [])

  async function fetchCustomers() {
    // Local session read — no auth round-trip before the RLS-scoped queries below.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    setUid(user.id)
    // Active (non-archived) customers only — archived ones are preserved but hidden.
    // The properties join feeds displayAddress: the address of record is the
    // primary PROPERTY; customers.address is only the legacy fallback (dual-read
    // until migration M4 drops it).
    const [activeRes, archRes] = await Promise.all([
      supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user.id).is('archived_at', null).order('name'),
      supabase.from('customers').select('*, properties(address, city, is_primary)').eq('user_id', user.id).not('archived_at', 'is', null).order('name'),
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
    // An explicit WHITELIST, not a spread (found in review): react-hook-form's
    // reset() keeps unregistered keys, so a pre-V2 autosave draft still carries
    // address/city/province/postal_code — a spread would silently write those
    // legacy columns back onto a "V2" customer, with no form field to see it.
    // Consent is likewise applied AFTER insert through the shared consent engine
    // (which writes the audit row); the customer is born with consent off.
    return {
      name: values.name,
      email: values.email,
      phone: values.phone,
      notes: values.notes,
      acquisition_source: values.acquisition_source || null,
      referred_by_customer_id: values.referred_by_customer_id || null,
      birthday: values.birthday || null,
      anniversary: values.anniversary || null,
      tags: normalizeTags(values.tags || []),
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

    // Customer V2: the relationship is saved — now guide straight into the FIRST
    // PROPERTY, because a customer without one can't be quoted, routed or priced.
    // The step is skippable (billing-only customers are real), and it goes through
    // PropertySelect → ensurePropertyForCustomer, the same find-or-create the
    // quote path uses — one way an address becomes a property. The introduction
    // message offer waits until this step closes so the owner isn't juggling
    // two dialogs.
    setPropertyStepFor({ customer: c, wantSms, wantEmail })
  }

  // The post-property half of creation: offer the introduction only when we can
  // actually reach them; otherwise say exactly how to enable messaging.
  // IDEMPOTENT by ref (found in review): an in-flight property save resolving
  // after Skip/Escape would call this a second time — re-opening the intro
  // dialog the owner may have already dismissed, or double-toasting.
  function finishCreate(c: Customer, wantSms: boolean, wantEmail: boolean) {
    if (createFinishedRef.current === c.id) return
    createFinishedRef.current = c.id
    setPropertyStepFor(null)
    const first = c.name.split(' ')[0] || 'Customer'
    if (wantSms || wantEmail) {
      setIntroFor({ ...c, sms_opt_in: wantSms, email_opt_in: wantEmail })
    } else if (c.phone || c.email) {
      toast(`${first} added. To message ${first}, turn on texts or email on their profile — you'll confirm consent there.`, { duration: 7000 })
    } else {
      toast.success(`${first} added.`)
    }
  }

  // Editing a customer queues offline, through the SAME customer.update handler the
  // profile's notes/prefs editors already use — a gate code or a corrected phone
  // number gets fixed standing at the door, not remembered until there's signal.
  // Both writes go in ONE op so the replay is the whole mutation, never half of it.
  async function handleEdit(values: CustomerFormValues) {
    if (!editing) return
    const id = editing.id
    const patch = normalize(values)
    // Customer V2: this form edits the RELATIONSHIP only. Addresses are edited on
    // the property itself (customer profile → property row, or the property page),
    // so an address change can never half-apply across two tables again.
    let outcome: 'ran' | 'queued'
    try {
      outcome = await queueOrRun(
        { kind: 'customer.update', payload: { id, patch, baseUpdatedAt: editing.updated_at }, label: `Edit · ${editing.name}` },
        async () => {
          const { error } = await supabase.from('customers').update(patch).eq('id', id)
          if (error) throw new Error(error.message)
        },
      )
    } catch (e) {
      toast.error('Could not save the customer: ' + (e instanceof Error ? e.message : 'please try again.'))
      return   // keep the form open to retry
    }
    // Paint the edit immediately either way — queued work is real work.
    setCustomers(prev => prev.map(c => (c.id === id ? { ...c, ...(patch as Partial<Customer>) } : c)))
    setEditing(null)
    if (outcome === 'queued') toast('Saved offline — it’ll sync when you’re back in signal.')
    else await fetchCustomers()
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

  // The add/edit form renders inline at the top of the page. Editing from a row
  // deep in a long list would otherwise open it off-screen — bring it into view.
  function scrollToTop() {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: scrollBehavior() })
  }
  function openAdd() { setEditing(null); setShowForm(true); scrollToTop() }
  function openEdit(c: Customer) { setEditing(c); setShowForm(false); scrollToTop() }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Customers"
        description={`${customers.length.toLocaleString()} customer${customers.length !== 1 ? 's' : ''} in your database`}
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/customers/import"
              className="inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 bg-surface border border-border-strong text-ink hover:bg-surface-raised active:scale-[0.98] px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
              <Upload className="w-4 h-4" /> Import
            </Link>
            <Button onClick={openAdd}>
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
                notes: editing.notes || '',
                acquisition_source: editing.acquisition_source || '',
                referred_by_customer_id: editing.referred_by_customer_id || '',
                birthday: editing.birthday || '',
                anniversary: editing.anniversary || '',
                tags: editing.tags || [],
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
          onEdit={openEdit}
          onDelete={handleDelete}
          onRefresh={fetchCustomers}
          onAdd={openAdd}
        />
      )}

      {/* Archived customers — fully preserved, restorable any time */}
      {!loading && archived.length > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <button onClick={() => setShowArchived(s => !s)} className="text-sm font-medium text-ink-muted hover:text-ink flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <Archive className="w-4 h-4" /> {showArchived ? 'Hide' : 'Show'} archived ({archived.length.toLocaleString()})
          </button>
          {showArchived && (
            <div className="mt-3 divide-y divide-border">
              {archived.slice(0, ARCHIVED_RENDER_CAP).map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={c.name} seed={c.id} size="sm" className="opacity-60" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{c.name}</p>
                      <p className="text-[11px] text-ink-faint">Archived{c.archived_at ? ` ${new Date(c.archived_at).toLocaleDateString()}` : ''} · all history preserved</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="secondary" onClick={() => handleRestore(c.id)}><RotateCcw className="w-3.5 h-3.5" /> Restore</Button>
                    <Button size="sm" variant="danger" onClick={() => handleDeletePermanently(c.id)}><Trash2 className="w-3.5 h-3.5" /> Delete permanently</Button>
                  </div>
                </div>
              ))}
              {archived.length > ARCHIVED_RENDER_CAP && (
                <p className="text-[11px] text-ink-faint pt-2">…and {(archived.length - ARCHIVED_RENDER_CAP).toLocaleString()} more archived</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* The guided first-property step (Customer V2): the relationship is saved,
          now capture WHERE the work happens. Skippable — a billing-only customer
          is legitimate — and every close path funnels through finishCreate so the
          introduction offer is never lost behind this dialog. */}
      {propertyStepFor && (
        <Modal
          open
          onClose={() => finishCreate(propertyStepFor.customer, propertyStepFor.wantSms, propertyStepFor.wantEmail)}
          title={`Where do we work for ${propertyStepFor.customer.name.split(' ')[0]}?`}
          icon={Home}
          footer={
            <Button variant="ghost" type="button"
              onClick={() => finishCreate(propertyStepFor.customer, propertyStepFor.wantSms, propertyStepFor.wantEmail)}>
              Skip for now
            </Button>
          }
        >
          <p className="text-sm text-ink-muted mb-3">
            Add their first property — it&rsquo;s what quotes, visits and routing attach to. You can add more (or none) any time.
          </p>
          <PropertySelect
            properties={[]}
            value=""
            onChange={() => {}}
            customerId={propertyStepFor.customer.id}
            onCreated={p => {
              toast.success(`${p.address} added.`)
              fetchCustomers()
              finishCreate(propertyStepFor.customer, propertyStepFor.wantSms, propertyStepFor.wantEmail)
            }}
            label="Property address"
            hint="Type the address — it’s created as their primary property."
            autoFocus
          />
        </Modal>
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